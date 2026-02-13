/**
 * Background service worker for YouTube DJ extension.
 *
 * This is intentionally THIN. It routes messages and manages state.
 * Heavy audio processing happens in the offscreen document.
 *
 * Responsibilities:
 * 1. Manage deck state (two decks: A and B)
 * 2. Route messages between controller, content scripts, and offscreen doc
 * 3. Orchestrate sync engine based on deck states
 * 4. Manage offscreen document lifecycle for audio analysis
 * 5. Handle track analysis caching
 * 6. Open controller tab on extension icon click
 */

import { DeckState, SyncState, ControllerMessage, BackgroundMessage, ContentMessage, ContentResponse, TrackAnalysis, TrackAnalysisSerialized } from '../types';
import { generateSyncCommands, calculateDriftCorrection, calculateTempoMatchRate } from '../audio/syncEngine';
import { getCachedAnalysis, cacheAnalysis } from '../storage/analysisCache';

// ---- State ----

const deckA: DeckState = {
  id: 'A',
  videoId: null,
  tabId: null,
  playing: false,
  currentTime: 0,
  playbackRate: 1.0,
  volume: 1.0,
  analysis: null,
  currentBeatIndex: 0,
  isMaster: true,
};

const deckB: DeckState = {
  id: 'B',
  videoId: null,
  tabId: null,
  playing: false,
  currentTime: 0,
  playbackRate: 1.0,
  volume: 1.0,
  analysis: null,
  currentBeatIndex: 0,
  isMaster: false,
};

const syncState: SyncState = {
  mode: 'off',
  quantize: 'beat',
  phaseOffset: 0,
  driftCorrection: true,
};

let controllerTabId: number | null = null;
let syncInterval: ReturnType<typeof setInterval> | null = null;

// Track which deck is currently being analyzed (by videoId)
const pendingAnalysis: Map<string, 'A' | 'B'> = new Map();

// ---- Offscreen Document Management ----

let offscreenReady = false;

async function ensureOffscreenDocument() {
  if (offscreenReady) return;

  // Check if offscreen doc already exists
  const existingContexts = await (chrome as any).runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  }).catch(() => []);

  if (existingContexts.length > 0) {
    offscreenReady = true;
    return;
  }

  await (chrome as any).offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'], // Closest valid reason for audio processing
    justification: 'Beat detection and audio analysis for DJ mixing',
  });
  offscreenReady = true;
}

// ---- Deck Helpers ----

function getDeck(id: 'A' | 'B'): DeckState {
  return id === 'A' ? deckA : deckB;
}

function getDeckByTabId(tabId: number): DeckState | null {
  if (deckA.tabId === tabId) return deckA;
  if (deckB.tabId === tabId) return deckB;
  return null;
}

function getDeckByVideoId(videoId: string): DeckState | null {
  if (deckA.videoId === videoId) return deckA;
  if (deckB.videoId === videoId) return deckB;
  return null;
}

function getMasterDeck(): DeckState {
  return deckA.isMaster ? deckA : deckB;
}

function getSlaveDeck(): DeckState {
  return deckA.isMaster ? deckB : deckA;
}

// ---- Tab Communication ----

async function sendToTab(tabId: number, message: ContentMessage): Promise<any> {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    console.warn(`[YouTube DJ] Failed to send to tab ${tabId}:`, e);
    return null;
  }
}

function sendToController(message: BackgroundMessage) {
  for (const port of controllerPorts) {
    try {
      port.postMessage(message);
    } catch {
      // Port disconnected, will be cleaned up by onDisconnect
    }
  }
}

function broadcastState() {
  sendToController({
    type: 'STATE_UPDATE',
    deckA: { ...deckA },
    deckB: { ...deckB },
    sync: { ...syncState },
  });
}

// ---- Controller Ports (long-lived connections) ----

