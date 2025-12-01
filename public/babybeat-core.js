// babybeat-core.js
// Core BabyBeat engine
// - Uses simple amplitude-based detection (like your original)
// - Adds separate fetal + maternal BPM estimates
// - Handles monitoring, recording, enhanced playback

export async function initBabyBeat(opts = {}) {
  const els = mapSelectors(opts.elements || {});
  const aiConfig = opts.ai || { enabled: false, endpoint: null };

  // ---- Detection tuning constants (matching original style) ----
  const MIN_FETAL_BPM   = 100;
  const MAX_FETAL_BPM   = 190;
  const REFRACTORY_MS   = 350;
  const MIN_INTERVAL_MS = 300;
  const MAX_INTERVAL_MS = 750;
  const SMOOTHING_ALPHA = 0.25;

  // Maternal range
  const MATERNAL_BPM_MIN = 50;
  const MATERNAL_BPM_MAX = 110;
  const MATERNAL_MIN_MS  = 60000 / MATERNAL_BPM_MAX; // ~545ms
  const MATERNAL_MAX_MS  = 60000 / MATERNAL_BPM_MIN; // 1200ms
  const MATERNAL_ALPHA   = 0.20;

  class BabyBeatEngine {
    constructor(els, aiConfig) {
      this.els = els;
      this.aiConfig = aiConfig || { enabled: false, endpoint: null };

      this.audioContext = null;
      this.microphone = null;
      this.analyser = null;
      this.dataArray = null;

      this.gainNode = null;
      this.bandpassFilter = null;
      this.compressor = null;
      this.monitorGain = null;
      this.mediaDest = null;
      this.mediaRecorder = null;
      this.recChunks = [];

      this.isListening = false;
      this.isMonitoring = false;
      this.isRecording = false;

      this.heartbeatTimes = [];
      this.lastBeatTime = 0;
      this.fetalBpm = 0;
      this.maternalBpm = 0;

      this.recentFloat = new Float32Array(0);
      this.maxRecentSamples = 0;
      this._previewGain = null;
      this._previewSource = null;

      this.noiseFloor = 0.001;
      this.signalEnvelope = 0;
      this.fastEnvelope = 0;

      this.channelMode = 'mix';
      this.sensitivity = 7;
      this.lastAiSendMs = 0;

      this.bindUI();
      this.updateSliderLabels();
    }

    // ---- Utility ----
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
        e.micType.addEventListener('change', () => {
          this.updateChannelMode();
        });
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

      if (e.start) e.start.addEventListener('click', () => this.startListening());
      if (e.stop) e.stop.addEventListener('click', () => this.stopListening());
      if (e.monitor) e.monitor.addEventListener('click', () => this.toggleMonitor());
      if (e.playEnhanced) e.playEnhanced.addEventListener('click', () => this.playEnhancedHeartbeat());
      if (e.record) e.record.addEventListener('click', () => this.toggleRecording());

      this.setButtons();
      this.updateBpmUI();
      this.applyMonitorLabel();
    }

    updateChannelMode() {
      const typeEl = this.els.micType;
      if (!typeEl) return;
      const v = typeEl.value;
      if (v === 'dji-mic-mini') this.channelMode = 'right';
      else if (v === 'professional' || v === 'stethoscope') this.channelMode = 'left';
      else this.channelMode = 'mix';
    }

    setButtons() {
      if (!this.els) return;
      if (this.els.start) this.els.start.disabled = this.isListening;
      if (this.els.stop) this.els.stop.disabled = !this.isListening;
      if (this.els.monitor) this.els.monitor.disabled = !this.isListening;
      if (this.els.playEnhanced) this.els.playEnhanced.disabled = !this.isListening;
      if (this.els.record) this.els.record.disabled = !this.isListening;
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

    setupAudioChain() {
      const sens = parseInt(this.els.sensitivity?.value || '7', 10);
      const filt = parseInt(this.els.filterFreq?.value || '60', 10);

      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = Math.max(0.1, sens * 3);

      this.bandpassFilter = this.audioContext.createBiquadFilter();
      this.bandpassFilter.type = 'bandpass';
      this.bandpassFilter.frequency.value = filt;
      this.bandpassFilter.Q.value = 3;

      this.compressor = this.audioContext.createDynamicsCompressor();
      this.compressor.threshold.value = -50;
      this.compressor.knee.value = 40;
      this.compressor.ratio.value = 12;
      this.compressor.attack.value = 0.003;
      this.compressor.release.value = 0.25;
    }

    setupRecorder(stream) {
      try {
        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';

        this.mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
        this.recChunks = [];

        this.mediaRecorder.ondataavailable = evt => {
          if (evt.data && evt.data.size) this.recChunks.push(evt.data);
        };

        this.mediaRecorder.onstop = () => {
          const blob = new Blob(this.recChunks, { type: this.mediaRecorder.mimeType });
          const url = URL.createObjectURL(blob);
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

        this.microphone.connect(this.gainNode);
        this.gainNode.connect(this.bandpassFilter);
        this.bandpassFilter.connect(this.compressor);

        // Monitor (off by default)
        this.compressor.connect(this.monitorGain);
        this.monitorGain.connect(this.audioContext.destination);
        this.monitorGain.disconnect(this.audioContext.destination);
        this.isMonitoring = false;
        this.applyMonitorLabel();

        // Analyser + recorder taps
        this.compressor.connect(this.analyser);
        this.mediaDest = this.audioContext.createMediaStreamDestination();
        this.compressor.connect(this.mediaDest);
        this.setupRecorder(this.mediaDest.stream);

        this.dataArray = new Uint8Array(this.analyser.fftSize);
        this.maxRecentSamples = Math.floor(this.audioContext.sampleRate * 1.2);
        this.recentFloat = new Float32Array(0);

        this.isListening = true;
        this.setButtons();
        this.setStatus('Listening for heartbeat… (use headphones for Monitor)');
        this.heartbeatTimes = [];
        this.lastBeatTime = 0;
        this.fetalBpm = 0;
        this.maternalBpm = 0;
        this.updateBpmUI();

        this.processAudio();
      } catch (err) {
        console.error(err);
        this.setStatus('Error: ' + err.message);
        this.isListening = false;
        this.setButtons();
      }
    }

    processAudio() {
      if (!this.isListening || !this.analyser) return;

      // Byte data for simple waveform + peak
      this.analyser.getByteTimeDomainData(this.dataArray);

      let peak = 0;
      let sum = 0;
      for (let i = 0; i < this.dataArray.length; i++) {
        const amp = Math.abs(this.dataArray[i] - 128) / 128;
        sum += amp;
        if (amp > peak) peak = amp;
      }
      const avg = sum / this.dataArray.length;

      // Visual: adjust "waveform" div height and glow
      if (this.els.waveform) {
        const h = Math.min(avg * 100, 50);
        this.els.waveform.style.height = h + 'px';
        this.els.waveform.style.boxShadow = `0 0 ${h}px rgba(255,127,127,.45)`;
      }

      // Float data for enhanced playback + optional AI
      const f32 = new Float32Array(this.analyser.fftSize);
      this.analyser.getFloatTimeDomainData(f32);
      this.appendRecentFloat(f32);

      // Simple amplitude-based detection, as in original
      const threshold = 0.18;
      const rising = peak > threshold;
      const now = Date.now();
      const sinceLast = now - this.lastBeatTime;

      // Basic envelopes (for potential AI/quality)
      const energy = rmsFromFloat(f32);
      this.noiseFloor = ema(this.noiseFloor, energy * 0.3, 0.001);
      this.signalEnvelope = ema(this.signalEnvelope, energy, 0.2);
      this.fastEnvelope = ema(this.fastEnvelope, energy, 0.35);
      const snr = calcSNR(this.signalEnvelope, this.noiseFloor);

      if (rising && sinceLast > REFRACTORY_MS) {
        this.registerBeat(now, peak, avg, snr);
        this.lastBeatTime = now;
      }

      // Optional AI hook
      if (this.aiConfig.enabled && this.aiConfig.endpoint && now - this.lastAiSendMs > 1000) {
        this.lastAiSendMs = now;
        this.sendChunkToAI(f32).catch(() => {});
      }

      requestAnimationFrame(() => this.processAudio());
    }

    appendRecentFloat(f32) {
      const old = this.recentFloat;
      const want = Math.min(this.maxRecentSamples, old.length + f32.length);
      const out = new Float32Array(want);
      const tail = Math.min(old.length, want - f32.length);
      if (tail > 0) out.set(old.subarray(old.length - tail), 0);
      out.set(f32.subarray(f32.length - (want - tail)), tail);
      this.recentFloat = out;
    }

    registerBeat(ts, peak, avgAmp, snr) {
      this.heartbeatTimes.push(ts);
      if (this.heartbeatTimes.length > 20) this.heartbeatTimes.shift();

      this.pulseAnimation();

      if (this.heartbeatTimes.length < 3) return;

      const intervals = [];
      for (let i = 1; i < this.heartbeatTimes.length; i++) {
        intervals.push(this.heartbeatTimes[i] - this.heartbeatTimes[i - 1]);
      }

      // Fetal BPM (fast window)
      this.fetalBpm = computeBpmWindow(
        intervals,
        MIN_INTERVAL_MS,
        MAX_INTERVAL_MS,
        this.fetalBpm,
        SMOOTHING_ALPHA,
        MAX_FETAL_BPM
      );

      // Maternal BPM (slower window)
      this.maternalBpm = computeBpmWindow(
        intervals,
        MATERNAL_MIN_MS,
        MATERNAL_MAX_MS,
        this.maternalBpm,
        MATERNAL_ALPHA,
        MATERNAL_BPM_MAX
      );

      this.updateBpmUI();

      const fetalStr = this.fetalBpm
        ? `${Math.round(this.fetalBpm)} BPM` +
          (this.fetalBpm >= 120 && this.fetalBpm <= 160 ? ' (typical fetal range)' : ' (fetal candidate)')
        : '—';

      const maternalStr = this.maternalBpm
        ? `${Math.round(this.maternalBpm)} BPM (likely maternal)`
        : '—';

      this.setStatus(
        `Fetal: ${fetalStr} • Maternal: ${maternalStr} — Educational use only, not a medical device.`
      );
    }

    pulseAnimation() {
      const pulse = this.els.pulse;
      if (!pulse) return;
      pulse.style.animation = 'heartbeat .6s ease-in-out';
      setTimeout(() => {
        pulse.style.animation = 'none';
      }, 600);
    }

    updateBpmUI() {
      const fetalDisplay = this.fetalBpm ? Math.round(this.fetalBpm) : null;
      const maternalDisplay = this.maternalBpm ? Math.round(this.maternalBpm) : null;

      if (this.els.bpm) {
        if (fetalDisplay) {
          this.els.bpm.textContent = `${fetalDisplay} BPM`;
        } else if (maternalDisplay) {
          this.els.bpm.textContent = `${maternalDisplay} BPM (likely maternal)`;
        } else {
          this.els.bpm.textContent = '-- BPM';
        }
      }

      if (this.els.bpmMaternal) {
        this.els.bpmMaternal.textContent = maternalDisplay
          ? `Maternal: ${maternalDisplay} BPM (likely maternal)`
          : 'Maternal: --';
      }
    }

    async playEnhancedHeartbeat() {
      try {
        if (!this.audioContext) {
          this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioContext.state === 'suspended') await this.audioContext.resume();

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

        const bpm = (this.fetalBpm && this.fetalBpm >= 80 && this.fetalBpm <= 200)
          ? this.fetalBpm
          : 140;
        const iv = 60 / bpm;
        const now = this.audioContext.currentTime;
        const loops = 6;
        for (let n = 0; n < loops; n++) {
          const src = this.audioContext.createBufferSource();
          src.buffer = buffer;
          src.connect(this._previewGain);
          src.start(now + n * iv);
          if (n === loops - 1) this._previewSource = src;
        }
      } catch (err) {
        console.error(err);
        this.setStatus('Playback error: ' + err.message);
      }
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

    async stopListening() {
      this.isListening = false;

      const nodes = [
        this.microphone,
        this.gainNode,
        this.bandpassFilter,
        this.compressor,
        this.analyser,
        this.monitorGain
      ];
      nodes.forEach(n => { try { n && n.disconnect && n.disconnect(); } catch {} });

      if (this.audioContext) {
        try { if (this.audioContext.state !== 'closed') await this.audioContext.close(); } catch {}
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

      this.setButtons();
      this.updateBpmUI();

      if (this.els.waveform) {
        this.els.waveform.style.height = '2px';
        this.els.waveform.style.boxShadow = 'none';
      }
      this.setStatus('Stopped listening');
    }

    async sendChunkToAI(floatBuffer) {
      try {
        if (!this.aiConfig || !this.aiConfig.enabled || !this.aiConfig.endpoint || !this.audioContext) return;
        const sampleRate = this.audioContext.sampleRate || 44100;
        const payload = {
          sampleRate,
          chunk: Array.from(floatBuffer.filter((_, i) => i % 4 === 0)).slice(0, 1024),
          fetalBpm: this.fetalBpm || null,
          maternalBpm: this.maternalBpm || null
        };
        await fetch(this.aiConfig.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).catch(() => {});
      } catch (e) {
        console.warn('[babybeat-ai] send error', e);
      }
    }
  }

  // ---- Small helpers for module ----
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

  function rmsFromFloat(buf) {
    if (!buf || !buf.length) return 0;
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  function calcSNR(signal, noise) {
    if (noise <= 0) return 0;
    return 20 * Math.log10(signal / noise);
  }

  function computeBpmWindow(intervals, minMs, maxMs, prevBpm, alpha, capBpm) {
    const clean = intervals.filter(ms => ms >= minMs && ms <= maxMs);
    if (clean.length < 2) return prevBpm || 0;

    const sorted = clean.slice().sort((a, b) => a - b);
    const cut = Math.max(1, Math.floor(sorted.length * 0.2));
    const trimmed = sorted.slice(cut, sorted.length - cut);
    const base = trimmed.length ? trimmed : sorted;

    const avgMs = base.reduce((a, b) => a + b, 0) / base.length;
    let rawBpm = 60000 / avgMs;
    if (!isFinite(rawBpm) || rawBpm <= 0) return prevBpm || 0;

    let bpm = prevBpm
      ? alpha * rawBpm + (1 - alpha) * prevBpm
      : rawBpm;

    if (capBpm) bpm = Math.min(bpm, capBpm);
    return bpm;
  }

  // Instantiate engine & expose minimal API
  const engine = new BabyBeatEngine(els, aiConfig);

  return {
    start: () => engine.startListening(),
    stop: () => engine.stopListening(),
    toggleMonitor: () => engine.toggleMonitor(),
    startRecording: () => engine.toggleRecording(), // starts if stopped
    stopRecording: () => engine.toggleRecording(),   // stops if recording
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

