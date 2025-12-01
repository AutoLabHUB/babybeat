// babybeat-core.js
// Core audio engine for BabyBeat
// export async function initBabyBeat(opts)
// Returns:
// {
//   start, stop,
//   toggleMonitor,
//   startRecording, stopRecording,
//   setFilterHz, setSensitivity, setMonitorVol
// }

export async function initBabyBeat (opts = {}) {
  const els = mapSelectors(opts.elements || {});
  const licenseOk = await (opts.licenseValidator?.() ?? true);
  if (!licenseOk) throw new Error('License check failed');

  const aiConfig = opts.ai || { enabled: false, endpoint: null };

  // -------- Tunables ----------
  const MIN_FETAL_BPM = 100;
  const MAX_FETAL_BPM = 170;
  const MIN_INTERVAL_MS = 300;   // 200 bpm
  const MAX_INTERVAL_MS = 1200;  // 50 bpm
  const REFRACTORY_MS   = 260;   // avoid double-counting
  const ENV_ALPHA       = 0.15;  // envelope smoothing
  const LEVEL_ALPHA     = 0.01;  // slow baseline
  const BPM_ALPHA       = 0.15;  // display smoothing
  const GATE_FLOOR      = 0.001; // noise floor baseline
  const GATE_MULT       = 3.0;   // threshold multiple over baseline
  const MAX_MONITOR_GAIN = 0.7;  // absolute monitor safety cap

  // -------- State ----------
  let audioCtx = null;
  let mediaStream = null;
  let sourceNode = null;
  let hp = null, bp = null, lp = null;  // filters
  let analyser = null;
  let monitorGain = null;
  let recDestination = null;
  let mediaRecorder = null;
  let recChunks = [];
  let processor = null;

  let running = false;
  let monitorOn = false;
  let recording = false;

  let env = 0;
  let baseline = GATE_FLOOR;
  let lastBeatTime = 0;
  let bpmDisplay = 0;
  let beatIntervals = [];

  let channelMode = 'mix'; // 'left' | 'right' | 'mix'
  let sensitivity = 7;     // 1–10
  let filterCentreHz = 80; // band-pass centre
  let waveformHistory = new Float32Array(1024);
  let waveIndex = 0;

  let rafId = 0;

  // -------- Helpers ----------
  function mapSelectors(map) {
    const out = {};
    for (const k of Object.keys(map)) {
      const sel = map[k];
      out[k] = typeof sel === 'string' ? document.querySelector(sel) : sel;
    }
    return out;
  }

  function setStatus(msg) {
    if (els.status) els.status.textContent = msg;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function median(arr) {
    if (!arr.length) return 0;
    const a = [...arr].sort((a,b) => a - b);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m-1] + a[m]) / 2;
  }

  function ema(prev, value, alpha) {
    return prev + alpha * (value - prev);
  }

  function setButtonsForState() {
    if (!els.start || !els.stop) return;
    els.start.disabled = running;
    els.stop.disabled = !running;
    if (els.monitor) els.monitor.disabled = !running;
    if (els.playEnhanced) els.playEnhanced.disabled = !running;
    if (els.record) els.record.disabled = !running;
  }

  function updateMonitorLabel() {
    if (!els.monitor) return;
    els.monitor.textContent = monitorOn ? 'Monitor: On' : 'Monitor: Off';
  }

  function updateSensitivityUI() {
    if (els.sensitivityValue) els.sensitivityValue.textContent = String(sensitivity);
  }

  function updateFilterUI() {
    if (els.filterValue) els.filterValue.textContent = `${Math.round(filterCentreHz)} Hz`;
  }

  function updateMonitorVolUI() {
    if (!els.monitorVol) return;
    const vol = Number(els.monitorVol.value || 0);
    if (els.monitorVolValue) els.monitorVolValue.textContent = `${vol}%`;
  }

  function chooseChannelModeFromMicType() {
    if (!els.micType) return;
    const v = els.micType.value;
    // Rough heuristic for DJI mics: use right channel,
    // smartphone: mix, pro/stethoscope: left (often used as main).
    if (v === 'dji-mic-mini') channelMode = 'right';
    else if (v === 'professional' || v === 'stethoscope') channelMode = 'left';
    else channelMode = 'mix';
  }

  if (els.micType) {
    els.micType.addEventListener('change', chooseChannelModeFromMicType);
    chooseChannelModeFromMicType();
  }

  if (els.sensitivity) {
    els.sensitivity.addEventListener('input', () => {
      sensitivity = Number(els.sensitivity.value || 7);
      updateSensitivityUI();
    });
    sensitivity = Number(els.sensitivity.value || 7);
    updateSensitivityUI();
  }

  if (els.filterFreq) {
    els.filterFreq.addEventListener('input', () => {
      filterCentreHz = Number(els.filterFreq.value || 80);
      updateFilterUI();
      if (bp) bp.frequency.value = filterCentreHz;
    });
    filterCentreHz = Number(els.filterFreq.value || 80);
    updateFilterUI();
  }

  if (els.monitorVol) {
    els.monitorVol.addEventListener('input', () => {
      updateMonitorVolUI();
      applyMonitorVolume();
    });
    updateMonitorVolUI();
  }

  // -------- Audio graph ----------
  async function ensureContextAndStream() {
    if (audioCtx && mediaStream) return;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive',
    });

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false, // we run our own simple chain
        autoGainControl: false,
        channelCount: 2
      }
    });

    sourceNode = audioCtx.createMediaStreamSource(mediaStream);

    hp = audioCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 20;

    bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = filterCentreHz;
    bp.Q.value = 1.4; // broad-ish band

    lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;

    // Gentle dynamics (RNNoise-like chain in spirit: gate + EQ)
    const gainPre = audioCtx.createGain();
    gainPre.gain.value = 1.0;

    monitorGain = audioCtx.createGain();
    monitorGain.gain.value = 0.0; // muted until monitorOn

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.8;

    recDestination = audioCtx.createMediaStreamDestination();

    // Connect graph:
    // stream -> gainPre -> hp -> bp -> lp -> analyser -> monitorGain -> destination
    //                                        \-> recDestination
    sourceNode.connect(gainPre);
    gainPre.connect(hp);
    hp.connect(bp);
    bp.connect(lp);
    lp.connect(analyser);
    lp.connect(recDestination);
    analyser.connect(monitorGain);
    monitorGain.connect(audioCtx.destination);

    // Processor for heartbeat detection
    const bufferSize = 1024;
    processor = audioCtx.createScriptProcessor(bufferSize, 2, 1);
    lp.connect(processor);
    processor.connect(audioCtx.destination); // silent (we don't use output channel)

    processor.onaudioprocess = onAudioProcess;
  }

  function applyMonitorVolume() {
    if (!monitorGain || !els.monitorVol) return;
    const volPercent = Number(els.monitorVol.value || 0);
    const linear = clamp(volPercent / 100, 0, 1) * MAX_MONITOR_GAIN;
    monitorGain.gain.value = monitorOn ? linear : 0;
  }

  function onAudioProcess(e) {
    const input = e.inputBuffer;
    const n = input.length;
    if (!n) return;

    let channelData;
    if (channelMode === 'left' || input.numberOfChannels === 1) {
      channelData = input.getChannelData(0);
    } else if (channelMode === 'right' && input.numberOfChannels > 1) {
      channelData = input.getChannelData(1);
    } else {
      // mix down all channels
      const tmp = new Float32Array(n);
      for (let ch = 0; ch < input.numberOfChannels; ch++) {
        const d = input.getChannelData(ch);
        for (let i = 0; i < n; i++) tmp[i] += d[i];
      }
      for (let i = 0; i < n; i++) tmp[i] /= input.numberOfChannels;
      channelData = tmp;
    }

    const nowMs = audioCtx.currentTime * 1000;

    for (let i = 0; i < n; i++) {
      let sample = channelData[i];

      // basic pre-scaling via sensitivity
      sample *= 0.3 + (sensitivity / 10) * 1.2;

      const mag = Math.abs(sample);
      env = ema(env, mag, ENV_ALPHA);
      baseline = ema(baseline, mag, LEVEL_ALPHA);

      const gateThresh = Math.max(GATE_FLOOR, baseline * GATE_MULT);
      const gated = env > gateThresh ? env - gateThresh : 0;

      // record into waveform history (for drawing)
      waveformHistory[waveIndex] = gated;
      waveIndex = (waveIndex + 1) % waveformHistory.length;

      // Beat detection: detect upward crossings of threshold
      const dt = nowMs - lastBeatTime;
      const candidate = gated > 0.6 * (baseline + gateThresh);
      if (candidate && dt > REFRACTORY_MS && dt > MIN_INTERVAL_MS) {
        // register beat
        if (lastBeatTime > 0) {
          const interval = dt;
          if (interval >= MIN_INTERVAL_MS && interval <= MAX_INTERVAL_MS) {
            beatIntervals.push(interval);
            if (beatIntervals.length > 12) beatIntervals.shift();
            const medInt = median(beatIntervals.slice(-8));
            if (medInt > 0) {
              let rawBpm = 60000 / medInt;
              rawBpm = clamp(rawBpm, MIN_FETAL_BPM, MAX_FETAL_BPM);
              bpmDisplay = ema(bpmDisplay || rawBpm, rawBpm, BPM_ALPHA);
            }
          }
        }
        lastBeatTime = nowMs;
        pulseBeat();
      }
    }

    updateBpmUI();
  }

  function updateBpmUI() {
    if (!els.bpm) return;
    if (!bpmDisplay || !isFinite(bpmDisplay)) {
      els.bpm.textContent = '-- BPM';
      return;
    }
    els.bpm.textContent = `${Math.round(bpmDisplay)} BPM`;
  }

  function pulseBeat() {
    if (!els.pulse) return;
    els.pulse.classList.add('active');
    setTimeout(() => els.pulse && els.pulse.classList.remove('active'), 180);
  }

  // -------- Waveform drawing ----------
  function startVisualizer() {
    if (!els.waveform) return;
    const canvas = els.waveform;
    const ctx = canvas.getContext('2d');

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 1;
      const h = canvas.clientHeight || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    function draw() {
      if (!running) { rafId = requestAnimationFrame(draw); return; }
      const w = canvas.clientWidth || 1;
      const h = canvas.clientHeight || 1;
      ctx.clearRect(0, 0, w, h);

      // subtle grid
      ctx.globalAlpha = 0.2;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < w; x += 24) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      for (let y = 0; y < h; y += 24) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();

      // waveform line
      ctx.globalAlpha = 1;
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#f87171');
      grad.addColorStop(0.5, '#fb923c');
      grad.addColorStop(1, '#caff00');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.beginPath();

      const len = waveformHistory.length;
      const mid = h / 2;
      for (let i = 0; i < len; i++) {
        const idx = (waveIndex + i) % len;
        const v = waveformHistory[idx] || 0;
        const x = (i / (len - 1)) * w;
        const y = mid - v * (h * 0.8);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      rafId = requestAnimationFrame(draw);
    }
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(draw);
  }

  // -------- Recording ----------
  function setupRecorder() {
    if (!recDestination) return;
    mediaRecorder = new MediaRecorder(recDestination.stream, {
      mimeType: 'audio/webm;codecs=opus'
    });
    mediaRecorder.ondataavailable = (evt) => {
      if (evt.data && evt.data.size > 0) {
        recChunks.push(evt.data);
      }
    };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recChunks, { type: 'audio/webm' });
      recChunks = [];
      const url = URL.createObjectURL(blob);
      if (els.playbackAudio) {
        els.playbackAudio.src = url;
      }
      if (els.downloadLink) {
        els.downloadLink.href = url;
        els.downloadLink.download = 'babybeat-heartbeat.webm';
      }
      if (els.playbackArea) {
        els.playbackArea.style.display = 'flex';
      }
    };
  }

  async function startRecording() {
    if (!mediaRecorder) setupRecorder();
    if (!mediaRecorder || mediaRecorder.state === 'recording') return;
    recChunks = [];
    mediaRecorder.start();
    recording = true;
    if (els.record) els.record.textContent = 'Stop Recording';
    setStatus('Recording heartbeat clip…');
  }

  async function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
    mediaRecorder.stop();
    recording = false;
    if (els.record) els.record.textContent = 'Start Recording';
    setStatus('Recording stopped. You can play or download the clip.');
  }

  // -------- AI hook (placeholder) ----------
  // If you later stand up an API, you can stream chunks here.
  async function maybeSendChunkToAI(_floatBuffer) {
    if (!aiConfig || !aiConfig.enabled || !aiConfig.endpoint) return;
    // Intentionally left as a stub so we don't break anything.
    // You can POST the chunk to aiConfig.endpoint and apply corrections
    // to threshold / BPM etc.
  }

  // -------- Public API functions ----------
  async function start() {
    if (running) return;
    await ensureContextAndStream();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    running = true;
    setButtonsForState();
    updateMonitorLabel();
    applyMonitorVolume();
    startVisualizer();
    setStatus('Listening… move the mic slowly and adjust sensitivity/filter.');
  }

  async function stop() {
    running = false;
    setButtonsForState();
    updateMonitorLabel();
    applyMonitorVolume();
    if (audioCtx && audioCtx.state !== 'closed') {
      await audioCtx.suspend();
    }
    setStatus('Stopped. Press Start Listening to resume.');
  }

  function toggleMonitor() {
    monitorOn = !monitorOn;
    updateMonitorLabel();
    applyMonitorVolume();
  }

  function setFilterHz(hz) {
    filterCentreHz = clamp(hz, 30, 200);
    if (bp) bp.frequency.value = filterCentreHz;
    updateFilterUI();
  }

  function setSensitivity(val) {
    sensitivity = clamp(val, 1, 10);
    if (els.sensitivity) els.sensitivity.value = String(sensitivity);
    updateSensitivityUI();
  }

  function setMonitorVol(percent) {
    if (els.monitorVol) els.monitorVol.value = String(clamp(percent, 0, 100));
    updateMonitorVolUI();
    applyMonitorVolume();
  }

  // -------- Bind buttons ----------
  if (els.start) els.start.addEventListener('click', () => start().catch(console.error));
  if (els.stop) els.stop.addEventListener('click', () => stop().catch(console.error));
  if (els.monitor) els.monitor.addEventListener('click', () => toggleMonitor());
  if (els.playEnhanced) {
    // For now, Play Enhanced just briefly boosts sensitivity & narrows band.
    els.playEnhanced.addEventListener('click', () => {
      setStatus('Enhanced listening: slightly boosted heartband & smoothing.');
      if (bp) bp.Q.value = 2.0;
      setTimeout(() => { if (bp) bp.Q.value = 1.4; }, 6000);
    });
  }
  if (els.record) {
    els.record.addEventListener('click', () => {
      if (!recording) startRecording().catch(console.error);
      else stopRecording().catch(console.error);
    });
  }

  setButtonsForState();
  updateMonitorLabel();

  return {
    start,
    stop,
    toggleMonitor,
    startRecording,
    stopRecording,
    setFilterHz,
    setSensitivity,
    setMonitorVol
  };
}