const controllerPorts: Set<chrome.runtime.Port> = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'controller') {
    controllerPorts.add(port);

    port.postMessage({
      type: 'STATE_UPDATE',
      deckA: { ...deckA },
      deckB: { ...deckB },
      sync: { ...syncState },
    } as BackgroundMessage);

    port.onMessage.addListener((msg: ControllerMessage) => {
      handleControllerMessage(msg);
    });

    port.onDisconnect.addListener(() => {
      controllerPorts.delete(port);
    });
  }
});

// ---- Controller Message Handling ----

async function handleControllerMessage(message: ControllerMessage) {
  switch (message.type) {
    case 'LOAD_TRACK': {
      const deck = getDeck(message.deck);
      if (deck.tabId !== null) {
        try {
          await chrome.tabs.update(deck.tabId, { url: message.url });
        } catch {
          const tab = await chrome.tabs.create({ url: message.url, active: false });
          deck.tabId = tab.id!;
        }
      } else {
        const tab = await chrome.tabs.create({ url: message.url, active: false });
        deck.tabId = tab.id!;
      }
      deck.videoId = message.videoId;
      deck.playing = false;
      deck.currentTime = 0;
      deck.playbackRate = 1.0;

      // Check cache for existing analysis
      const cached = await getCachedAnalysis(message.videoId);
      if (cached) {
        deck.analysis = cached;
        sendToController({
          type: 'ANALYSIS_COMPLETE',
          deck: message.deck,
          analysis: cached,
        });
      }

      broadcastState();
      break;
    }

    case 'PLAY': {
      const deck = getDeck(message.deck);
      if (deck.tabId !== null) {
        await sendToTab(deck.tabId, { type: 'PLAYER_COMMAND', command: 'play' });
        deck.playing = true;
        broadcastState();
      }
      break;
    }

    case 'PAUSE': {
      const deck = getDeck(message.deck);
      if (deck.tabId !== null) {
        await sendToTab(deck.tabId, { type: 'PLAYER_COMMAND', command: 'pause' });
        deck.playing = false;
        broadcastState();
      }
      break;
    }

    case 'SEEK': {
      const deck = getDeck(message.deck);
      if (deck.tabId !== null) {
        await sendToTab(deck.tabId, { type: 'PLAYER_SEEK', time: message.time });
        deck.currentTime = message.time;
        broadcastState();
      }
      break;
    }

    case 'SET_RATE': {
      const deck = getDeck(message.deck);
      if (deck.tabId !== null) {
        await sendToTab(deck.tabId, { type: 'PLAYER_SET_RATE', rate: message.rate });
        deck.playbackRate = message.rate;
        broadcastState();
      }
      break;
    }

    case 'SET_VOLUME': {
      const deck = getDeck(message.deck);
      if (deck.tabId !== null) {
        await sendToTab(deck.tabId, { type: 'PLAYER_SET_VOLUME', volume: message.volume });
        deck.volume = message.volume;
        broadcastState();
      }
      break;
    }

    case 'SYNC': {
      const slave = getDeck(message.deck);
      const master = slave.id === 'A' ? deckB : deckA;

      if (!master.analysis || !slave.analysis) {
        sendToController({ type: 'ERROR', message: 'Both tracks must be analyzed before syncing' });
        return;
      }

      const commands = generateSyncCommands(master, slave, 'beatSync', syncState.quantize);
      for (const cmd of commands) {
        if (cmd.rate !== undefined && slave.tabId !== null) {
          await sendToTab(slave.tabId, { type: 'PLAYER_SET_RATE', rate: cmd.rate });
          slave.playbackRate = cmd.rate;
        }
        if (cmd.seekTo !== undefined && slave.tabId !== null) {
          await sendToTab(slave.tabId, { type: 'PLAYER_SEEK', time: cmd.seekTo });
          slave.currentTime = cmd.seekTo;
        }
      }
      broadcastState();
      break;
    }

    case 'SET_SYNC_MODE': {
      syncState.mode = message.mode;
      if (message.mode !== 'off') {
        startSyncLoop();
      } else {
        stopSyncLoop();
      }
      broadcastState();
      break;
    }

    case 'ANALYZE_TRACK': {
      const deck = getDeck(message.deck);
      if (deck.tabId === null || !deck.videoId) {
        sendToController({ type: 'ERROR', message: 'No track loaded on this deck' });
        return;
      }

      // Check cache first
      const cached = await getCachedAnalysis(deck.videoId);
      if (cached) {
        deck.analysis = cached;
        sendToController({
          type: 'ANALYSIS_COMPLETE',
          deck: message.deck,
          analysis: cached,
        });
        broadcastState();
        return;
      }

      // Track which deck this analysis is for
      pendingAnalysis.set(deck.videoId, message.deck);

      // Tell the controller we're starting
      sendToController({ type: 'ANALYSIS_PROGRESS', deck: message.deck, progress: 0 });

      // Tell the content script to start capturing audio
      await sendToTab(deck.tabId, { type: 'CAPTURE_AUDIO' });
      sendToController({ type: 'ANALYSIS_PROGRESS', deck: message.deck, progress: 0.05 });
      break;
    }

    case 'NUDGE': {
      const deck = getDeck(message.deck);
      if (deck.tabId !== null) {
        const nudgeAmount = message.direction === 'forward' ? message.amount : -message.amount;
        const newTime = deck.currentTime + nudgeAmount;
        await sendToTab(deck.tabId, { type: 'PLAYER_SEEK', time: Math.max(0, newTime) });
        deck.currentTime = newTime;
        broadcastState();
      }
      break;
    }

    case 'GET_STATE': {
      broadcastState();
      break;
    }
  }
}

