/**
 * babybeat-core.js — Baby Heartbeat Detector Pro (drop-in)
 * --------------------------------------------------------
 * - Requires a minimum number of consistent beats before "locking" a heartbeat
 * - ECG-style scrolling visualiser; turns green when a stable pattern is found
 * - Simple API: BabyBeat.start(), BabyBeat.stop(), BabyBeat.config (optional)
 *
 * Usage in HTML:
 *   <canvas id="hbCanvas" width="700" height="130"
 *           style="width:100%;max-width:720px;height:130px;display:block;margin:8px auto;"></canvas>
 *   <div style="text-align:center;font:600 14px/1.6 system-ui,-apple-system,Segoe UI,Roboto,Arial;">
 *     <span id="hbStatus">Listening…</span>
 *   </div>
 *   <script src="babybeat-core.js"></script>
 *   <button onclick="BabyBeat.start()">Start</button>
 *   <button onclick="BabyBeat.stop()">Stop</button>
 */

(function () {
  // =========================
  // Default configuration (you can override via BabyBeat.config = {...})
  // =========================
  const DEFAULTS = {
    analyserFftSize: 2048,          // larger = smoother RMS
    analyserSmoothing: 0.85,
    rmsBoost: 2.2,                  // scales RMS into roughly [0..1]
    minBeatsToConfirm: 4,           // require N consistent beats
    intervalTolerance: 0.12,        // ±12% beat-to-beat interval tolerance
    refractoryMs: 260,              // ignore double-triggers for ~0.26s
    minIntervalMs: 300,             // 200 BPM ceiling
    maxIntervalMs: 1200,            // 50 BPM floor
    canvasId: 'hbCanvas',
    statusId: 'hbStatus',

    // Optional gentle band-pass (helps some mics). Set enableFilter to true to use.
    enableFilter: false,
    hpFreq: 50,                     // high-pass at 50 Hz
    lpFreq: 300,                    // low-pass at 300 Hz

    debug: false
  };

  // Will be merged into on start()
  let CONFIG = { ...DEFAULTS };

  // =========================
  // Utilities
  // =========================
  function median(arr) {
    if (!arr.length) return 0;
    const a = [...arr].sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  // Compute RMS from time-domain waveform (roughly 0..1).
  function getRmsOrEnvelope(analyser, boost = 2.0) {
    const bufLen = analyser.fftSize;
    if (!getRmsOrEnvelope._data || getRmsOrEnvelope._data.length !== bufLen) {
      getRmsOrEnvelope._data = new Uint8Array(bufLen);
    }
    const data = getRmsOrEnvelope._data;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < bufLen; i++) {
      const v = (data[i] - 128) / 128; // -1..1
      sum += v * v;
    }
    const rms = Math.sqrt(sum / bufLen); // ~0..1
    return Math.max(0, Math.min(1, rms * boost));
  }

  // =========================
  // Beat tracking with minimum-consistency requirement
  // =========================
  class BeatTracker {
    constructor(opts = {}) {
      this.minBeats = opts.minBeats ?? 4;
      this.tolerance = opts.tolerance ?? 0.12;
      this.minIntervalMs = opts.minIntervalMs ?? 300;
      this.maxIntervalMs = opts.maxIntervalMs ?? 1200;
      this.refractoryMs = opts.refractoryMs ?? 250;
      this.thresholdRise = opts.thresholdRise ?? 0.12; // hysteresis
      this.thresholdFall = opts.thresholdFall ?? 0.08;

      this._lastBeatAt = 0;
      this._lastPeakLevel = 0;
      this._state = 'below'; // 'below' | 'above'
      this.intervals = [];
      this.bpm = null;
      this.hasPattern = false;
      this.confidence = 0;
    }

    // level: 0..1, nowMs optional (performance.now())
    process(level, nowMs) {
      const t = nowMs ?? performance.now();
      const rising = (this._state === 'below' && level > this._lastPeakLevel + this.thresholdRise);
      const falling = (this._state === 'above' && level < this._lastPeakLevel - this.thresholdFall);
      let beat = false;

      if (rising) {
        this._state = 'above';
        this._lastPeakLevel = level;
      } else if (this._state === 'above') {
        if (level > this._lastPeakLevel) this._lastPeakLevel = level;

        if (falling) {
          const dt = t - this._lastBeatAt;
          if (dt > this.refractoryMs && dt >= this.minIntervalMs && dt <= this.maxIntervalMs) {
            this._lastBeatAt = t;
            this._registerInterval(dt);
            beat = true;
          }
          this._state = 'below';
          this._lastPeakLevel *= 0.8; // decay memory
        }
      } else {
        // 'below': track baseline softly
        this._lastPeakLevel = Math.max(0, this._lastPeakLevel * 0.98);
        if (level > this._lastPeakLevel) this._lastPeakLevel = level;
      }

      return { beat, bpm: this.bpm, hasPattern: this.hasPattern, confidence: this.confidence };
    }

    _registerInterval(dt) {
      this.intervals.push(dt);
      if (this.intervals.length > 10) this.intervals.shift();

      if (this.intervals.length >= this.minBeats - 1) {
        const recent = this.intervals.slice(-(this.minBeats - 1));
        const med = median(recent);
        const ok = recent.every(i => Math.abs(i - med) <= this.tolerance * med);
        this.hasPattern = ok;

        if (ok) {
          const sm = median(this.intervals.slice(-6));
          this.bpm = Math.round(60000 / sm);
          // Confidence rises with more consistent intervals
          this.confidence = Math.min(1, (this.intervals.length / 10) * 0.8 + 0.2);
        } else {
          this.bpm = null;
          this.confidence = 0;
        }
      } else {
        this.hasPattern = false;
        this.bpm = null;
        this.confidence = 0;
      }
    }

    reset() {
      this._lastBeatAt = 0;
      this._lastPeakLevel = 0;
      this._state = 'below';
      this.intervals.length = 0;
      this.bpm = null;
      this.hasPattern = false;
      this.confidence = 0;
    }
  }

  // =========================
  // ECG-style Visualiser (Canvas)
  // =========================
  class HeartbeatVisualizer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.width = canvas.width;
      this.height = canvas.height;
      this.bufferLen = Math.floor(this.width);
      this.trace = new Float32Array(this.bufferLen).fill(0);
      this.head = 0;
      this.base = this.height * 0.55;
      this.scale = this.height * 0.35;
      this.decay = 0.95;
      this.spike = 0;
    }

    resize(width, height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.width = width;
      this.height = height;
      this.bufferLen = Math.floor(width);
      this.trace = new Float32Array(this.bufferLen).fill(0);
      this.head = 0;
      this.base = this.height * 0.55;
      this.scale = this.height * 0.35;
    }

    push(level, beat) {
      // subtle baseline drift
      const t = performance.now() * 0.004;
      let y = Math.sin(t) * 0.03;

      // couple audio level slightly into baseline
      y += level * 0.15;

      // spike on beat
      if (beat) this.spike = 1.0;
      if (this.spike > 0) {
        y += this.spike * 0.9;
        this.spike *= this.decay;
        if (this.spike < 0.01) this.spike = 0;
      }

      this.trace[this.head] = y;
      this.head = (this.head + 1) % this.bufferLen;
    }

    render(hasPattern) {
      const { ctx, width, height, trace, head, base, scale } = this;
      ctx.clearRect(0, 0, width, height);

      // grid
      ctx.globalAlpha = 0.2;
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < width; x += 35) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, height);
      }
      for (let y = 0; y < height; y += 35) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(width, y + 0.5);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      // trace
      ctx.strokeStyle = hasPattern ? '#16a34a' : '#64748b'; // green when locked
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < trace.length; i++) {
        const idx = (head + i) % trace.length;
        const x = i;
        const y = base - trace[idx] * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    clear() {
      this.ctx.clearRect(0, 0, this.width, this.height);
      this.trace.fill(0);
      this.head = 0;
    }
  }

  // =========================
  // Main runtime (namespaced as window.BabyBeat)
  // =========================
  const BabyBeat = {
    // allow overrides before start(): BabyBeat.config = {...}
    config: { ...DEFAULTS },

    _ctx: null,
    _stream: null,
    _analyser: null,
    _source: null,
    _nodes: [],
    _raf: 0,
    _running: false,
    _tracker: null,
    _vis: null,
    _statusEl: null,

    async start() {
      if (this._running) return;

      // Merge runtime config (defaults < current config)
      CONFIG = { ...DEFAULTS, ...this.config };

      try {
        this._status('Requesting microphone…');
        this._stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          video: false
        });

        this._ctx = this._ctx || new (window.AudioContext || window.webkitAudioContext)();
        if (this._ctx.state === 'suspended') await this._ctx.resume();

        this._source = this._ctx.createMediaStreamSource(this._stream);

        // Optional filter chain
        let inputNode = this._source;
        if (CONFIG.enableFilter) {
          const hp = this._ctx.createBiquadFilter();
          hp.type = 'highpass';
          hp.frequency.value = CONFIG.hpFreq;

          const lp = this._ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.value = CONFIG.lpFreq;

          inputNode.connect(hp);
          hp.connect(lp);
          inputNode = lp;
          this._nodes.push(hp, lp);
        }

        this._analyser = this._ctx.createAnalyser();
        this._analyser.fftSize = CONFIG.analyserFftSize;
        this._analyser.smoothingTimeConstant = CONFIG.analyserSmoothing;

        inputNode.connect(this._analyser);

        // Visuals + tracker
        const canvas = document.getElementById(CONFIG.canvasId) || this._autoCanvas();
        this._vis = new HeartbeatVisualizer(canvas);
        this._statusEl = document.getElementById(CONFIG.statusId) || null;
        this._tracker = new BeatTracker({
          minBeats: CONFIG.minBeatsToConfirm,
          tolerance: CONFIG.intervalTolerance,
          minIntervalMs: CONFIG.minIntervalMs,
          maxIntervalMs: CONFIG.maxIntervalMs,
          refractoryMs: CONFIG.refractoryMs
        });

        // Crisp resize on DPR changes
        const resize = () => {
          const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
          const cssW = canvas.clientWidth || 700;
          const cssH = canvas.clientHeight || 130;
          const w = Math.floor(cssW * dpr);
          const h = Math.floor(cssH * dpr);
          if (canvas.width !== w || canvas.height !== h) {
            this._vis.resize(w, h);
            canvas.style.width = cssW + 'px';
            canvas.style.height = cssH + 'px';
          }
        };
        resize();
        window.addEventListener('resize', resize);

        this._running = true;
        this._status('Listening…');
        this._tick();

      } catch (err) {
        console.error(err);
        this._status('Microphone permission denied or unavailable.');
      }
    },

    async stop() {
      if (!this._running) return;
      cancelAnimationFrame(this._raf);
      this._raf = 0;
      this._running = false;

      if (this._source) { try { this._source.disconnect(); } catch {} }
      if (this._analyser) { try { this._analyser.disconnect(); } catch {} }
      this._nodes.forEach(n => { try { n.disconnect(); } catch {} });
      this._nodes.length = 0;

      if (this._stream) {
        this._stream.getTracks().forEach(t => t.stop());
        this._stream = null;
      }
      if (this._vis) this._vis.clear();

      this._status('Stopped.');
    },

    _tick() {
      const loop = () => {
        if (!this._running) return;

        const level = getRmsOrEnvelope(this._analyser, CONFIG.rmsBoost);
        const { beat, bpm, hasPattern, confidence } = this._tracker.process(level, performance.now());

        this._vis.push(level, beat);
        this._vis.render(hasPattern);

        if (this._statusEl) {
          if (hasPattern && bpm) {
            const confPct = Math.round(confidence * 100);
            this._statusEl.textContent = `Heartbeat detected: ${bpm} BPM • Confidence ${confPct}%`;
          } else {
            const need = Math.max(0, this._tracker.minBeats - 1 - this._tracker.intervals.length);
            this._statusEl.textContent = need > 0
              ? `Listening… need ~${need} more beats to confirm`
              : 'Listening…';
          }
        }

        if (CONFIG.debug && beat) {
          console.log('Beat', { bpm, hasPattern, confidence: +confidence.toFixed(2) });
        }

        this._raf = requestAnimationFrame(loop);
      };
      this._raf = requestAnimationFrame(loop);
    },

    _status(text) {
      if (this._statusEl) this._statusEl.textContent = text;
    },

    _autoCanvas() {
      const c = document.createElement('canvas');
      c.id = CONFIG.canvasId;
      c.width = 700;
      c.height = 130;
      c.style.width = '100%';
      c.style.maxWidth = '720px';
      c.style.height = '130px';
      c.style.display = 'block';
      c.style.margin = '8px auto';
      (document.body || document.documentElement).appendChild(c);
      return c;
    }
  };

  // Expose globally (no module system assumptions)
  window.BabyBeat = BabyBeat;

  // Suspend/resume audio context on tab visibility changes
  document.addEventListener('visibilitychange', async () => {
    const ctx = BabyBeat._ctx;
    if (!ctx) return;
    if (document.hidden) {
      try { await ctx.suspend(); } catch {}
    } else {
      try { await ctx.resume(); } catch {}
    }
  });
})();
