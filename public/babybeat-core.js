// babybeat-core.js
// Simple, honest BabyBeat engine:
// - One BPM stream (no forcing into fetal range)
// - Semi–real-time: uses only last few beats
// - Flags "likely maternal" only when BPM is in maternal range
// - Flags "typical fetal range" when BPM is in fetal range
// - Resets when no beats for a while (no sticky BPM)

export async function initBabyBeat(opts = {}) {
  const els = mapSelectors(opts.elements || {});
  const aiConfig = opts.ai || { enabled: false, endpoint: null };

  // ----- CONSTANTS -----
  // Beat timing windows
  const REFRACTORY_MS   = 350;       // minimal gap between beats
  const MIN_INTERVAL_MS = 300;       // 200 BPM upper bound-ish
  const MAX_INTERVAL_MS = 1200;      // ~50 BPM lower bound

  const BPM_ALPHA       = 0.25;      // EMA smoothing for BPM
  const MAX_BEAT_WINDOW = 8;         // only last N intervals for semi–real-time
  const NO_BEAT_TIMEOUT = 2500;      // ms → clear BPM if no beat

  // Ranges
  const MATERNAL_MIN = 50;
  const MATERNAL_MAX = 110;
  const FETAL_MIN    = 120;
  const FETAL_MAX    = 160;

  // Detection
  const PEAK_THRESHOLD = 0.18;       // same spirit as original
  const NOISE_ALPHA    = 0.001;
  const ENV_ALPHA      = 0.2;
  const FAST_ENV_ALPHA = 0.35;

  class BabyBeatEngine {
    constructor(els, aiConfig) {
      this.els = els;
      this.ai = aiConfig || { enabled: false, endpoint: null };

      this.audioContext = null;
      this.microphone   = null;
      this.analyser     = null;
      this.dataArray    = null;

      this.gainNode     = null;
      this.bandpass     = null;
      this.compressor   = null;
      this.monitorGain  = null;
      this.mediaDest    = null;
      this.mediaRecorder = null;
      this.recChunks    = [];

      this.isListening  = false;
      this.isMonitoring = false;
      this.isRecording  = false;

      this.recentFloat      = new Float32Array(0);
      this.maxRecentSamples = 0;

      this.bpm          = 0;
      this.lastBeatTime = 0;
      this.beatTimes    = [];

      this.noiseFloor     = 0.001;
      this.signalEnvelope = 0;
      this.fastEnvelope   = 0;

      this.channelMode  = 'mix';
      this.sensitivity  = 7;
      this.lastAiSendMs = 0;

      this._previewGain   = null;
      this._previewSource = null;

      this.bindUI();
      this.updateSliderLabels();
    }

    // ---------- UI Helpers ----------
    setStatus(msg) {
      if (this.els.status) this.els.status.textContent = msg;
    }

    updateSliderLabels() {
      if (this.els.sensitivity && this.els.sensitivityValue) {
        this.els.sensitivityValue.textContent = this.els.sensitivity.value;
      }
      if (this.els.filterFreq && this.els.filterValue) {
        this.els.filterValue.textContent = this.els.filterFreq.value + ' Hz';
      }
      if (this.els.monitorVol && this.els.monitorVolValue) {
        this.els.monitorVolValue.textContent = this.els.monitorVol.value + '%';
      }
    }

    bindUI() {
      const e = this.els;

      if (e.micType) {
        e.micType.addEventListener('change', () => this.updateChannelMode());
        this.updateChannelMode();
      }

      if (e.sensitivity) {
        this.sensitivity = parseInt(e.sensitivity.value || '7', 10);
        e.sensitivity.addEventListener('input', () => {
          this.sensitivity = parseInt(e.sensitivity.value || '7', 10);
          this.updateSliderLabels();
        });
      }

      if (e.filterFreq) {
        e.filterFreq.addEventListener('input', () => {
          this.updateSliderLabels();
        });
      }

      if (e.monitorVol) {
        e.monitorVol.addEventListener('input', () => {
          this.updateSliderLabels();
          this.applyMonitorVolume();
        });
      }

      if (e.start)       e.start.addEventListener('click', () => this.startListening());
      if (e.stop)        e.stop.addEventListener('click', () => this.stopListening());
      if (e.monitor)     e.monitor.addEventListener('click', () => this.toggleMonitor());
      if (e.playEnhanced) e.playEnhanced.addEventListener('click', () => this.playEnhanced());
      if (e.record)      e.record.addEventListener('click', () => this.toggleRecording());

      this.setButtons();
      this.updateBpmUI();
      this.applyMonitorLabel();
    }

    updateChannelMode() {
      const sel = this.els.micType;
      if (!sel) return;
      const v = sel.value;
      if (v === 'dji-mic-mini') this.channelMode = 'right';
      else if (v === 'professional' || v === 'stethoscope') this.channelMode = 'left';
      else this.channelMode = 'mix';
    }

    setButtons() {
      if (!this.els) return;
      if (this.els.start)       this.els.start.disabled       = this.isListening;
      if (this.els.stop)        this.els.stop.disabled        = !this.isListening;
      if (this.els.monitor)     this.els.monitor.disabled     = !this.isListening;
      if (this.els.playEnhanced) this.els.playEnhanced.disabled = !this.isListening;
      if (this.els.record)      this.els.record.disabled      = !this.isListening;
    }

    applyMonitorLabel() {
      if (!this.els.monitor) return;
      this.els.monitor.textContent = this.isMonitoring ? '🎧 Monitor: On' : '🎧 Monitor: Off';
    }

    applyMonitorVolume() {
      if (!this.monitorGain || !this.els.monitorVol) return;
      const vol = parseInt(this.els.monitorVol.value || '0', 10);
      const linear = clamp(vol / 100, 0, 1) * 0.7;
      this.monitorGain.gain.value = this.isMonitoring ? linear : 0;
    }

    // ---------- Audio Chain ----------
    setupAudioChain() {
      const sens = parseInt(this.els.sensitivity?.value || '7', 10);
      const filt = parseInt(this.els.filterFreq?.value || '60', 10);

      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = Math.max(0.1, sens * 3);

      this.bandpass = this.audioContext.createBiquadFilter();
      this.bandpass.type = 'bandpass';
      this.bandpass.frequency.value = filt;
      this.bandpass.Q.value = 3;

      this.compressor = this.audioContext.createDynamicsCompressor();
      this.compressor.threshold.value = -50;
      this.compressor.knee.value      = 40;
      this.compressor.ratio.value     = 12;
      this.compressor.attack.value    = 0.003;
      this.compressor.release.value   = 0.25;
    }

    setupRecorder(stream) {
      try {
        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';
        this.mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
        this.recChunks = [];

        this.mediaRecorder.ondataavailable = e => {
          if (e.data && e.data.size) this.recChunks.push(e.data);
        };

        this.mediaRecorder.onstop = () => {
          const blob = new Blob(this.recChunks, { type: this.mediaRecorder.mimeType });
          const url  = URL.createObjectURL(blob);
          this.recChunks = [];
          if (this.els.playbackAudio) this.els.playbackAudio.src = url;
          if (this.els.downloadLink) {
            this.els.downloadLink.href = url;
            this.els.downloadLink.download = 'heartbeat.webm';
          }
          if (this.els.playbackArea) this.els.playbackArea.style.display = 'block';
        };
      } catch (e) {
        console.warn('Recorder unavailable', e);
        if (this.els.record) this.els.record.disabled = true;
      }
    }

    async startListening() {
      try {
        this.setStatus('Requesting microphone access…');

        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('getUserMedia not supported. Use HTTPS or localhost.');
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 2
          }
        });

        if (!this.audioContext) {
          this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
        }

        this.microphone = this.audioContext.createMediaStreamSource(stream);
        this.setupAudioChain();

        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.3;

        this.monitorGain = this.audioContext.createGain();
        this.monitorGain.gain.value = parseInt(this.els.monitorVol?.value || '30', 10) / 100;

        // Chain: mic → gain → bandpass → compressor
        this.microphone.connect(this.gainNode);
        this.gainNode.connect(this.bandpass);
        this.bandpass.connect(this.compressor);

        // Monitor (off by default)
        this.compressor.connect(this.monitorGain);
        this.monitorGain.connect(this.audioContext.destination);
        this.monitorGain.disconnect(this.audioContext.destination);
        this.isMonitoring = false;
        this.applyMonitorLabel();

        // Analyser + recorder
        this.compressor.connect(this.analyser);
        this.mediaDest = this.audioContext.createMediaStreamDestination();
        this.compressor.connect(this.mediaDest);
        this.setupRecorder(this.mediaDest.stream);

        this.dataArray = new Uint8Array(this.analyser.fftSize);
        this.maxRecentSamples = Math.floor(this.audioContext.sampleRate * 1.2);
        this.recentFloat = new Float32Array(0);

        this.isListening = true;
        this.setButtons();
        this.setStatus('Listening for heartbeat… (move mic slowly, use headphones for monitor)');
        this.bpm = 0;
        this.beatTimes = [];
        this.lastBeatTime = 0;
        this.updateBpmUI();

        this.processAudio();
      } catch (err) {
        console.error(err);
        this.setStatus('Error: ' + err.message);
        this.isListening = false;
        this.setButtons();
      }
    }

    // ---------- Processing ----------
    processAudio() {
      if (!this.isListening || !this.analyser) return;

      this.analyser.getByteTimeDomainData(this.dataArray);

      let peak = 0;
      let sum  = 0;
      for (let i = 0; i < this.dataArray.length; i++) {
        const amp = Math.abs(this.dataArray[i] - 128) / 128;
        sum += amp;
        if (amp > peak) peak = amp;
      }
      const avg = sum / this.dataArray.length;

      // Simple visual: height + glow
      if (this.els.waveform) {
        const h = Math.min(avg * 100, 50);
        this.els.waveform.style.height = h + 'px';
        this.els.waveform.style.boxShadow = `0 0 ${h}px rgba(255,127,127,.45)`;
      }

      // Float data for recent buffer
      const f32 = new Float32Array(this.analyser.fftSize);
      this.analyser.getFloatTimeDomainData(f32);
      this.appendRecentFloat(f32);

      // Envelopes / SNR (mostly for sanity)
      const energy = rms(f32);
      this.noiseFloor     = ema(this.noiseFloor,     energy * 0.3, NOISE_ALPHA);
      this.signalEnvelope = ema(this.signalEnvelope, energy,       ENV_ALPHA);
      this.fastEnvelope   = ema(this.fastEnvelope,   energy,       FAST_ENV_ALPHA);
      const snr = calcSNR(this.signalEnvelope, this.noiseFloor);

      const now = Date.now();
      const sinceLast = this.lastBeatTime ? (now - this.lastBeatTime) : Infinity;

      // Heartbeat detection = simple amplitude threshold + refractory
      const rising = peak > PEAK_THRESHOLD;
      if (rising && sinceLast > REFRACTORY_MS) {
        this.registerBeat(now, peak, avg, snr);
        this.lastBeatTime = now;
      }

      // If no beats for a while → clear BPM (no sticky display)
      if (this.lastBeatTime && now - this.lastBeatTime > NO_BEAT_TIMEOUT && this.bpm !== 0) {
        this.bpm = 0;
        this.updateBpmUI();
        this.setStatus('Listening… (no consistent heartbeat detected yet)');
      }

      // Optional AI hook (still off by default)
      if (this.ai.enabled && this.ai.endpoint && now - this.lastAiSendMs > 1000) {
        this.lastAiSendMs = now;
        this.sendToAI(f32).catch(() => {});
      }

      requestAnimationFrame(() => this.processAudio());
    }

    appendRecentFloat(f32) {
      const old  = this.recentFloat;
      const want = Math.min(this.maxRecentSamples, old.length + f32.length);
      const out  = new Float32Array(want);
      const tail = Math.min(old.length, want - f32.length);
      if (tail > 0) out.set(old.subarray(old.length - tail), 0);
      out.set(f32.subarray(f32.length - (want - tail)), tail);
      this.recentFloat = out;
    }

    registerBeat(ts, peak, avgAmp, snr) {
      this.beatTimes.push(ts);
      if (this.beatTimes.length > MAX_BEAT_WINDOW + 2) {
        this.beatTimes.shift();
      }

      this.pulseAnimation();

      if (this.beatTimes.length < 3) return;

      // only use last few intervals = semi–real-time
      const times = this.beatTimes;
      const intervals = [];
      for (let i = 1; i < times.length; i++) {
        intervals.push(times[i] - times[i - 1]);
      }

      const recent = intervals.slice(-MAX_BEAT_WINDOW);
      const valid  = recent.filter(ms => ms >= MIN_INTERVAL_MS && ms <= MAX_INTERVAL_MS);
      if (valid.length < 2) return;

      const avgMs = valid.reduce((a, b) => a + b, 0) / valid.length;
      let rawBpm  = 60000 / avgMs;

      if (!isFinite(rawBpm) || rawBpm < 40 || rawBpm > 220) {
        // Ignore crazy spikes instead of forcing into fetal range
        return;
      }

      if (!this.bpm) this.bpm = rawBpm;
      else this.bpm = BPM_ALPHA * rawBpm + (1 - BPM_ALPHA) * this.bpm;

      this.updateBpmUI();

      // Label logic is derived from the ONE bpm value:
      const rounded = Math.round(this.bpm);
      const inFetal    = rounded >= FETAL_MIN    && rounded <= FETAL_MAX;
      const inMaternal = rounded >= MATERNAL_MIN && rounded <= MATERNAL_MAX;

      let label;
      if (inFetal) {
        label = `Fetal-like heartbeat detected: ~${rounded} BPM (typical fetal range).`;
      } else if (inMaternal) {
        label = `Heartbeat ~${rounded} BPM — this may be maternal (mum's heart).`;
      } else {
        label = `Heartbeat candidate: ~${rounded} BPM (outside typical fetal/maternal ranges; could be noise).`;
      }

      this.setStatus(label + ' Educational use only, not a medical device.');
    }

    pulseAnimation() {
      const p = this.els.pulse;
      if (!p) return;
      p.style.animation = 'heartbeat .6s ease-in-out';
      setTimeout(() => { p.style.animation = 'none'; }, 600);
    }

    updateBpmUI() {
      const bpm = this.bpm ? Math.round(this.bpm) : null;

      if (this.els.bpm) {
        this.els.bpm.textContent = bpm ? `${bpm} BPM` : '-- BPM';
      }

      // We use bpmMaternal as a *label* instead of a second number:
      if (this.els.bpmMaternal) {
        if (!bpm) {
          this.els.bpmMaternal.textContent = '—';
        } else if (bpm >= FETAL_MIN && bpm <= FETAL_MAX) {
          this.els.bpmMaternal.textContent = '✓ In typical fetal range';
        } else if (bpm >= MATERNAL_MIN && bpm <= MATERNAL_MAX) {
          this.els.bpmMaternal.textContent = '⚠ Might be maternal (mum’s heart)';
        } else {
          this.els.bpmMaternal.textContent = '… Outside typical fetal/maternal ranges';
        }
      }
    }

    // ---------- Monitor / Recording ----------
    toggleMonitor() {
      if (!this.monitorGain || !this.audioContext) return;
      if (this.isMonitoring) {
        try { this.monitorGain.disconnect(this.audioContext.destination); } catch {}
        this.isMonitoring = false;
      } else {
        try { this.monitorGain.connect(this.audioContext.destination); } catch {}
        this.isMonitoring = true;
      }
      this.applyMonitorLabel();
      this.applyMonitorVolume();
    }

    async toggleRecording() {
      if (!this.mediaRecorder) {
        if (this.mediaDest) this.setupRecorder(this.mediaDest.stream);
      }
      if (!this.mediaRecorder) return;

      if (this.mediaRecorder.state === 'recording') {
        this.mediaRecorder.stop();
        this.isRecording = false;
        if (this.els.record) this.els.record.textContent = '⏺ Start Recording';
        this.setStatus('Recording stopped');
      } else {
        this.recChunks = [];
        this.mediaRecorder.start(100);
        this.isRecording = true;
        if (this.els.record) this.els.record.textContent = '⏹ Stop Recording';
        this.setStatus('Recording…');
      }
    }

    async stopListening() {
      this.isListening = false;

      const nodes = [
        this.microphone,
        this.gainNode,
        this.bandpass,
        this.compressor,
        this.analyser,
        this.monitorGain
      ];
      nodes.forEach(n => { try { n && n.disconnect && n.disconnect(); } catch {} });

      if (this.audioContext) {
        try {
          if (this.audioContext.state !== 'closed') await this.audioContext.close();
        } catch {}
        this.audioContext = null;
      }

      if (this.mediaDest && this.mediaDest.stream) {
        this.mediaDest.stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
      }

      if (this.mediaRecorder) {
        try { if (this.mediaRecorder.state === 'recording') this.mediaRecorder.stop(); } catch {}
      }

      if (this._previewSource) {
        try { this._previewSource.stop(); } catch {}
        try { this._previewSource.disconnect(); } catch {}
        this._previewSource = null;
      }
      if (this._previewGain) {
        try { this._previewGain.disconnect(); } catch {}
        this._previewGain = null;
      }

      this.recentFloat = new Float32Array(0);
      this.isMonitoring = false;
      this.applyMonitorLabel();

      this.bpm = 0;
      this.updateBpmUI();
      this.setButtons();

      if (this.els.waveform) {
        this.els.waveform.style.height = '2px';
        this.els.waveform.style.boxShadow = 'none';
      }
      this.setStatus('Stopped listening');
    }

    // ---------- Enhanced Playback ----------
    async playEnhanced() {
      try {
        if (!this.audioContext) {
          this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
        }

        if (this._previewSource) {
          try { this._previewSource.stop(); } catch {}
          try { this._previewSource.disconnect(); } catch {}
          this._previewSource = null;
        }
        if (this._previewGain) {
          try { this._previewGain.disconnect(); } catch {}
          this._previewGain = null;
        }

        const sr = this.audioContext.sampleRate;
        const enough = this.recentFloat && this.recentFloat.length > Math.floor(sr * 0.3);
        let buffer;

        if (enough) {
          const takeSec = 0.8;
          const len = Math.min(Math.floor(sr * takeSec), this.recentFloat.length);
          const slice = this.recentFloat.subarray(this.recentFloat.length - len);
          let maxA = 0;
          for (let i = 0; i < slice.length; i++) {
            const a = Math.abs(slice[i]);
            if (a > maxA) maxA = a;
          }
          const norm = maxA > 0 ? 0.9 / maxA : 1;
          const fade = Math.floor(0.02 * sr);
          const data = new Float32Array(len);
          for (let i = 0; i < len; i++) {
            let s = slice[i] * norm;
            if (i < fade) s *= i / fade;
            if (i > len - fade) s *= (len - i) / fade;
            data[i] = s;
          }
          buffer = this.audioContext.createBuffer(1, len, sr);
          buffer.copyToChannel(data, 0, 0);
        } else {
          const duration = 0.25;
          const len = Math.floor(duration * sr);
          buffer = this.audioContext.createBuffer(1, len, sr);
          const data = buffer.getChannelData(0);
          for (let i = 0; i < len; i++) {
            const t = i / sr;
            let a = 0;
            if (t < 0.08) a = Math.sin(t * 80 * Math.PI) * Math.exp(-t * 20);
            else if (t > 0.12 && t < 0.20) {
              const t2 = t - 0.12;
              a = Math.sin(t2 * 120 * Math.PI) * Math.exp(-t2 * 30) * 0.7;
            }
            data[i] = a * 0.9;
          }
        }

        const sens = parseInt(this.els.sensitivity?.value || '7', 10);
        this._previewGain = this.audioContext.createGain();
        this._previewGain.gain.value = 0.15 + sens * 0.09;
        this._previewGain.connect(this.audioContext.destination);

        const bpmForLoop = (this.bpm && this.bpm >= 80 && this.bpm <= 200) ? this.bpm : 140;
        const iv = 60 / bpmForLoop;
        const now = this.audioContext.currentTime;
        const loops = 6;

        for (let n = 0; n < loops; n++) {
          const src = this.audioContext.createBufferSource();
          src.buffer = buffer;
          src.connect(this._previewGain);
          src.start(now + n * iv);
          if (n === loops - 1) this._previewSource = src;
        }

        this.setStatus('Playing enhanced heartbeat snippet…');
      } catch (err) {
        console.error(err);
        this.setStatus('Playback error: ' + err.message);
      }
    }

    // ---------- AI hook (optional) ----------
    async sendToAI(floatBuffer) {
      try {
        if (!this.ai || !this.ai.enabled || !this.ai.endpoint || !this.audioContext) return;
        const sampleRate = this.audioContext.sampleRate || 44100;
        const payload = {
          sampleRate,
          chunk: Array.from(floatBuffer.filter((_, i) => i % 4 === 0)).slice(0, 1024),
          bpm: this.bpm || null
        };
        await fetch(this.ai.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).catch(() => {});
      } catch (e) {
        console.warn('[babybeat-ai] send error', e);
      }
    }
  }

  // ----- Shared helpers -----
  function mapSelectors(map) {
    const out = {};
    for (const k of Object.keys(map)) {
      const sel = map[k];
      out[k] = typeof sel === 'string' ? document.querySelector(sel) : sel;
    }
    return out;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function ema(prev, value, alpha) {
    return prev + alpha * (value - prev);
  }

  function rms(buf) {
    if (!buf || !buf.length) return 0;
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  function calcSNR(signal, noise) {
    if (noise <= 0) return 0;
    return 20 * Math.log10(signal / noise);
  }

  // ----- Instance + Public API -----
  const engine = new BabyBeatEngine(els, aiConfig);

  return {
    start: () => engine.startListening(),
    stop: () => engine.stopListening(),
    toggleMonitor: () => engine.toggleMonitor(),
    startRecording: () => engine.toggleRecording(),
    stopRecording: () => engine.toggleRecording(),
    setSensitivity: (v) => {
      if (engine.els.sensitivity) engine.els.sensitivity.value = String(v);
      engine.sensitivity = v;
      engine.updateSliderLabels();
    },
    setFilterHz: (hz) => {
      if (engine.els.filterFreq) engine.els.filterFreq.value = String(hz);
      engine.updateSliderLabels();
    },
    setMonitorVol: (p) => {
      if (engine.els.monitorVol) engine.els.monitorVol.value = String(p);
      engine.updateSliderLabels();
      engine.applyMonitorVolume();
    }
  };
}
