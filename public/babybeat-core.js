// babybeat-core.js
// Modular heartbeat engine with:
// - Simple amplitude-based beat detection (like the original one-pager)
// - Separate fetal & maternal BPM candidates for testing/validation
// - Optional AI + recording + canvas visualiser

export async function initBabyBeat(opts = {}) {
  const els = mapSelectors(opts.elements || {});
  const licenseOk = await (opts.licenseValidator?.() ?? true);
  if (!licenseOk) throw new Error('License check failed');

  const aiConfig = opts.ai || { enabled: false, endpoint: null };

  // ========= CONSTANTS =========

  const SAMPLE_RATE = 44100;

  // Fetal window (fast)
  const FETAL_BPM_MIN = 100;
  const FETAL_BPM_MAX = 190;
  const FETAL_IDEAL_MIN = 120;
  const FETAL_IDEAL_MAX = 160;

  // Maternal window (slower)
  const MATERNAL_BPM_MIN = 50;
  const MATERNAL_BPM_MAX = 110;

  const REFRACTORY_MS = 350;   // minimum spacing between detected peaks

  // Convert to ms ranges
  const FETAL_MIN_MS = 60000 / FETAL_BPM_MAX; // ~316 ms
  const FETAL_MAX_MS = 60000 / FETAL_BPM_MIN; // 600 ms
  const MATERNAL_MIN_MS = 60000 / MATERNAL_BPM_MAX; // ~545 ms
  const MATERNAL_MAX_MS = 60000 / MATERNAL_BPM_MIN; // 1200 ms

  const BPM_SMOOTH_ALPHA = 0.25; // how strongly to follow new BPM

  // Envelopes / noise (for quality only, not gating)
  const NOISE_FLOOR_ALPHA     = 0.001;
  const SIGNAL_ENVELOPE_ALPHA = 0.2;
  const FAST_ENVELOPE_ALPHA   = 0.35;

  const QUALITY_HISTORY_SIZE = 30;

  // ========= STATE =========

  let audioCtx = null;
  let mediaStream = null;
  let sourceNode = null;
  let analyser = null;
  let monitorGain = null;
  let recDestination = null;
  let mediaRecorder = null;
  let recChunks = [];
  let processor = null;

  let preGain = null;
  let highpass = null;
  let lowpass = null;

  // Running / monitor / recording
  let running = false;
  let monitorOn = false;
  let recording = false;

  // Detection state
  let lastBeatTime = 0;
  let fetalIntervals = [];    // ms
  let maternalIntervals = []; // ms

  let fetalBpm = 0;
  let maternalBpm = 0;

  let noiseFloor = 0.001;
  let signalEnvelope = 0;
  let fastEnvelope = 0;

  let fetalQualityHistory = [];
  let maternalQualityHistory = [];

  // Display / visualiser
  let waveformHistory = new Float32Array(2048);
  let waveIndex = 0;
  let rafId = 0;

  // Settings
  let channelMode = 'mix';
  let sensitivity = 7;        // 1–10
  let filterCentreHz = 70;
  let lastAiSendMs = 0;

  // ========= HELPERS =========

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
    const a = [...arr].sort((a, b) => a - b);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function ema(prev, value, alpha) {
    return prev + alpha * (value - prev);
  }

  function rms(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    return Math.sqrt(sum / buffer.length);
  }

  function calculateSNR(signal, noise) {
    if (noise <= 0) return 0;
    return 20 * Math.log10(signal / noise);
  }

  function setButtonsForState() {
    if (els.start)       els.start.disabled = running;
    if (els.stop)        els.stop.disabled = !running;
    if (els.monitor)     els.monitor.disabled = !running;
    if (els.playEnhanced) els.playEnhanced.disabled = !running;
    if (els.record)      els.record.disabled = !running;
  }

  function updateMonitorLabel() {
    if (!els.monitor) return;
    els.monitor.textContent = monitorOn ? 'Monitor: On' : 'Monitor: Off';
  }

  function pulseBeat() {
    if (!els.pulse) return;
    els.pulse.classList.add('active');
    setTimeout(() => {
      if (els.pulse) els.pulse.classList.remove('active');
    }, 180);
  }

  function updateUI() {
    if (els.sensitivityValue) els.sensitivityValue.textContent = String(sensitivity);
    if (els.filterValue) els.filterValue.textContent = `${Math.round(filterCentreHz)} Hz`;
    if (els.monitorVol && els.monitorVolValue) {
      const vol = Number(els.monitorVol.value || 0);
      els.monitorVolValue.textContent = `${vol}%`;
    }
  }

  function chooseChannelModeFromMicType() {
    if (!els.micType) return;
    const v = els.micType.value;
    if (v === 'dji-mic-mini') channelMode = 'right';
    else if (v === 'professional' || v === 'stethoscope') channelMode = 'left';
    else channelMode = 'mix';
  }

  // ========= EVENT WIRING (UI) =========

  if (els.micType) {
    els.micType.addEventListener('change', chooseChannelModeFromMicType);
    chooseChannelModeFromMicType();
  }

  if (els.sensitivity) {
    els.sensitivity.addEventListener('input', () => {
      sensitivity = Number(els.sensitivity.value || 7);
      updateUI();
    });
    sensitivity = Number(els.sensitivity.value || 7);
  }

  if (els.filterFreq) {
    els.filterFreq.addEventListener('input', () => {
      filterCentreHz = Number(els.filterFreq.value || 70);
      updateUI();
      if (lowpass) {
        // keep a conservative low-pass; actual band is mostly from belly + hardware
        lowpass.frequency.value = Math.max(100, filterCentreHz * 2);
      }
    });
    filterCentreHz = Number(els.filterFreq.value || 70);
  }

  if (els.monitorVol) {
    els.monitorVol.addEventListener('input', () => {
      updateUI();
      applyMonitorVolume();
    });
  }

  updateUI();

  // ========= AUDIO GRAPH =========

  async function ensureContextAndStream() {
    if (audioCtx && mediaStream) return;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive'
    });

    const targetRate = audioCtx.sampleRate || SAMPLE_RATE;

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: targetRate,
        sampleSize: 16
      }
    });

    sourceNode = audioCtx.createMediaStreamSource(mediaStream);

    // Pre-gain (we’ll still use an internal "sensitivity" multiplier in process)
    preGain = audioCtx.createGain();
    preGain.gain.value = 1.0;

    highpass = audioCtx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 20;
    highpass.Q.value = 0.7;

    lowpass = audioCtx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 200; // broad; detection uses amplitude, not tight bands
    lowpass.Q.value = 0.7;

    monitorGain = audioCtx.createGain();
    monitorGain.gain.value = 0.0;

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3;

    recDestination = audioCtx.createMediaStreamDestination();

    // Chain: source -> preGain -> highpass -> lowpass -> analyser/monitor/record/processor
    sourceNode.connect(preGain);
    preGain.connect(highpass);
    highpass.connect(lowpass);

    lowpass.connect(analyser);
    lowpass.connect(recDestination);
    lowpass.connect(monitorGain);
    monitorGain.connect(audioCtx.destination);

    const bufferSize = 2048;
    processor = audioCtx.createScriptProcessor(bufferSize, 2, 1);
    lowpass.connect(processor);
    processor.connect(audioCtx.destination); // silent path, but needed on some browsers

    processor.onaudioprocess = onAudioProcess;
  }

  function applyMonitorVolume() {
    if (!monitorGain || !els.monitorVol) return;
    const volPercent = Number(els.monitorVol.value || 0);
    const linear = clamp(volPercent / 100, 0, 1) * 0.7; // limit max
    monitorGain.gain.value = monitorOn ? linear : 0;
  }

  // ========= DETECTION =========

  function onAudioProcess(e) {
    const input = e.inputBuffer;
    const n = input.length;
    if (!n || !audioCtx) return;

    // Channel selection (left/right/mix), similar to earlier
    let channelData;
    if (channelMode === 'left' || input.numberOfChannels === 1) {
      channelData = input.getChannelData(0);
    } else if (channelMode === 'right' && input.numberOfChannels > 1) {
      channelData = input.getChannelData(1);
    } else {
      const tmp = new Float32Array(n);
      for (let ch = 0; ch < input.numberOfChannels; ch++) {
        const d = input.getChannelData(ch);
        for (let i = 0; i < n; i++) tmp[i] += d[i];
      }
      for (let i = 0; i < n; i++) tmp[i] /= input.numberOfChannels;
      channelData = tmp;
    }

    // Sensitivity gain, like original
    const sensGain = Math.max(0.1, sensitivity * 3);
    const scaledBuffer = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      scaledBuffer[i] = channelData[i] * sensGain;
    }

    // Envelopes (for quality only)
    const energy = rms(scaledBuffer);
    noiseFloor     = ema(noiseFloor, energy * 0.3, NOISE_FLOOR_ALPHA);
    signalEnvelope = ema(signalEnvelope, energy, SIGNAL_ENVELOPE_ALPHA);
    fastEnvelope   = ema(fastEnvelope, energy, FAST_ENVELOPE_ALPHA);
    const snr = calculateSNR(signalEnvelope, noiseFloor);

    // Amplitude detection like your one-page code
    let peak = 0;
    let sumAmp = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(scaledBuffer[i]);
      sumAmp += a;
      if (a > peak) peak = a;
    }
    const avgAmp = sumAmp / n;

    // This threshold is intentionally very similar to your original (0.18),
    // but we gently modulate it with sensitivity
    const baseThresh = 0.18;
    const sensOffset = (7 - sensitivity) * 0.01; // higher sens → slightly lower thresh
    const peakThresh = baseThresh + sensOffset;

    const rising = peak > peakThresh;
    const nowMs = audioCtx.currentTime * 1000;
    const sinceLast = nowMs - lastBeatTime;

    // Waveform history for visualiser
    for (let i = 0; i < n; i += 4) {
      waveformHistory[waveIndex] = scaledBuffer[i];
      waveIndex = (waveIndex + 1) % waveformHistory.length;
    }

    if (rising && sinceLast > REFRACTORY_MS) {
      registerBeat(nowMs, peak, avgAmp, snr);
      lastBeatTime = nowMs;
    }

    updateBpmUI();

    // AI diagnostics
    if (aiConfig.enabled && aiConfig.endpoint) {
      if (nowMs - lastAiSendMs > 1000) {
        lastAiSendMs = nowMs;
        maybeSendChunkToAI(scaledBuffer).catch(() => {});
      }
    }
  }

  function registerBeat(nowMs, peak, avgAmp, snr) {
    if (lastBeatTime <= 0) {
      lastBeatTime = nowMs;
      pulseBeat();
      return;
    }

    const interval = nowMs - lastBeatTime;

    // Classify interval into fetal / maternal windows
    const inFetalWindow =
      interval >= FETAL_MIN_MS && interval <= FETAL_MAX_MS;
    const inMaternalWindow =
      interval >= MATERNAL_MIN_MS && interval <= MATERNAL_MAX_MS;

    // Quality estimation from amplitude and SNR
    const ampQuality = clamp(peak / 0.7, 0, 1);    // 0.7 is an empirical "strong"
    const snrQuality = clamp(snr / 10, 0, 1);      // 10 dB = good-ish
    const baseQuality = (ampQuality * 0.6 + snrQuality * 0.4);

    if (inFetalWindow) {
      fetalIntervals.push(interval);
      if (fetalIntervals.length > 16) fetalIntervals.shift();
      fetalQualityHistory.push(baseQuality);
      if (fetalQualityHistory.length > QUALITY_HISTORY_SIZE) fetalQualityHistory.shift();
      fetalBpm = computeBpmFromIntervals(fetalIntervals, fetalBpm);
    }

    if (inMaternalWindow) {
      maternalIntervals.push(interval);
      if (maternalIntervals.length > 16) maternalIntervals.shift();
      maternalQualityHistory.push(baseQuality);
      if (maternalQualityHistory.length > QUALITY_HISTORY_SIZE) maternalQualityHistory.shift();
      maternalBpm = computeBpmFromIntervals(maternalIntervals, maternalBpm);
    }

    // Pulse animation
    pulseBeat();

    // Status string for debugging maternal vs fetal
    const fetalStr = fetalBpm
      ? `${Math.round(fetalBpm)} BPM (candidate${fetalBpm >= FETAL_IDEAL_MIN && fetalBpm <= FETAL_IDEAL_MAX ? ', in fetal range' : ''})`
      : '—';

    const maternalStr = maternalBpm
      ? `${Math.round(maternalBpm)} BPM (likely maternal)`
      : '—';

    let statusMsg = `Fetal: ${fetalStr} • Maternal: ${maternalStr}`;
    statusMsg += '  —  This tool is for educational purposes and not a medical device.';

    setStatus(statusMsg);
  }

  function computeBpmFromIntervals(intervals, prevBpm) {
    if (intervals.length < 3) return prevBpm || 0;

    const clean = intervals.filter(ms => ms > 0).slice(-12);
    if (!clean.length) return prevBpm || 0;

    const sorted = clean.slice().sort((a, b) => a - b);
    const cut = Math.max(1, Math.floor(sorted.length * 0.2));
    const trimmed = sorted.slice(cut, sorted.length - cut);
    const base = trimmed.length ? trimmed : sorted;
    if (!base.length) return prevBpm || 0;

    const avgMs = base.reduce((a, b) => a + b, 0) / base.length;
    const rawBpm = 60000 / avgMs;

    if (!prevBpm) return rawBpm;
    return BPM_SMOOTH_ALPHA * rawBpm + (1 - BPM_SMOOTH_ALPHA) * prevBpm;
  }

  function updateBpmUI() {
    const fetalDisplay = fetalBpm ? Math.round(fetalBpm) : null;
    const maternalDisplay = maternalBpm ? Math.round(maternalBpm) : null;

    // Main BPM element: show fetal candidate if we have one, else maternal
    if (els.bpm) {
      if (fetalDisplay) {
        els.bpm.textContent = `${fetalDisplay} BPM`;
      } else if (maternalDisplay) {
        els.bpm.textContent = `${maternalDisplay} BPM (likely maternal)`;
      } else {
        els.bpm.textContent = '-- BPM';
      }
    }

    // Optional dedicated maternal BPM span
    if (els.bpmMaternal) {
      els.bpmMaternal.textContent = maternalDisplay
        ? `${maternalDisplay} BPM (likely maternal)`
        : '-- BPM';
    }

    // Optional colour hint: green-ish if fetal in ideal range
    if (els.bpm && fetalDisplay) {
      if (fetalDisplay >= FETAL_IDEAL_MIN && fetalDisplay <= FETAL_IDEAL_MAX) {
        els.bpm.style.color = '#bbf7d0'; // pale green
      } else {
        els.bpm.style.color = '#ffedd5'; // warm amber-ish
      }
    }
  }

  // ========= VISUALISER =========

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
      const w = canvas.clientWidth || 1;
      const h = canvas.clientHeight || 1;
      ctx.clearRect(0, 0, w, h);

      // Background grid
      ctx.globalAlpha = 0.18;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < w; x += 24) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      for (let y = 0; y < h; y += 24) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();

      // Waveform
      ctx.globalAlpha = 1;
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0,   '#f87171');
      grad.addColorStop(0.5, '#fb923c');
      grad.addColorStop(1,   '#caff00');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.beginPath();

      const len = waveformHistory.length;
      const mid = h * 0.6;
      const scale = h * 0.8;

      for (let i = 0; i < len; i++) {
        const idx = (waveIndex + i) % len;
        const v = waveformHistory[idx] || 0;
        const x = (i / (len - 1)) * w;
        const y = mid - v * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      rafId = requestAnimationFrame(draw);
    }

    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(draw);
  }

  // ========= RECORDING =========

  function setupRecorder() {
    if (!recDestination) return;
    try {
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      mediaRecorder = new MediaRecorder(recDestination.stream, { mimeType: mime });
      recChunks = [];

      mediaRecorder.ondataavailable = (evt) => {
        if (evt.data && evt.data.size > 0) recChunks.push(evt.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(recChunks, { type: mediaRecorder.mimeType });
        const url = URL.createObjectURL(blob);
        recChunks = [];
        if (els.playbackAudio) els.playbackAudio.src = url;
        if (els.downloadLink) {
          els.downloadLink.href = url;
          els.downloadLink.download = 'babybeat-heartbeat.webm';
        }
        if (els.playbackArea) els.playbackArea.style.display = 'flex';
      };
    } catch (e) {
      console.warn('Recorder unavailable', e);
      if (els.record) els.record.disabled = true;
    }
  }

  async function startRecording() {
    if (!mediaRecorder) setupRecorder();
    if (!mediaRecorder || mediaRecorder.state === 'recording') return;
    recChunks = [];
    mediaRecorder.start(100);
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

  // ========= AI HOOK =========

  async function maybeSendChunkToAI(floatBuffer) {
    try {
      if (!aiConfig || !aiConfig.enabled || !aiConfig.endpoint || !audioCtx) return;
      const sampleRate = audioCtx.sampleRate || SAMPLE_RATE;
      const payload = {
        sampleRate,
        chunk: Array.from(floatBuffer.filter((_, i) => i % 4 === 0)).slice(0, 1024),
        fetalBpm: fetalBpm || null,
        maternalBpm: maternalBpm || null
      };
      await fetch(aiConfig.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(() => {});
    } catch (e) {
      console.warn('[babybeat-ai] send error', e);
    }
  }

  // ========= PUBLIC API =========

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
    if (els.filterFreq) els.filterFreq.value = String(Math.round(filterCentreHz));
    if (lowpass) lowpass.frequency.value = Math.max(100, filterCentreHz * 2);
    updateUI();
  }

  function setSensitivityVal(val) {
    sensitivity = clamp(val, 1, 10);
    if (els.sensitivity) els.sensitivity.value = String(sensitivity);
    updateUI();
  }

  function setMonitorVol(percent) {
    if (els.monitorVol) els.monitorVol.value = String(clamp(percent, 0, 100));
    updateUI();
    applyMonitorVolume();
  }

  // Bind buttons
  if (els.start)       els.start.addEventListener('click', () => start().catch(console.error));
  if (els.stop)        els.stop.addEventListener('click', () => stop().catch(console.error));
  if (els.monitor)     els.monitor.addEventListener('click', () => toggleMonitor());
  if (els.playEnhanced) {
    els.playEnhanced.addEventListener('click', () => {
      setStatus('Enhanced listening (UI only) – core already band-limits and amplifies signal.');
      setTimeout(() => setStatus('Listening…'), 2500);
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
  updateBpmUI();

  return {
    start,
    stop,
    toggleMonitor,
    startRecording,
    stopRecording,
    setFilterHz,
    setSensitivity: setSensitivityVal,
    setMonitorVol
  };
}
