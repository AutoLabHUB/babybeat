// public/babybeat-core.js — core logic (can be minified/obfuscated later)
export async function initBabyBeat (opts) {
  const q = (sel) => document.querySelector(sel);
  const els = mapSelectors(opts.elements || {});
  const licenseOk = await (opts.licenseValidator?.() ?? true);
  if (!licenseOk) throw new Error('License check failed');
  const MIN_FETAL_BPM=100, MAX_FETAL_BPM=170, REFRACTORY_MS=350, MIN_INTERVAL_MS=300, MAX_INTERVAL_MS=750, SMOOTHING_ALPHA=0.25;
  let audioCtx, mediaStream, mediaSrc, hp, lp, comp, analyser, monitorGain, procDest, mediaRecorder;
  let isRunning=false, monitoring=false, recording=false, ema=0, lastBeatTs=0, bpm=0, drawRAF=0; const intervals=[];
  initUI(); return { start, stop, toggleMonitor, startRecording, stopRecording, setFilterHz, setSensitivity, setMonitorVol };

  function mapSelectors(map){ const o={}; for(const k of Object.keys(map)) o[k]=q(map[k]); return o; }
  function initUI(){
    els.filterFreq.addEventListener('input', ()=>{ const hz=parseInt(els.filterFreq.value,10); els.filterValue.textContent=`${hz} Hz`; if(lp) lp.frequency.setTargetAtTime(hz,audioCtx?.currentTime||0,0.01); });
    els.sensitivity.addEventListener('input', ()=>{ els.sensitivityValue.textContent=els.sensitivity.value; });
    els.monitorVol.addEventListener('input', ()=>{ els.monitorVolValue.textContent=`${els.monitorVol.value}%`; if(monitorGain) monitorGain.gain.value=parseInt(els.monitorVol.value,10)/100; });
    els.start.addEventListener('click', start); els.stop.addEventListener('click', stop);
    els.monitor.addEventListener('click', toggleMonitor); els.playEnhanced.addEventListener('click', playEnhancedSample);
    els.record.addEventListener('click', ()=> (recording ? stopRecording() : startRecording()));
  }

  async function start(){
    if(isRunning) return;
    try{
      mediaStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
      audioCtx=new (window.AudioContext||window.webkitAudioContext)({sampleRate:48000});
      mediaSrc=audioCtx.createMediaStreamSource(mediaStream);
      hp=audioCtx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=10;
      lp=audioCtx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=parseInt(els.filterFreq.value,10)||60;
      comp=audioCtx.createDynamicsCompressor(); comp.threshold.value=-28; comp.knee.value=20; comp.ratio.value=6; comp.attack.value=0.003; comp.release.value=0.25;
      analyser=audioCtx.createAnalyser(); analyser.fftSize=1024; const buf=new Float32Array(analyser.fftSize);
      monitorGain=audioCtx.createGain(); monitorGain.gain.value=parseInt(els.monitorVol.value,10)/100;
      procDest=audioCtx.createMediaStreamDestination();
      mediaSrc.connect(hp).connect(lp).connect(comp); comp.connect(analyser); comp.connect(procDest); comp.connect(monitorGain).connect(audioCtx.destination);
      els.start.disabled=true; els.stop.disabled=false; els.monitor.disabled=false; els.playEnhanced.disabled=false; els.record.disabled=false; setStatus('Listening…');
      isRunning=true; drawRAF=requestAnimationFrame(drawLoop);
      function drawLoop(){ if(!isRunning) return;
        analyser.getFloatTimeDomainData(buf); let peak=0; for(let i=0;i<buf.length;i++){ const v=Math.abs(buf[i]); if(v>peak) peak=v; }
        const sens=parseInt(els.sensitivity.value,10); const threshold=0.02*(11-sens); ema=SMOOTH(ema,peak,SMOOTHING_ALPHA);
        const now=performance.now(); if(ema>threshold && (now-lastBeatTs)>REFRACTORY_MS){ const interval=now-lastBeatTs; lastBeatTs=now;
          if(interval>MIN_INTERVAL_MS && interval<MAX_INTERVAL_MS){ intervals.push(interval); if(intervals.length>6) intervals.shift();
            const avg=intervals.reduce((a,b)=>a+b,0)/intervals.length; const currentBpm=Math.min(MAX_FETAL_BPM,Math.max(MIN_FETAL_BPM,60000/avg));
            bpm=Math.round(currentBpm); els.bpm.textContent=`${bpm} BPM`; pulse(); } }
        const y=Math.min(48,Math.max(-48,(ema-threshold)*600)); els.waveform.style.transform=`translateY(calc(-50% + ${y}px))`;
        drawRAF=requestAnimationFrame(drawLoop);
      }
    }catch(e){ console.error(e); setStatus('Mic permission denied or unavailable.'); }
  }

  function stop(){ if(!isRunning) return; cancelAnimationFrame(drawRAF); isRunning=false; ema=0; intervals.length=0; bpm=0;
    els.bpm.textContent='-- BPM'; try{mediaStream?.getTracks().forEach(t=>t.stop())}catch{}; try{audioCtx?.close()}catch{};
    monitoring=false; els.monitor.textContent='Monitor: Off'; els.start.disabled=false; els.stop.disabled=true;
    els.monitor.disabled=true; els.playEnhanced.disabled=true; els.record.disabled=true; setStatus('Stopped.'); }

  function toggleMonitor(){ if(!audioCtx) return; monitoring=!monitoring;
    monitorGain.gain.value=monitoring?(parseInt(els.monitorVol.value,10)/100):0; els.monitor.textContent=`Monitor: ${monitoring?'On':'Off'}`; }

  async function playEnhancedSample(){ if(!audioCtx) return; const tmp=audioCtx.createGain(); tmp.gain.value=0.9; comp.connect(tmp).connect(audioCtx.destination); await wait(1800); tmp.disconnect(); }
  async function startRecording(){ if(!procDest) return; mediaRecorder=new MediaRecorder(procDest.stream,{mimeType:'audio/webm;codecs=opus'}); const chunks=[];
    mediaRecorder.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop=()=>{ const blob=new Blob(chunks,{type:'audio/webm'}); const url=URL.createObjectURL(blob); els.playbackAudio.src=url; els.downloadLink.href=url; els.playbackArea.style.display='block'; };
    mediaRecorder.start(); recording=true; els.record.textContent='Stop Recording'; }
  function stopRecording(){ if(!recording) return; mediaRecorder?.stop(); recording=false; els.record.textContent='Start Recording'; }

  function setFilterHz(hz){ if(lp) lp.frequency.value=hz; }
  function setSensitivity(v){ els.sensitivity.value=String(v); els.sensitivityValue.textContent=String(v); }
  function setMonitorVol(pct){ if(monitorGain) monitorGain.gain.value=pct/100; els.monitorVol.value=String(pct); els.monitorVolValue.textContent=`${pct}%`; }
  function setStatus(t){ els.status.textContent=t; }
  function SMOOTH(prev,val,alpha){ return prev + alpha*(val-prev); }
  function pulse(){ els.pulse.style.animation='none'; void els.pulse.offsetWidth; els.pulse.style.animation='heartbeat .6s ease';
    const s=document.createElement('style'); s.textContent='@keyframes heartbeat{0%,100%{transform:translate(-50%,-50%) scale(1);opacity:.8}50%{transform:translate(-50%,-50%) scale(1.3);opacity:1}}';
    document.head.appendChild(s); setTimeout(()=>s.remove(),700); }
  function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
}
