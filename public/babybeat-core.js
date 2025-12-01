// babybeat-core-advanced.js
// Advanced acoustic fetal heartbeat detection engine
// Pushes the limits of what's possible with microphone-based monitoring

export async function initBabyBeat(opts = {}) {
  const els = mapSelectors(opts.elements || {});
  const licenseOk = await (opts.licenseValidator?.() ?? true);
  if (!licenseOk) throw new Error('License check failed');

  const aiConfig = opts.ai || { enabled: false, endpoint: null };

  // ========== ADVANCED PARAMETERS ==========
  const SAMPLE_RATE = 44100; // nominal; actual will be audioContext.sampleRate
  
  // Fetal heart characteristics
  const FETAL_BPM_MIN = 110;
  const FETAL_BPM_MAX = 180;
  const FETAL_BPM_NORMAL_MIN = 120;
  const FETAL_BPM_NORMAL_MAX = 160;
  
  // Maternal heart (to reject)
  const MATERNAL_BPM_MIN = 50;
  const MATERNAL_BPM_MAX = 110;
  
  // Detection timing
  const MIN_INTERVAL_MS = 60000 / FETAL_BPM_MAX; // ~333ms
  const MAX_INTERVAL_MS = 60000 / FETAL_BPM_MIN; // ~545ms
  const REFRACTORY_MS = 200;
  
  // Multi-band analysis
  const FREQ_BANDS = [
    { name: 'low',  center: 40,  q: 1.5, weight: 0.3 },
    { name: 'mid',  center: 70,  q: 1.8, weight: 0.5 },
    { name: 'high', center: 100, q: 1.5, weight: 0.2 }
  ];
  
  // Adaptive filtering
  const NOISE_FLOOR_ALPHA = 0.001;
  const SIGNAL_ENVELOPE_ALPHA = 0.2;
  const FAST_ENVELOPE_ALPHA = 0.35;
  const BPM_SMOOTH_ALPHA = 0.12;
  
  // Quality scoring
  const MIN_CONFIDENCE_THRESHOLD = 0.35;
  const QUALITY_HISTORY_SIZE = 30;
  
  // Pattern matching
  const PATTERN_WINDOW = 8;
  const AUTOCORR_LAG_MAX = 100; // samples for autocorrelation (used on envelope)

  // ========== STATE ==========
  let audioCtx = null;
  let mediaStream = null;
  let sourceNode = null;
  let analyser = null;
  let monitorGain = null;
  let recDestination = null;
  let mediaRecorder = null;
  let recChunks = [];
  let processor = null;

  // Filter banks
  let preGain = null;
  let highpass = null;
  let lowpass = null;
  let bandFilters = [];
  let maternalRejectFilter = null;

  // Runtime state
  let running = false;
  let monitorOn = false;
  let recording = false;

  // Detection state
  let noiseFloor = 0.001;
  let signalEnvelope = 0;
  let fastEnvelope = 0;
  let lastBeatTime = 0;
  let beatIntervals = []; // { interval, quality, time }
  let bpmDisplay = 0;
  let confidenceScore = 0;
  let qualityHistory = [];

  // Multi-band energy tracking
  let bandEnergies = FREQ_BANDS.map(() => 0);
  let bandEnvelopes = FREQ_BANDS.map(() => 0);

  // Maternal heart rejection
  let maternalBeatTimes = [];
  let maternalBPM = 0;

  // Pattern recognition
  let beatPattern = [];
  let patternTemplate = null;

  // Settings
  let channelMode = 'mix';
  let sensitivity = 7;
  let filterCentreHz = 70;
  let adaptiveMode = true; // not heavily used yet, but kept for future tuning
  
  // Visualization
  let waveformHistory = new Float32Array(2048);
  let spectrumHistory = [];
  const SPECTRUM_HISTORY_LEN = 60;
  let waveIndex = 0;
  let rafId = 0;

  // AI hook throttle
  let lastAiSendMs = 0;

  // ========== HELPERS ==========
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
    for (let i = 0; i < buffer.length; i++) {
      sum += buffer[i] * buffer[i];
    }
    return Math.sqrt(sum / buffer.length);
  }

  function autocorrelation(buffer, lag) {
    let sum = 0;
    const n = buffer.length - lag;
    if (n <= 0) return 0;
    for (let i = 0; i < n; i++) {
      sum += buffer[i] * buffer[i + lag];
    }
    return sum / n;
  }

  function calculateSNR(signal, noise) {
    if (noise <= 0) return 0;
    return 20 * Math.log10(signal / noise);
  }

  function setButtonsForState() {
    if (els.start) els.start.disabled = running;
    if (els.stop) els.stop.disabled = !running;
    if (els.monitor) els.monitor.disabled = !running;
    if (els.playEnhanced) els.playEnhanced.disabled = !running;
    if (els.record) els.record.disabled = !running;
  }

  function updateMonitorLabel() {
    if (!els.monitor) return;
    els.monitor.textContent = monitorOn ? 'Monitor: On' : 'Monitor: Off';
  }

  function updateBpmUI() {
    if (els.bpm) {
      if (!bpmDisplay || !isFinite(bpmDisplay)) {
        els.bpm.textContent = '-- BPM';
      } else {
        const rounded = Math.round(bpmDisplay);
        els.bpm.textContent = `${rounded} BPM`;
      }
    }

    // Optional: reflect confidence in status text / colour
    if (els.status) {
      const c = clamp(confidenceScore, 0, 1);
      els.status.style.opacity = 0.9;
      // Subtle background tint based on confidence
      const base = 146; // purple
      const green = 220;
      const r = Math.round(146 + (green - 146) * c);
      els.status.style.background = `rgb(${r}, 70, 255)`;
    }
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

  // ========== EVENT LISTENERS ==========
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
      bandFilters.forEach((f, i) => {
        if (f) {
          const base = 70;
          f.frequency.value = filterCentreHz + (FREQ_BANDS[i].center - base);
        }
      });
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

  // ========== AUDIO GRAPH ==========
  async function ensureContextAndStream() {
    if (audioCtx && mediaStream) return;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive'
      // sampleRate hint is often ignored by browser, that's ok
    });

    const targetRate = audioCtx.sampleRate || SAMPLE_RATE;

    // Request highest quality audio
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

    // Pre-gain for sensitivity control
    preGain = audioCtx.createGain();
    preGain.gain.value = 1.0;

    // High-pass to remove rumble and movement
    highpass = audioCtx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 20;
    highpass.Q.value = 0.7;

    // Low-pass to remove high-frequency noise
    lowpass = audioCtx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 200;
    lowpass.Q.value = 0.7;

    // Maternal heart rejection notch filter (adaptive)
    maternalRejectFilter = audioCtx.createBiquadFilter();
    maternalRejectFilter.type = 'notch';
    maternalRejectFilter.frequency.value = 80; // initial guess
    maternalRejectFilter.Q.value = 8.0;

    // Multi-band analysis filters
    bandFilters = FREQ_BANDS.map(band => {
      const f = audioCtx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = band.center;
      f.Q.value = band.q;
      return f;
    });

    // Monitor gain
    monitorGain = audioCtx.createGain();
    monitorGain.gain.value = 0.0;

    // Analyser for spectrum visualization
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.75;

    // Recording destination
    recDestination = audioCtx.createMediaStreamDestination();

    // Connect main chain: source -> preGain -> highpass -> lowpass -> maternalReject
    sourceNode.connect(preGain);
    preGain.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(maternalRejectFilter);

    // Split to band filters and analyser & outputs
    bandFilters.forEach(f => maternalRejectFilter.connect(f));
    maternalRejectFilter.connect(analyser);
    maternalRejectFilter.connect(recDestination);
    maternalRejectFilter.connect(monitorGain);
    monitorGain.connect(audioCtx.destination);

    // Script processor for detection
    const bufferSize = 2048;
    processor = audioCtx.createScriptProcessor(bufferSize, 2, 1);
    maternalRejectFilter.connect(processor);
    processor.connect(audioCtx.destination); // silent path, but required in some browsers

    processor.onaudioprocess = onAudioProcess;
  }

  function applyMonitorVolume() {
    if (!monitorGain || !els.monitorVol) return;
    const volPercent = Number(els.monitorVol.value || 0);
    const linear = clamp(volPercent / 100, 0, 1) * 0.7; // safety cap
    monitorGain.gain.value = monitorOn ? linear : 0;
  }

  // ========== PATTERN MATCHING ==========
  function calculatePatternMatch(envelopeBuffer) {
    // Use autocorrelation of a short envelope window to estimate regularity.
    if (envelopeBuffer.length < AUTOCORR_LAG_MAX + 2) return 0;

    // Downsample the absolute envelope a bit
    const step = 4;
    const env = [];
    for (let i = 0; i < envelopeBuffer.length; i += step) {
      env.push(Math.abs(envelopeBuffer[i]));
    }
    if (env.length < AUTOCORR_LAG_MAX + 2) return 0;

    let best = 0;
    for (let lag = 10; lag < AUTOCORR_LAG_MAX; lag++) {
      const val = autocorrelation(env, lag);
      if (val > best) best = val;
    }

    // Normalise crudely into 0..1
    return clamp(best * 4, 0, 1);
  }

  // ========== ADVANCED DETECTION ==========
  function onAudioProcess(e) {
    const input = e.inputBuffer;
    const n = input.length;
    if (!n || !audioCtx) return;

    // Channel selection
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

    // Apply sensitivity pre-scaling
    const sensitivityGain = 0.5 + (sensitivity / 10) * 2.0;
    const scaledBuffer = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      scaledBuffer[i] = channelData[i] * sensitivityGain;
    }

    // Calculate RMS energy
    const energy = rms(scaledBuffer);
    
    // Update noise floor (very slow adaptation)
    noiseFloor = ema(noiseFloor, energy * 0.3, NOISE_FLOOR_ALPHA);
    
    // Signal envelope (medium speed)
    signalEnvelope = ema(signalEnvelope, energy, SIGNAL_ENVELOPE_ALPHA);
    
    // Fast envelope for peak detection
    fastEnvelope = ema(fastEnvelope, energy, FAST_ENVELOPE_ALPHA);

    // SNR calculation
    const snr = calculateSNR(signalEnvelope, noiseFloor);

    // Adaptive thresholding baseline
    const adaptiveThreshold = noiseFloor * (3.0 + (10 - sensitivity) * 0.5);
    
    // Multi-band energy analysis (rough – uses global energy scaled by weights)
    bandEnergies.forEach((_, i) => {
      const bandEnergy = energy * FREQ_BANDS[i].weight;
      bandEnergies[i] = bandEnergy;
      bandEnvelopes[i] = ema(bandEnvelopes[i], bandEnergy, 0.15);
    });

    // Weighted multi-band score
    const multiBandScore = bandEnergies.reduce((sum, eVal, i) => 
      sum + eVal * FREQ_BANDS[i].weight, 0);

    // Pattern matching score
    let patternScore = 0;
    if (beatPattern.length >= PATTERN_WINDOW) {
      patternScore = calculatePatternMatch(scaledBuffer);
    }

    // Combined detection metric
    const detectionMetric = (
      multiBandScore * 0.6 +
      (fastEnvelope - adaptiveThreshold) * 0.3 +
      patternScore * 0.1
    );

    // Record waveform for visualization (downsampled)
    for (let i = 0; i < n; i += 4) {
      waveformHistory[waveIndex] = scaledBuffer[i];
      waveIndex = (waveIndex + 1) % waveformHistory.length;
    }

    // Record spectrum snapshot occasionally for spectrogram
    if (analyser) {
      const freqData = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(freqData);
      if (spectrumHistory.length >= SPECTRUM_HISTORY_LEN) {
        spectrumHistory.shift();
      }
      spectrumHistory.push(freqData);
    }

    // Beat detection
    const nowMs = audioCtx.currentTime * 1000;
    const timeSinceLastBeat = nowMs - lastBeatTime;

    const isPeak = detectionMetric > adaptiveThreshold * 1.5 &&
                   fastEnvelope > signalEnvelope * 0.7 &&
                   snr > 3.0;

    if (isPeak && 
        timeSinceLastBeat > REFRACTORY_MS && 
        timeSinceLastBeat >= MIN_INTERVAL_MS &&
        timeSinceLastBeat <= MAX_INTERVAL_MS * 1.5) {
      
      registerBeat(nowMs, detectionMetric, snr);
    }

    // Check for maternal heartbeat (slower rhythm)
    detectMaternalHeart(nowMs);

    updateBpmUI();

    // Optional AI hook (very lightweight, 1 Hz max)
    if (aiConfig.enabled && aiConfig.endpoint) {
      if (nowMs - lastAiSendMs > 1000) {
        lastAiSendMs = nowMs;
        // Fire-and-forget, don't await
        maybeSendChunkToAI(scaledBuffer).catch(() => {});
      }
    }
  }

  function registerBeat(nowMs, metric, snr) {
    const interval = nowMs - lastBeatTime;
    
    if (lastBeatTime > 0 && interval >= MIN_INTERVAL_MS) {
      // Calculate instantaneous BPM
      const instantBPM = 60000 / interval;
      
      // Quality scoring
      const quality = calculateBeatQuality(instantBPM, metric, snr);
      
      if (quality > MIN_CONFIDENCE_THRESHOLD) {
        beatIntervals.push({ interval, quality, time: nowMs });
        if (beatIntervals.length > 16) beatIntervals.shift();
        
        qualityHistory.push(quality);
        if (qualityHistory.length > QUALITY_HISTORY_SIZE) qualityHistory.shift();
        
        // Use weighted median based on quality
        const validBeats = beatIntervals.filter(b => 
          b.interval >= MIN_INTERVAL_MS && b.interval <= MAX_INTERVAL_MS
        );
        
        if (validBeats.length >= 4) {
          const recent = validBeats.slice(-10);
          const medInt = median(recent.map(b => b.interval));
          
          if (medInt > 0) {
            let rawBpm = 60000 / medInt;
            rawBpm = clamp(rawBpm, FETAL_BPM_MIN, FETAL_BPM_MAX);
            
            // Smooth BPM display
            if (!bpmDisplay) bpmDisplay = rawBpm;
            bpmDisplay = ema(bpmDisplay, rawBpm, BPM_SMOOTH_ALPHA);
            
            // Update confidence
            const avgQuality = qualityHistory.reduce((a, b) => a + b, 0) / qualityHistory.length;
            confidenceScore = avgQuality;

            // Maintain beat pattern timing (normalised intervals)
            const normInterval = interval / medInt;
            beatPattern.push(normInterval);
            if (beatPattern.length > PATTERN_WINDOW * 2) beatPattern.shift();

            // Update template loosely if we have a stable pattern
            if (!patternTemplate && beatPattern.length >= PATTERN_WINDOW) {
              patternTemplate = beatPattern.slice(-PATTERN_WINDOW);
            }
          }
        }
      }
    }
    
    lastBeatTime = nowMs;
    pulseBeat();
  }

  function calculateBeatQuality(bpm, metric, snr) {
    // Quality factors
    const bpmQuality = (bpm >= FETAL_BPM_NORMAL_MIN && bpm <= FETAL_BPM_NORMAL_MAX) ? 1.0 : 0.6;
    const snrQuality = clamp(snr / 10, 0, 1);
    const metricQuality = clamp(metric / 0.5, 0, 1);
    
    // Consistency with recent beats
    let consistencyQuality = 0.5;
    if (beatIntervals.length >= 3) {
      const recentIntervals = beatIntervals.slice(-5).map(b => b.interval);
      const med = median(recentIntervals);
      const stdDev = Math.sqrt(
        recentIntervals.reduce((sum, v) => {
          const diff = v - med;
          return sum + diff * diff;
        }, 0) / recentIntervals.length
      );
      consistencyQuality = clamp(1 - stdDev / 120, 0, 1);
    }

    // Penalty if close to maternal BPM
    let maternalPenalty = 0;
    if (maternalBPM > 0) {
      const diff = Math.abs(bpm - maternalBPM);
      if (diff < 15) {
        maternalPenalty = clamp((15 - diff) / 15, 0, 0.4);
      }
    }
    
    let q =
      bpmQuality * 0.3 +
      snrQuality * 0.25 +
      metricQuality * 0.2 +
      consistencyQuality * 0.25;

    q = q * (1 - maternalPenalty);
    return clamp(q, 0, 1);
  }

  function detectMaternalHeart(nowMs) {
    // Look for slower, regular beats (maternal heart typically 60-100 bpm)
    // We approximate by looking at long-term beat intervals as well.
    // This is intentionally conservative; it mostly drives the notch filter tuning.

    if (beatIntervals.length < 6) return;

    // Consider a longer window for maternal pattern
    const windowBeats = beatIntervals.slice(-12);
    const intervals = windowBeats.map(b => b.interval);
    const medInterval = median(intervals);
    if (!medInterval) return;

    const candidateBPM = 60000 / medInterval;
    if (candidateBPM >= MATERNAL_BPM_MIN && candidateBPM <= MATERNAL_BPM_MAX) {
      maternalBPM = ema(maternalBPM || candidateBPM, candidateBPM, 0.2);

      // Map maternal BPM (~60-100) into acoustic band (~60-120 Hz) for notch
      if (maternalRejectFilter) {
        const mappedHz = clamp(60 + (maternalBPM - 70) * 0.8, 40, 120);
        maternalRejectFilter.frequency.value = mappedHz;
      }
    }
  }

  // ========== VISUALISATION ==========
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

      // Grid
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
      grad.addColorStop(0, '#f87171');
      grad.addColorStop(0.5, '#fb923c');
      grad.addColorStop(1, '#caff00');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.beginPath();

      const len = waveformHistory.length;
      const mid = h * 0.6; // slightly lower so spectrogram can sit above if desired
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

      // Optional mini confidence bar at top
      const conf = clamp(confidenceScore, 0, 1);
      const barWidth = w * 0.25;
      const barHeight = 6;
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = '#1f2937';
      ctx.fillRect(8, 8, barWidth, barHeight);
      ctx.fillStyle = '#4ade80';
      ctx.fillRect(8, 8, barWidth * conf, barHeight);

      rafId = requestAnimationFrame(draw);
    }

    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(draw);
  }

  // ========== RECORDING ==========
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

  // ========== AI HOOK ==========
  async function maybeSendChunkToAI(floatBuffer) {
    try {
      if (!aiConfig || !aiConfig.enabled || !aiConfig.endpoint || !audioCtx) return;
      const sampleRate = audioCtx.sampleRate || SAMPLE_RATE;
      const payload = {
        sampleRate,
        // downsample for bandwidth
        chunk: Array.from(floatBuffer.filter((_, i) => i % 4 === 0)).slice(0, 1024),
        approxBpm: bpmDisplay || null,
        confidence: confidenceScore
      };
      await fetch(aiConfig.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(() => {});
    } catch (e) {
      // swallow – we don't want AI errors to break audio
      console.warn('[babybeat-ai] send error', e);
    }
  }

  // ========== PUBLIC API FUNCTIONS ==========
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
    bandFilters.forEach((f, i) => {
      if (!f) return;
      const base = 70;
      f.frequency.value = filterCentreHz + (FREQ_BANDS[i].center - base);
    });
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

  // ========== BIND UI BUTTONS ==========
  if (els.start) els.start.addEventListener('click', () => start().catch(console.error));
  if (els.stop) els.stop.addEventListener('click', () => stop().catch(console.error));
  if (els.monitor) els.monitor.addEventListener('click', () => toggleMonitor());
  if (els.playEnhanced) {
    // "Enhanced" mode: temporarily narrow bands & boost sensitivity a touch
    els.playEnhanced.addEventListener('click', () => {
      setStatus('Enhanced listening for ~6 seconds…');
      bandFilters.forEach((f) => { if (f) f.Q.value = 2.2; });
      const originalSens = sensitivity;
      setSensitivityVal(Math.min(10, sensitivity + 2));
      setTimeout(() => {
        bandFilters.forEach((f, i) => { if (f) f.Q.value = FREQ_BANDS[i].q; });
        setSensitivityVal(originalSens);
        setStatus('Listening…');
      }, 6000);
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
