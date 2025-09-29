// public/babybeat-core.js — core logic (enhanced; compatible API)
export async function initBabyBeat (opts) {
  const q = (sel) => document.querySelector(sel);
  const els = mapSelectors(opts.elements || {});
  const licenseOk = await (opts.licenseValidator?.() ?? true);
  if (!licenseOk) throw new Error('License check failed');

  // ---------- Tunables (safe defaults) ----------
  const MIN_FETAL_BPM = 100, MAX_FETAL_BPM = 170;
  const REFRACTORY_MS = 260;             // prevents double-peaks
  const MIN_INTERVAL_MS = 300;           // 200 BPM ceiling
  const MAX_INTERVAL_MS = 1200;          // 50 BPM floor
  const INTERVAL_TOLERANCE = 0.12;       // ±12% variation allowed
  const MIN_BEATS_TO_CONFIRM = 4;        // require N consistent beats
  const SMOOTHING_ALPHA = 0.25;          // EMA for amplitude display
  const ANALYSER_FFT = 1024;             // like your original
  const ANALYSER_SMOOTHING = 0.85;

  // ---------- Audio + state ----------
  let audioCtx, mediaStream, mediaSrc, hp, lp, comp, analyser, monitorGain, procDest, mediaRecorder;
  let isRunning=false, monitoring=false, recording=false, ema=0, drawRAF=0;
  let bpm=0;

  // ---------- Beat tracker (minimum-beat + tolerance) ----------
  class BeatTracker {
    constructor({
      minBeats = MIN_BEATS_TO_CONFIRM,
      tolerance = INTERVAL_TOLERANCE,
      minInterval = MIN_INTERVAL_MS,
      maxInterval = MAX_INTERVAL_MS,
      refractory = REFRACTORY_MS
    } = {}) {
      this.minBeats = minBeats;
      this.tolerance = tolerance;
      this.minInterval = minInterval;
      this.maxInterval = maxInterval;
      this.refractory = refractory;

      this._lastBeatAt = 0;
      this._state = 'below';
      this._peak = 0;
      this.thresholdRise = 0.12;
      this.thresholdFall = 0.08;

      this.intervals = [];
      this.hasPattern = false;
      this.bpm = null;
      this.confidence = 0;
    }

    process(level, now = performance.now()) {
      const rising  = (this._state === 'below' && level > this._peak + this.thresholdRise);
      const falling = (this._state === 'above' && level < this._peak - this.thresholdFall);
      let beat = false;

      if (rising) {
        this._state = 'above';
        this._peak = level;
      } else if (this._state === 'above') {
        if (level > this._peak) this._peak = level;
        if (falling) {
          const dt = now - this._lastBeatAt;
          if (dt > this.refractory && dt >= this.minInterval && dt <= this.maxInterval) {
            this._lastBeatAt = now;
            this._register(dt);
            beat = true;
          }
          this._state = 'below';
          this._peak *= 0.8;
        }
      } else {
        this._peak = Math.max(0, this._peak * 0.98);
        if (level > this._peak) this._peak = level;
      }

      return { beat, bpm: this.bpm, hasPattern: this.hasPattern, confidence: this.confidence };
    }

    _register(dt) {
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
          this.bpm = Math.min(MAX_FETAL_BPM, Math.max(MIN_FETAL_BPM, this.bpm));
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
      this._state = 'below';
      this._peak = 0;
      this.intervals.length = 0;
      this.hasPattern = false;
      this.bpm = null;
      this.confidence = 0;
    }
  }

  // ---------- Visualiser (canvas injected into #waveform) ----------
  class ECGVis {
    constructor(containerEl) {
      this.host = containerEl;
      this.canvas = document.createElement('canvas');
      this.canvas.style.position = 'absolute';
      this.canvas.style.inset = '0';
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
      this.canvas.style.pointerEvents = 'none';
      this.host.style.position = this.host.style.position || 'relative';
      this.host.appendChild(this.canvas);

      this.ctx = this.canvas.getContext('2d');
      this.width = 0;
      this.height = 0;
      this.buffer = new Float32Array(0);
      this.head = 0;
      this.base = 0;
      this.scale = 0;
      this.decay = 0.95;
      this.spike = 0;

      const onResize = () => {
        const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
        const rect = this.host.getBoundingClientRect();
        const w = Math.max(200, Math.floor(rect.width * dpr));
        const h = Math.max(100, Math.floor(rect.height * dpr));
        if (w !== this.canvas.width || h !== this.canvas.height) {
          this.canvas.width = w;
          this.canvas.height = h;
          this.width = w;
          this.height = h;
          this.buffer = new Float32Array(this.width).fill(0);
          this.head = 0;
          this.base = this.height * 0.55;
          this.scale = this.height * 0.35;
        }
      };
      onResize();
      window.addEventListener('resize', onResize);
      this._onResize = onResize;
    }

    push(level, beat) {
      const t = performance.now() * 0.004;
      let y = Math.sin(t) * 0.03;
      y += level * 0.15;
      if (beat) this.spike = 1.0;
      if (this.spike > 0) {
        y += this.spike * 0.9;
        this.spike *= this.decay;
        if (this.spike < 0.01) this.spike = 0;
      }
      if (this.buffer.length) {
        this.buffer[this.head] = y;
        this.head = (this.head + 1) % this.buffer.length;
      }
    }

    render(locked) {
      const { ctx, width, height, buffer, head, base, scale } = this;
      if (!width || !height || !buffer.length) return;
      ctx.clearRect(0, 0, width, height);

      // grid
      ctx.globalAlpha = 0.18;
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < width; x += 35) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, height); }
      for (let y = 0; y < height; y += 35) { ctx.moveTo(0, y + 0.5); ctx.lineTo(width, y + 0.5); }
      ctx.stroke();
      ctx.globalAlpha = 1;

      // trace
      ctx.strokeStyle = locked ? '#16a34a' : '#64748b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < buffer.length; i++) {
        const idx = (head + i) % buffer.length;
        const x = i;
        const y = base - buffer[idx] * scale;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    destroy() {
      window.removeEventListener('resize', this._onResize);
      this.canvas.remove();
    }
  }

  // ---------- Utils ----------
  function mapSelectors(map){ const o={}; for(const k of Object.keys(map)) o[k]=q(map[k]); return o; }
  function setStatus(t){ if(els.status) els.status.textContent=t; }
  function median(arr) {
    if (!arr.length) return 0;
    const a = [...arr].sort((x,y)=>x-y);
    const m = Math.floor(a.length/2);
    return a.length % 2 ? a[m] : (a[m-1]+a[m])/2;
  }
  function SMOOTH(prev,val,alpha){ return prev + alpha*(val-prev); }
  function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

  // ---------- UI wiring (unchanged) ----------
  initUI();
  return { start, stop, toggleMonitor, startRecording, stopRecording, setFilterHz, setSensitivity, setMonitorVol };

  function initUI(){
    els.filterFreq.addEventListener('input', ()=>{
      const hz=parseInt(els.filterFreq.value,10);
      els.filterValue.textContent=`${hz} Hz`;
      if(lp) lp.frequency.setTargetAtTime(hz,audioCtx?.currentTime||0,0.01);
    });
    els.sensitivity.addEventListener('input', ()=>{ els.sensitivityValue.textContent=els.sensitivity.value; });
    els.monitorVol.addEventListener('input', ()=>{ els.monitorVolValue.textContent=`${els.monitorVol.value}%`; if(monitorGain) monitorGain.gain.value=parseInt(els.monitorVol.value,10)/100; });
    els.start.addEventListener('click', start); els.stop.addEventListener('click', stop);
    els.monitor.addEventListener('click', toggleMonitor); els.playEnhanced.addEventListener('click', playEnhancedSample);
    els.record.addEventListener('click', ()=> (recording ? stopRecording() : startRecording()));
  }

  // ---------- Start/Stop ----------
  let vis = null;
  let tracker = null;

  async function start(){
    if(isRunning) return;
    try{
      mediaStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
      audioCtx=new (window.AudioContext||window.webkitAudioContext)({ sampleRate:48000 });
      mediaSrc=audioCtx.createMediaStreamSource(mediaStream);

      // Filters & dynamics (as before)
      hp=audioCtx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=10;
      lp=audioCtx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=parseInt(els.filterFreq.value,10)||60;
      comp=audioCtx.createDynamicsCompressor(); comp.threshold.value=-28; comp.knee.value=20; comp.ratio.value=6; comp.attack.value=0.003; comp.release.value=0.25;

      analyser=audioCtx.createAnalyser();
      analyser.fftSize = ANALYSER_FFT;
      analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;

      monitorGain=audioCtx.createGain(); monitorGain.gain.value=parseInt(els.monitorVol.value,10)/100;
      procDest=audioCtx.createMediaStreamDestination();

      // graph
      mediaSrc.connect(hp).connect(lp).connect(comp);
      comp.connect(analyser);
      comp.connect(procDest);
      comp.connect(monitorGain).connect(audioCtx.destination);

      // UI enable
      els.start.disabled=true; els.stop.disabled=false; els.monitor.disabled=false; els.playEnhanced.disabled=false; els.record.disabled=false; setStatus('Listening…');
      isRunning=true;

      // Prepare buffers & helpers
      const buf=new Float32Array(analyser.fftSize);
      tracker = new BeatTracker();
      vis = new ECGVis(els.waveform);

      // draw loop
      const drawLoop = () => {
        if(!isRunning) return;

        // amplitude / level
        analyser.getFloatTimeDomainData(buf);
        let peak = 0;
        for (let i=0;i<buf.length;i++){ const v=Math.abs(buf[i]); if(v>peak) peak=v; }

        const sens = parseInt(els.sensitivity.value,10);
        const threshold = 0.02 * (11 - sens);       // your original threshold curve
        ema = SMOOTH(ema, peak, SMOOTHING_ALPHA);

        // Beat tracking against dynamic threshold:
        // Convert EMA vs threshold -> normalized level 0..1 for detection
        const level = Math.max(0, Math.min(1, (ema - threshold) * 12)); // scale a bit for sensitivity
        const { beat, bpm: lockBpm, hasPattern, confidence } = tracker.process(level, performance.now());

        // Only show BPM after pattern is confirmed
        if (hasPattern && lockBpm) {
          bpm = lockBpm;
          els.bpm.textContent = `${bpm} BPM`;
        } else {
          const need = Math.max(0, tracker.minBeats - 1 - tracker.intervals.length);
          els.bpm.textContent = need > 0 ? `-- BPM` : `-- BPM`;
        }

        // Pulse effect on confirmed beats (kept from your original)
        if (beat && hasPattern) pulse();

        // Move the existing waveform block subtly (visual feedback)
        const y = Math.min(48, Math.max(-48, (ema - threshold) * 600));
        els.waveform.style.transform = `translateY(calc(-50% + ${y}px))`;

        // Render ECG canvas inside #waveform
        vis.push(level, beat && hasPattern);
        vis.render(hasPattern);

        drawRAF = requestAnimationFrame(drawLoop);
      };
      drawRAF = requestAnimationFrame(drawLoop);

    }catch(e){
      console.error(e);
      setStatus('Mic permission denied or unavailable.');
    }
  }

  function stop(){
    if(!isRunning) return;
    cancelAnimationFrame(drawRAF); drawRAF=0;
    isRunning=false; ema=0; bpm=0;
    tracker?.reset?.();
    if (vis) { vis.destroy(); vis = null; }

    els.bpm.textContent='-- BPM';
    try{mediaStream?.getTracks().forEach(t=>t.stop())}catch{}
    try{audioCtx?.close()}catch{}

    monitoring=false; if(els.monitor) els.monitor.textContent='Monitor: Off';
    els.start.disabled=false; els.stop.disabled=true;
    els.monitor.disabled=true; els.playEnhanced.disabled=true; els.record.disabled=true;
    setStatus('Stopped.');
  }

  // ---------- Monitor / Recording / Controls (unchanged API) ----------
  function toggleMonitor(){ if(!audioCtx) return; monitoring=!monitoring;
    monitorGain.gain.value=monitoring?(parseInt(els.monitorVol.value,10)/100):0; els.monitor.textContent=`Monitor: ${monitoring?'On':'Off'}`; }

  async function playEnhancedSample(){ if(!audioCtx) return; const tmp=audioCtx.createGain(); tmp.gain.value=0.9; comp.connect(tmp).connect(audioCtx.destination); await wait(1800); tmp.disconnect(); }

  async function startRecording(){
    if(!procDest) return;
    mediaRecorder=new MediaRecorder(procDest.stream,{mimeType:'audio/webm;codecs=opus'});
    const chunks=[];
    mediaRecorder.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop=()=>{ const blob=new Blob(chunks,{type:'audio/webm'}); const url=URL.createObjectURL(blob); els.playbackAudio.src=url; els.downloadLink.href=url; els.playbackArea.style.display='block'; };
    mediaRecorder.start(); recording=true; els.record.textContent='Stop Recording';
  }
  function stopRecording(){ if(!recording) return; mediaRecorder?.stop(); recording=false; els.record.textContent='Start Recording'; }

  function setFilterHz(hz){ if(lp) lp.frequency.value=hz; }
  function setSensitivity(v){ els.sensitivity.value=String(v); els.sensitivityValue.textContent=String(v); }
  function setMonitorVol(pct){ if(monitorGain) monitorGain.gain.value=pct/100; els.monitorVol.value=String(pct); els.monitorVolValue.textContent=`${pct}%`; }

  // ---------- Small visual pulse (kept) ----------
  function pulse(){
    if(!els.pulse) return;
    els.pulse.style.animation='none'; void els.pulse.offsetWidth; els.pulse.style.animation='heartbeat .6s ease';
    const s=document.createElement('style');
    s.textContent='@keyframes heartbeat{0%,100%{transform:translate(-50%,-50%) scale(1);opacity:.8}50%{transform:translate(-50%,-50%) scale(1.3);opacity:1}}';
    document.head.appendChild(s);
    setTimeout(()=>s.remove(),700);
  }
}
