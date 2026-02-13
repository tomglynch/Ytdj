/**
 * Controller UI logic for YouTube DJ.
 *
 * Connects to the background service worker via a long-lived port
 * and renders the dual-deck DJ interface.
 */

import { BackgroundMessage, ControllerMessage, DeckState, SyncState } from '../types';
import { WaveformRenderer } from './waveformRenderer';

// ---- Background Connection ----

const port = chrome.runtime.connect({ name: 'controller' });

function send(msg: ControllerMessage) {
  port.postMessage(msg);
}

// ---- State ----

let deckA: DeckState | null = null;
let deckB: DeckState | null = null;
let syncState: SyncState | null = null;

// ---- DOM Elements ----

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const elements = {
  // Deck A
  titleA: $<HTMLSpanElement>('titleA'),
  bpmA: $<HTMLSpanElement>('bpmA'),
  urlA: $<HTMLInputElement>('urlA'),
  loadA: $<HTMLButtonElement>('loadA'),
  analyzeA: $<HTMLButtonElement>('analyzeA'),
  playA: $<HTMLButtonElement>('playA'),
  nudgeBackA: $<HTMLButtonElement>('nudgeBackA'),
  nudgeFwdA: $<HTMLButtonElement>('nudgeFwdA'),
  syncA: $<HTMLButtonElement>('syncA'),
  timeA: $<HTMLSpanElement>('timeA'),
  rateA: $<HTMLInputElement>('rateA'),
  rateValA: $<HTMLSpanElement>('rateValA'),
  volA: $<HTMLInputElement>('volA'),
  volValA: $<HTMLSpanElement>('volValA'),
  infoA: $<HTMLSpanElement>('infoA'),
  canvasA: $<HTMLCanvasElement>('canvasA'),

  // Deck B
  titleB: $<HTMLSpanElement>('titleB'),
  bpmB: $<HTMLSpanElement>('bpmB'),
  urlB: $<HTMLInputElement>('urlB'),
  loadB: $<HTMLButtonElement>('loadB'),
  analyzeB: $<HTMLButtonElement>('analyzeB'),
  playB: $<HTMLButtonElement>('playB'),
  nudgeBackB: $<HTMLButtonElement>('nudgeBackB'),
  nudgeFwdB: $<HTMLButtonElement>('nudgeFwdB'),
  syncB: $<HTMLButtonElement>('syncB'),
  timeB: $<HTMLSpanElement>('timeB'),
  rateB: $<HTMLInputElement>('rateB'),
  rateValB: $<HTMLSpanElement>('rateValB'),
  volB: $<HTMLInputElement>('volB'),
  volValB: $<HTMLSpanElement>('volValB'),
  infoB: $<HTMLSpanElement>('infoB'),
  canvasB: $<HTMLCanvasElement>('canvasB'),

  // Sync
  syncModeBtn: $<HTMLButtonElement>('syncModeBtn'),
  phaseFill: $<HTMLDivElement>('phaseFill'),
  quantizeSelect: $<HTMLSelectElement>('quantizeSelect'),
  masterTime: $<HTMLSpanElement>('masterTime'),
};

// ---- Waveform Renderers ----

let waveformA: WaveformRenderer;
let waveformB: WaveformRenderer;

function initWaveforms() {
  waveformA = new WaveformRenderer(elements.canvasA, {
    color: '#00aaff',
    beatColor: 'rgba(255, 255, 255, 0.3)',
    downbeatColor: 'rgba(255, 255, 255, 0.6)',
  });
  waveformB = new WaveformRenderer(elements.canvasB, {
    color: '#ff4488',
    beatColor: 'rgba(255, 255, 255, 0.3)',
    downbeatColor: 'rgba(255, 255, 255, 0.6)',
  });
}

// ---- URL Parsing ----

function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com')) {
      return u.searchParams.get('v');
    }
    if (u.hostname === 'youtu.be') {
      return u.pathname.slice(1);
    }
  } catch {
    // Maybe it's just a video ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(url)) {
      return url;
    }
  }
  return null;
}

function buildYouTubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

// ---- Time Formatting ----

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ---- UI Update ----