// ---- Content Script & Offscreen Messages ----

chrome.runtime.onMessage.addListener((message: any, sender) => {
  // Messages from content scripts have sender.tab
  if (sender.tab?.id) {
    handleContentScriptMessage(message, sender.tab.id);
    return;
  }

  // Messages from offscreen document (no sender.tab)
  handleOffscreenMessage(message);
});

function handleContentScriptMessage(message: any, tabId: number) {
  const deck = getDeckByTabId(tabId);

  switch (message.type) {
    case 'PLAYER_STATE': {
      if (!deck) return;
      deck.currentTime = message.currentTime;
      deck.playing = message.playing;
      deck.playbackRate = message.playbackRate;
      deck.volume = message.volume;
      if (!deck.videoId) deck.videoId = message.videoId;
      break;
    }

    case 'PLAYER_EVENT': {
      if (!deck) return;
      if (message.event === 'playing') deck.playing = true;
      if (message.event === 'paused') deck.playing = false;
      broadcastState();
      break;
    }

    case 'AUDIO_CAPTURE_PROGRESS': {
      // Content script is accumulating audio - forward progress to controller
      if (!deck) return;
      const deckId = deck.id as 'A' | 'B';
      // Scale: capture progress is 0-1, maps to 0.05-0.4 of total analysis
      const scaledProgress = 0.05 + message.progress * 0.35;
      sendToController({ type: 'ANALYSIS_PROGRESS', deck: deckId, progress: scaledProgress });
      break;
    }

    case 'AUDIO_BUFFER_READY': {
      // Content script finished capturing audio. Forward to offscreen for analysis.
      if (!deck || !deck.videoId) return;

      const deckId = deck.id as 'A' | 'B';
      sendToController({ type: 'ANALYSIS_PROGRESS', deck: deckId, progress: 0.4 });

      // Get title from current state
      const title = deck.analysis?.title || `Video ${deck.videoId}`;

      // Send to offscreen document for CPU-intensive analysis
      forwardToOffscreen({
        type: 'ANALYZE_AUDIO',
        audioData: message.data,
        videoId: deck.videoId,
        title,
        sampleRate: message.sampleRate,
      });
      break;
    }

    case 'CONTENT_READY': {
      // Content script loaded on a YouTube tab.
      // Don't auto-capture - wait for user to click Analyze.
      break;
    }
  }
}

