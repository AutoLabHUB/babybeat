// public/babybeat-core.js — core logic (enhanced + robust mic handling)
// API stays the same:
//   export async function initBabyBeat(opts)
//   returns { start, stop, toggleMonitor, startRecording, stopRecording, setFilterHz, setSensitivity, setMonitorVol }

export async function initBabyBeat (opts) {
  const q = (sel) => document.querySelector(sel);
  const els = mapSelectors(opts.elements || {});
  const licenseOk = await (opts.licenseValidator?.() ?? true);
  if (!licenseOk) throw new Error('License check failed');

  // ---------- Tunables ----------
  const MIN_FETAL_BPM = 100, MAX_FETAL_BPM = 170;
  const REFRACTORY_MS = 260;             // avoid double-beats
  const MIN_INTERVAL_MS = 300;           // 200 BPM ceiling
  const MAX_INTERVAL_MS = 1200;          // 50 BPM floor
  const INTERVAL_TOLERANCE = 0.12;       // ±12% allowed variation
  const MIN_BEATS_TO_CONFIRM = 4;        // beats needed to "lock"
  const SMOOTHING_ALPHA = 0.25;          // EMA for amplitude display
  const ANALYSER_FFT = 1024;
  const ANALYSER_SMOOTHING = 0.85;

  // ---------- Audio graph state ----------
  let audioCtx, mediaStream, mediaSrc, hp, lp, comp, analyser, monitorGain, procDest, mediaRecorder;

  // ---------- Runtime state ----------
  let isRunning=false, monitoring=false, recording=false, ema=0, drawRAF=0;
  let bpm=0, tracker=null, vis=null;

  // ---------- Helpers ----------
  function mapSelectors(map){ const o={}; for(const k of Object.keys(map)) o[k]=q(map[k]); return o; }
  function setStatus(t){ if(els.status) els.status.textContent=t; }
  function SMOOTH(prev,val,alpha){ return prev + alpha*(val-prev); }
  function median(arr){ if(!arr.length) return 0; const a=[...arr].sort((x,y)=>x-y); const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
  function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

  // ---------- Beat tracker (minimum-beat requirement) ----------
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

  // ---------- Single-line gradient visualiser injected into #waveform ----------
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
      this.width = 0; this.height = 0;
      this.base = 0; this.scale = 0;
      this._prev = null; 

      const onResize = () => {
        const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
        const rect = this.host.getBoundingClientRect();
        const w = Math.max(200, Math.floor(rect.width * dpr));
        const h = Math.max(100, Math.floor(rect.height * dpr));
        if (w !== this.canvas.width || h !== this.canvas.height) {
          this.canvas.width = w; this.canvas.height = h;
          this.width = w; this.height = h;
          this.base = this.height * 0.55;
         this.scale = this.height * 0.55;   
        }
      };
      onResize();
      window.addEventListener('resize', onResize);
      this._onResize = onResize;
    }

    render(locked, scope, gain = 1) {
      const { ctx, width, height, base, scale } = this;
      if (!width || !height || !scope || !scope.length) return;
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

      // downsample + smooth
      const targetPts = Math.min(240, Math.floor(width));
      const stepIn    = Math.max(1, Math.floor(scope.length / targetPts));
      const g         = Math.max(0.8, Math.min(6, gain));   // visual-only gain
      const amp       = scale * 0.9 * g;

      const pts = [];
      for (let i = 0, x = 0; i < scope.length; i += stepIn, x += (width / targetPts)) {
        const s = scope[i];                     // 0..255
        const v = (s - 128) / 128;              // -1..1
        pts.push({ x, y: base + (-v) * amp });
      }
      // moving-average smooth (5-tap) for a calmer shape
for (let i = 2; i < pts.length - 2; i++) {
  pts[i].y = (pts[i-2].y + pts[i-1].y + pts[i].y + pts[i+1].y + pts[i+2].y) / 5;
}

// blend with previous frame for temporal stability
if (this._prev && this._prev.length === pts.length) {
  // 80% previous frame + 20% new frame → much steadier
  for (let i = 0; i < pts.length; i++) {
    pts[i].y = this._prev[i].y * 0.8 + pts[i].y * 0.2;
  }
}
// store current frame as “previous” for next time
this._prev = pts.map(p => ({ x: p.x, y: p.y }));

      }

      // gradient stroke
      const grad = ctx.createLinearGradient(0, 0, width, 0);
      grad.addColorStop(0.00, '#ff7a3d');  // orange
      grad.addColorStop(0.65, '#ffb03d');  // warm
      grad.addColorStop(1.00, '#e6ff00');  // yellow

      ctx.lineJoin = 'round';
      ctx.lineCap  = 'round';
      ctx.strokeStyle = grad;
      ctx.lineWidth = 3;

      // subtle glow when locked
      if (locked) {
        ctx.shadowColor = 'rgba(230,255,0,0.55)';
        ctx.shadowBlur  = 10;
      } else {
        ctx.shadowBlur = 0;
      }

      // Catmull-Rom → Bezier curve
      const tension = 0.5;
      ctx.beginPath();
      if (pts.length) ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] || pts[i];
        const p1 = pts[i];
        const p2 = pts[i + 1] || pts[i];
        const p3 = pts[i + 2] || p2;

        const cp1x = p1.x + (p2.x - p0.x) * (tension / 6);
        const cp1y = p1.y + (p2.y - p0.y) * (tension / 6);
        const cp2x = p2.x - (p3.x - p1.x) * (tension / 6);
        const cp2y = p2.y - (p3.y - p1.y) * (tension / 6);

        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
      }
      ctx.stroke();

      ctx.shadowBlur = 0; // reset
    }

    destroy() {
      window.removeEventListener('resize', this._onResize);
      this.canvas.remove();
    }
  }

  // ---------- UI wiring ----------
  initUI();
  return { start, stop, toggleMonitor, startRecording, stopRecording, setFilterHz, setSensitivity, setMonitorVol };

  function initUI(){
    els.filterFreq?.addEventListener('input', ()=>{
      const hz = parseInt(els.filterFreq.value,10);
      els.filterValue.textContent = `${hz} Hz`;
      if(lp) lp.frequency.setTargetAtTime(hz, audioCtx?.currentTime||0, 0.01);
    });
    els.sensitivity?.addEventListener('input', ()=>{ els.sensitivityValue.textContent = els.sensitivity.value; });
    els.monitorVol?.addEventListener('input', ()=>{ els.monitorVolValue.textContent = `${els.monitorVol.value}%`; if(monitorGain) monitorGain.gain.value = parseInt(els.monitorVol.value,10)/100; });
    els.start?.addEventListener('click', start); els.stop?.addEventListener('click', stop);
    els.monitor?.addEventListener('click', toggleMonitor); els.playEnhanced?.addEventListener('click', playEnhancedSample);
    els.record?.addEventListener('click', ()=> (recording ? stopRecording() : startRecording()));
  }

  // ---------- Mic compatibility helper ----------
  async function getMicStreamCompat() {
    if (!navigator.mediaDevices?.getUserMedia) {
      const err = new Error('getUserMedia not supported'); err.name = 'NotSupportedError'; throw err;
    }
    const primary = {
      audio: {
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        autoGainControl:   { ideal: false }
      }
    };
    try {
      return await navigator.mediaDevices.getUserMedia(primary);
    } catch (e) {
      // Fallback: simplest constraints
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    }
  }

  // ---------- Start / Stop ----------
  async function start(){
    if(isRunning) return;

    try{
      setStatus('Requesting microphone…');

      // 1) Acquire mic with compatible constraints (+fallback)
      mediaStream = await getMicStreamCompat();

      // 2) AudioContext without forcing sampleRate (fixes Safari/iOS issues)
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      // 3) Build graph
      mediaSrc = audioCtx.createMediaStreamSource(mediaStream);

      hp = audioCtx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=10;
      lp = audioCtx.createBiquadFilter(); lp.type='lowpass';  lp.frequency.value=parseInt(els.filterFreq.value,10)||60;

      comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value=-28; comp.knee.value=20; comp.ratio.value=6; comp.attack.value=0.003; comp.release.value=0.25;

      analyser = audioCtx.createAnalyser();
      analyser.fftSize = ANALYSER_FFT;
   analyser.smoothingTimeConstant = 0.96;


      monitorGain = audioCtx.createGain();
      monitorGain.gain.value = parseInt(els.monitorVol.value,10)/100;

      procDest = audioCtx.createMediaStreamDestination();

      mediaSrc.connect(hp).connect(lp).connect(comp);
      comp.connect(analyser);
      comp.connect(procDest);
      comp.connect(monitorGain).connect(audioCtx.destination);

      // UI enable
      els.start.disabled=true; els.stop.disabled=false; els.monitor.disabled=false; els.playEnhanced.disabled=false; els.record.disabled=false;
      setStatus('Listening…');
      isRunning=true;

      // Prepare buffers, tracker, visualiser
      const floatBuf = new Float32Array(analyser.fftSize); // for peak/EMA logic
      const scopeBuf  = new Uint8Array(analyser.fftSize);  // for on-screen waveform
      tracker = new BeatTracker();
      vis = new ECGVis(els.waveform);

      let scopeGain = 1; // visual-only gain

      // Draw loop
      const drawLoop = () => {
        if (!isRunning) return;

    
     // 1) Read analyser data
analyser.getFloatTimeDomainData(floatBuf);
let peak = 0, sumSq = 0;
for (let i = 0; i < floatBuf.length; i++) {
  const v = floatBuf[i];
  const av = Math.abs(v);
  if (av > peak) peak = av;
  sumSq += v * v;
}
const rms = Math.sqrt(sumSq / floatBuf.length);
analyser.getByteTimeDomainData(scopeBuf);

// 2) Thresholding / smoothing → level
const sens = parseInt(els.sensitivity.value, 10);
const threshold = 0.02 * (11 - sens);
ema = SMOOTH(ema, peak, SMOOTHING_ALPHA);

// Normalize 0..1 “level”
const level = Math.max(0, Math.min(1, (ema - threshold) * 12));

// 3) Beat tracking
const now = performance.now();
const { beat, bpm: lockBpm, hasPattern } = tracker.process(level, now);

// 4) BPM label
if (hasPattern && lockBpm) {
  bpm = lockBpm;
  els.bpm.textContent = `${bpm} BPM`;
} else {
  els.bpm.textContent = `-- BPM`;
}

// 5) Pulse on confirmed beats
if (beat && hasPattern) pulse();

// 6) Auto visual gain — smoother & with higher headroom
const signal = Math.max(peak, rms * 1.8); // rms is steadier than peak
const targetGain = Math.min(12, Math.max(1.2, 1.2 / Math.max(signal, 0.015)));
scopeGain = SMOOTH(scopeGain, targetGain, 0.06); // slower changes

// 7) Draw the waveform
vis.render(hasPattern, scopeBuf, scopeGain);


        drawRAF = requestAnimationFrame(drawLoop);
      };
      drawRAF = requestAnimationFrame(drawLoop);

    }catch(e){
      console.error('[start] failed:', e);
      const httpsHint = (!window.isSecureContext || location.protocol !== 'https:') ? ' • Use HTTPS or localhost' : '';
      const originHint = (location.hostname.endsWith('.vercel.app') ? '' : ' • Grant permission for this domain in browser settings');
      const nice = ({
        NotAllowedError:  'Microphone access was blocked by the browser',
        NotFoundError:    'No microphone was found',
        NotReadableError: 'Microphone is busy or not accessible by the system',
        OverconstrainedError: 'Requested audio constraints are not supported by this device',
        SecurityError:    'Microphone blocked due to security settings',
        AbortError:       'Microphone request was aborted',
        TypeError:        'Invalid media constraints'
      })[e.name] || 'Audio initialization failed';
      setStatus(`${nice}.${httpsHint}${originHint}`);
    }
  }

  function stop(){
    if(!isRunning) return;
    cancelAnimationFrame(drawRAF); drawRAF=0;
    isRunning=false; ema=0; bpm=0;
    tracker?.reset?.();
    if (vis) { vis.destroy(); vis = null; }

    els.bpm.textContent='-- BPM';
    try{ mediaStream?.getTracks().forEach(t=>t.stop()); }catch{}
    try{ audioCtx?.close(); }catch{}

    monitoring=false; if(els.monitor) els.monitor.textContent='Monitor: Off';
    els.start.disabled=false; els.stop.disabled=true;
    els.monitor.disabled=true; els.playEnhanced.disabled=true; els.record.disabled=true;
    setStatus('Stopped.');
  }

  // ---------- Monitor / Recording / Controls ----------
  function toggleMonitor(){ if(!audioCtx) return; monitoring=!monitoring;
    monitorGain.gain.value = monitoring ? (parseInt(els.monitorVol.value,10)/100) : 0;
    els.monitor.textContent = `Monitor: ${monitoring?'On':'Off'}`;
  }

  async function playEnhancedSample(){ if(!audioCtx) return; const tmp=audioCtx.createGain(); tmp.gain.value=0.9; comp.connect(tmp).connect(audioCtx.destination); await wait(1800); tmp.disconnect(); }

  async function startRecording(){
    if(!procDest) return;
    mediaRecorder = new MediaRecorder(procDest.stream,{ mimeType:'audio/webm;codecs=opus' });
    const chunks=[];
    mediaRecorder.ondataavailable = e => { if(e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob=new Blob(chunks,{type:'audio/webm'});
      const url=URL.createObjectURL(blob);
      els.playbackAudio.src=url; els.downloadLink.href=url; els.playbackArea.style.display='block';
    };
    mediaRecorder.start(); recording=true; els.record.textContent='Stop Recording';
  }

  function stopRecording(){ if(!recording) return; mediaRecorder?.stop(); recording=false; els.record.textContent='Start Recording'; }

  function setFilterHz(hz){ if(lp) lp.frequency.value = hz; }
  function setSensitivity(v){ els.sensitivity.value=String(v); els.sensitivityValue.textContent=String(v); }
  function setMonitorVol(pct){ if(monitorGain) monitorGain.gain.value=pct/100; els.monitorVol.value=String(pct); els.monitorVolValue.textContent=`${pct}%`; }

  // ---------- Visual pulse ----------
  function pulse(){
    if(!els.pulse) return;
    els.pulse.style.animation='none'; void els.pulse.offsetWidth; els.pulse.style.animation='heartbeat .6s ease';
    const s=document.createElement('style');
    s.textContent='@keyframes heartbeat{0%,100%{transform:translate(-50%,-50%) scale(1);opacity:.8}50%{transform:translate(-50%,-50%) scale(1.3);opacity:1}}';
    document.head.appendChild(s); setTimeout(()=>s.remove(),700);
  }
}