function updateUI() {
  if (!deckA || !deckB || !syncState) return;

  // Deck A
  elements.titleA.textContent = deckA.analysis?.title || (deckA.videoId ? `Video: ${deckA.videoId}` : 'No track loaded');
  elements.bpmA.textContent = deckA.analysis ? deckA.analysis.bpm.toFixed(1) : '---';
  elements.infoA.textContent = deckA.analysis ? `${deckA.analysis.bpm.toFixed(1)} BPM` : '--.- BPM';
  elements.timeA.textContent = formatTime(deckA.currentTime);
  elements.playA.textContent = deckA.playing ? '\u23F8' : '\u25B6';
  elements.playA.classList.toggle('playing', deckA.playing);
  elements.rateValA.textContent = `${deckA.playbackRate.toFixed(2)}x`;
  elements.volValA.textContent = `${Math.round(deckA.volume * 100)}%`;

  // Deck B
  elements.titleB.textContent = deckB.analysis?.title || (deckB.videoId ? `Video: ${deckB.videoId}` : 'No track loaded');
  elements.bpmB.textContent = deckB.analysis ? deckB.analysis.bpm.toFixed(1) : '---';
  elements.infoB.textContent = deckB.analysis ? `${deckB.analysis.bpm.toFixed(1)} BPM` : '--.- BPM';
  elements.timeB.textContent = formatTime(deckB.currentTime);
  elements.playB.textContent = deckB.playing ? '\u23F8' : '\u25B6';
  elements.playB.classList.toggle('playing', deckB.playing);
  elements.rateValB.textContent = `${deckB.playbackRate.toFixed(2)}x`;
  elements.volValB.textContent = `${Math.round(deckB.volume * 100)}%`;

  // Sync
  elements.syncModeBtn.classList.toggle('active', syncState.mode !== 'off');
  elements.syncModeBtn.textContent = syncState.mode === 'off' ? 'Sync' : syncState.mode === 'tempo' ? 'Tempo' : 'Beat';

  // Phase meter
  const phaseOffset = syncState.phaseOffset;
  const phasePct = 50 + (phaseOffset / 0.1) * 50; // ±100ms range
  elements.phaseFill.style.left = `${Math.max(0, Math.min(100, phasePct))}%`;

  // Master time
  const master = deckA.isMaster ? deckA : deckB;
  elements.masterTime.textContent = formatTime(master.currentTime);

  // Update waveforms
  if (deckA.analysis && waveformA) {
    waveformA.setData(
      deckA.analysis.waveformPeaks,
      deckA.analysis.beats,
      deckA.analysis.downbeats,
      deckA.analysis.duration
    );
    waveformA.setPlayhead(deckA.currentTime);
    waveformA.render();
  }

  if (deckB.analysis && waveformB) {
    waveformB.setData(
      deckB.analysis.waveformPeaks,
      deckB.analysis.beats,
      deckB.analysis.downbeats,
      deckB.analysis.duration
    );
    waveformB.setPlayhead(deckB.currentTime);
    waveformB.render();
  }
}

// ---- Event Handlers ----

