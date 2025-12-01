// main.js
// Wires the UI to the BabyBeat core and handles tabs.

import { initBabyBeat } from './babybeat-core.js';

function setupTabs() {
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const panels = Array.from(document.querySelectorAll('.tabpanel'));

  function setTab(idx) {
    tabs.forEach((t, i) => t.setAttribute('aria-selected', i === idx ? 'true' : 'false'));
    panels.forEach((p, i) => p.classList.toggle('active', i === idx));
  }

  tabs.forEach((t, i) => {
    t.addEventListener('click', () => setTab(i));
    t.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') setTab((i + 1) % tabs.length);
      if (e.key === 'ArrowLeft') setTab((i - 1 + tabs.length) % tabs.length);
    });
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  setupTabs();

  const engine = await initBabyBeat({
    elements: {
      start: '#startBtn',
      stop: '#stopBtn',
      monitor: '#monitorBtn',
      playEnhanced: '#playEnhancedBtn',
      record: '#recBtn',

      micType: '#micType',

      sensitivity: '#sensitivity',
      sensitivityValue: '#sensitivityValue',
      filterFreq: '#filterFreq',
      filterValue: '#filterValue',
      monitorVol: '#monitorVol',
      monitorVolValue: '#monitorVolValue',

      status: '#status',
      waveform: '#waveform',
      pulse: '#pulse',

      bpm: '#bpm-main',
      bpmMaternal: '#bpm-maternal',

      playbackArea: '#playbackArea',
      playbackAudio: '#playbackAudio',
      downloadLink: '#downloadLink'
    },
    ai: {
      enabled: false,
      endpoint: null
    }
  });

  // Optional: make available in devtools
  window.babyBeatEngine = engine;
});