async function forwardToOffscreen(message: any) {
  try {
    await ensureOffscreenDocument();
    chrome.runtime.sendMessage(message);
  } catch (e) {
    console.error('[YouTube DJ] Failed to forward to offscreen:', e);
  }
}

function handleOffscreenMessage(message: any) {
  switch (message.type) {
    case 'ANALYSIS_PROGRESS_FROM_OFFSCREEN': {
      const deckId = pendingAnalysis.get(message.videoId);
      if (!deckId) return;
      // Scale: offscreen progress 0-1 maps to 0.4-1.0 of total
      const scaledProgress = 0.4 + message.progress * 0.6;
      sendToController({ type: 'ANALYSIS_PROGRESS', deck: deckId, progress: scaledProgress });
      break;
    }

    case 'ANALYSIS_RESULT': {
      const serialized: TrackAnalysisSerialized = message.analysis;
      const videoId = serialized.videoId;
      const deckId = pendingAnalysis.get(videoId);
      if (!deckId) return;
      pendingAnalysis.delete(videoId);

      // Deserialize
      const analysis: TrackAnalysis = {
        ...serialized,
        waveformPeaks: new Float32Array(serialized.waveformPeaks),
      };

      // Update deck state
      const deck = getDeck(deckId);
      deck.analysis = analysis;

      // Cache for future use
      cacheAnalysis(analysis);

      // Notify controller
      sendToController({
        type: 'ANALYSIS_COMPLETE',
        deck: deckId,
        analysis,
      });
      broadcastState();
      break;
    }

    case 'ANALYSIS_ERROR_FROM_OFFSCREEN': {
      const deckId = pendingAnalysis.get(message.videoId);
      if (!deckId) return;
      pendingAnalysis.delete(message.videoId);

      sendToController({
        type: 'ANALYSIS_ERROR',
        deck: deckId,
        error: message.error,
      });
      break;
    }
  }
}

// ---- Sync Loop ----

function startSyncLoop() {
  if (syncInterval) return;

  syncInterval = setInterval(() => {
    if (syncState.mode === 'off') {
      stopSyncLoop();
      return;
    }

    const master = getMasterDeck();
    const slave = getSlaveDeck();

    if (!master.playing || !slave.playing) return;
    if (!master.analysis || !slave.analysis) return;

    if (syncState.driftCorrection && syncState.mode === 'beatSync') {
      const baseRate = calculateTempoMatchRate(master.analysis.bpm, slave.analysis.bpm);
      const driftAdj = calculateDriftCorrection(master, slave, baseRate);

      if (driftAdj !== 0) {
        const correctedRate = baseRate + driftAdj;
        if (slave.tabId !== null) {
          sendToTab(slave.tabId, { type: 'PLAYER_SET_RATE', rate: correctedRate });
          slave.playbackRate = correctedRate;
        }
      }
    }
  }, 50); // 20Hz sync loop
}

function stopSyncLoop() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

// ---- Extension Action (toolbar icon click) ----

chrome.action.onClicked.addListener(async () => {
  if (controllerTabId !== null) {
    try {
      await chrome.tabs.update(controllerTabId, { active: true });
      return;
    } catch {
      controllerTabId = null;
    }
  }

  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL('controller.html'),
  });
  controllerTabId = tab.id!;
});

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (deckA.tabId === tabId) {
    deckA.tabId = null;
    deckA.videoId = null;
    deckA.playing = false;
    deckA.analysis = null;
    broadcastState();
  }
  if (deckB.tabId === tabId) {
    deckB.tabId = null;
    deckB.videoId = null;
    deckB.playing = false;
    deckB.analysis = null;
    broadcastState();
  }
  if (controllerTabId === tabId) {
    controllerTabId = null;
  }
});