function setupEventHandlers() {
  // Load tracks
  elements.loadA.addEventListener('click', () => {
    const videoId = extractVideoId(elements.urlA.value);
    if (videoId) {
      send({ type: 'LOAD_TRACK', deck: 'A', videoId, url: buildYouTubeUrl(videoId) });
    }
  });

  elements.loadB.addEventListener('click', () => {
    const videoId = extractVideoId(elements.urlB.value);
    if (videoId) {
      send({ type: 'LOAD_TRACK', deck: 'B', videoId, url: buildYouTubeUrl(videoId) });
    }
  });

  // Enter key on URL inputs
  elements.urlA.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') elements.loadA.click();
  });
  elements.urlB.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') elements.loadB.click();
  });

  // Play/Pause
  elements.playA.addEventListener('click', () => {
    if (deckA?.playing) {
      send({ type: 'PAUSE', deck: 'A' });
    } else {
      send({ type: 'PLAY', deck: 'A' });
    }
  });

  elements.playB.addEventListener('click', () => {
    if (deckB?.playing) {
      send({ type: 'PAUSE', deck: 'B' });
    } else {
      send({ type: 'PLAY', deck: 'B' });
    }
  });

  // Nudge
  elements.nudgeBackA.addEventListener('click', () => {
    send({ type: 'NUDGE', deck: 'A', direction: 'backward', amount: 0.02 });
  });
  elements.nudgeFwdA.addEventListener('click', () => {
    send({ type: 'NUDGE', deck: 'A', direction: 'forward', amount: 0.02 });
  });
  elements.nudgeBackB.addEventListener('click', () => {
    send({ type: 'NUDGE', deck: 'B', direction: 'backward', amount: 0.02 });
  });
  elements.nudgeFwdB.addEventListener('click', () => {
    send({ type: 'NUDGE', deck: 'B', direction: 'forward', amount: 0.02 });
  });

  // Per-deck sync
  elements.syncA.addEventListener('click', () => {
    send({ type: 'SYNC', deck: 'A' });
  });
  elements.syncB.addEventListener('click', () => {
    send({ type: 'SYNC', deck: 'B' });
  });

  // Analyze
  elements.analyzeA.addEventListener('click', () => {
    send({ type: 'ANALYZE_TRACK', deck: 'A' });
    elements.analyzeA.classList.add('analyzing');
    elements.analyzeA.textContent = 'Analyzing...';
  });
  elements.analyzeB.addEventListener('click', () => {
    send({ type: 'ANALYZE_TRACK', deck: 'B' });
    elements.analyzeB.classList.add('analyzing');
    elements.analyzeB.textContent = 'Analyzing...';
  });

  // Rate sliders
  elements.rateA.addEventListener('input', () => {
    const rate = parseFloat(elements.rateA.value);
    send({ type: 'SET_RATE', deck: 'A', rate });
    elements.rateValA.textContent = `${rate.toFixed(2)}x`;
  });
  elements.rateB.addEventListener('input', () => {
    const rate = parseFloat(elements.rateB.value);
    send({ type: 'SET_RATE', deck: 'B', rate });
    elements.rateValB.textContent = `${rate.toFixed(2)}x`;
  });

  // Volume sliders
  elements.volA.addEventListener('input', () => {
    const vol = parseFloat(elements.volA.value);
    send({ type: 'SET_VOLUME', deck: 'A', volume: vol });
    elements.volValA.textContent = `${Math.round(vol * 100)}%`;
  });
  elements.volB.addEventListener('input', () => {
    const vol = parseFloat(elements.volB.value);
    send({ type: 'SET_VOLUME', deck: 'B', volume: vol });
    elements.volValB.textContent = `${Math.round(vol * 100)}%`;
  });

  // Sync mode toggle
  elements.syncModeBtn.addEventListener('click', () => {
    if (!syncState) return;
    const modes: Array<'off' | 'tempo' | 'beatSync'> = ['off', 'tempo', 'beatSync'];
    const currentIdx = modes.indexOf(syncState.mode);
    const nextMode = modes[(currentIdx + 1) % modes.length];
    send({ type: 'SET_SYNC_MODE', mode: nextMode });
  });

  // Quantize select
  elements.quantizeSelect.addEventListener('change', () => {
    // Quantize is part of sync state, sent with sync commands
    // For now just update local display
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    switch (e.key) {
      case ' ':
        e.preventDefault();
        // Toggle master deck
        if (deckA?.isMaster) {
          elements.playA.click();
        } else {
          elements.playB.click();
        }
        break;
      case 'q': elements.playA.click(); break;
      case 'w': elements.playB.click(); break;
      case 's':
        if (syncState?.mode === 'off') {
          send({ type: 'SET_SYNC_MODE', mode: 'beatSync' });
        } else {
          send({ type: 'SET_SYNC_MODE', mode: 'off' });
        }
        break;
    }
  });
}

// ---- Message Handling ----

port.onMessage.addListener((msg: BackgroundMessage) => {
  switch (msg.type) {
    case 'STATE_UPDATE':
      deckA = msg.deckA;
      deckB = msg.deckB;
      syncState = msg.sync;
      updateUI();
      break;

    case 'ANALYSIS_COMPLETE':
      if (msg.deck === 'A') {
        elements.analyzeA.classList.remove('analyzing');
        elements.analyzeA.textContent = 'Analyze';
      } else {
        elements.analyzeB.classList.remove('analyzing');
        elements.analyzeB.textContent = 'Analyze';
      }
      break;

    case 'ANALYSIS_PROGRESS':
      if (msg.deck === 'A') {
        elements.analyzeA.textContent = `${Math.round(msg.progress * 100)}%`;
      } else {
        elements.analyzeB.textContent = `${Math.round(msg.progress * 100)}%`;
      }
      break;

    case 'ANALYSIS_ERROR':
      if (msg.deck === 'A') {
        elements.analyzeA.classList.remove('analyzing');
        elements.analyzeA.textContent = 'Analyze';
      } else {
        elements.analyzeB.classList.remove('analyzing');
        elements.analyzeB.textContent = 'Analyze';
      }
      console.error(`Analysis error on deck ${msg.deck}: ${msg.error}`);
      break;

    case 'ERROR':
      console.error('[YouTube DJ]', msg.message);
      break;
  }
});

// ---- Init ----

function init() {
  initWaveforms();
  setupEventHandlers();

  // Request initial state
  send({ type: 'GET_STATE' });

  // Resize waveforms on window resize
  window.addEventListener('resize', () => {
    waveformA?.resize();
    waveformB?.resize();
  });

  // Animation loop for smooth waveform scrolling
  function animationLoop() {
    updateUI();
    requestAnimationFrame(animationLoop);
  }
  requestAnimationFrame(animationLoop);
}

document.addEventListener('DOMContentLoaded', init);
