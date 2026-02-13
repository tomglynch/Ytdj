/**
 * Background service worker for YouTube DJ extension.
 *
 * Responsibilities:
 * 1. Manage deck state (two decks: A and B)
 * 2. Route messages between controller UI and content scripts
 * 3. Orchestrate sync engine based on deck states
 * 4. Handle track analysis caching
 * 5. Open controller tab on extension icon click
 */

import { DeckState, SyncState, SyncMode, QuantizeMode, ControllerMessage, BackgroundMessage, ContentMessage, ContentResponse, TrackAnalysis } from '../types';
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

// ---- Deck Helpers ----

function getDeck(id: 'A' | 'B'): DeckState {
  return id === 'A' ? deckA : deckB;
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
  if (controllerTabId !== null) {
    chrome.tabs.sendMessage(controllerTabId, message).catch(() => {
      // Controller tab may have been closed
      controllerTabId = null;
    });
  }
  // Also broadcast to any connected ports
  for (const port of controllerPorts) {
    try {
      port.postMessage(message);
    } catch {
      // Port disconnected
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

    // Send initial state
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

// ---- Message Handling ----

async function handleControllerMessage(message: ControllerMessage) {
  switch (message.type) {
    case 'LOAD_TRACK': {
      const deck = getDeck(message.deck);
      // Open YouTube in a new tab (or reuse existing)
      if (deck.tabId !== null) {
        try {
          await chrome.tabs.update(deck.tabId, { url: message.url });
        } catch {
          // Tab no longer exists
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

      // Check cache for analysis
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
      // One-shot sync: align the specified deck to the other
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

      // Start audio capture for analysis
      sendToController({ type: 'ANALYSIS_PROGRESS', deck: message.deck, progress: 0 });
      await sendToTab(deck.tabId, { type: 'CAPTURE_AUDIO' });

      // The actual analysis happens when we receive audio data
      // For now, signal that capture has started
      sendToController({ type: 'ANALYSIS_PROGRESS', deck: message.deck, progress: 0.1 });
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

// ---- Content Script Messages ----

chrome.runtime.onMessage.addListener((message: ContentResponse, sender) => {
  if (!sender.tab?.id) return;

  const tabId = sender.tab.id;

  // Find which deck this tab belongs to
  let deck: DeckState | null = null;
  if (deckA.tabId === tabId) deck = deckA;
  else if (deckB.tabId === tabId) deck = deckB;

  if (!deck) return;

  switch (message.type) {
    case 'PLAYER_STATE':
      deck.currentTime = message.currentTime;
      deck.playing = message.playing;
      deck.playbackRate = message.playbackRate;
      deck.volume = message.volume;
      if (!deck.videoId) deck.videoId = message.videoId;
      // Don't broadcast every state update to reduce noise,
      // controller polls at its own rate
      break;

    case 'PLAYER_EVENT':
      if (message.event === 'playing') deck.playing = true;
      if (message.event === 'paused') deck.playing = false;
      broadcastState();
      break;

    case 'CONTENT_READY':
      // Content script is ready, start capturing audio
      sendToTab(tabId, { type: 'CAPTURE_AUDIO' });
      break;
  }
});

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

    // Apply drift correction if enabled
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
  // Open the controller in a new tab
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
