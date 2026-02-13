/**
 * Content script injected into YouTube tabs.
 *
 * Responsibilities:
 * 1. Capture audio from the YouTube player via Web Audio API
 * 2. Accumulate audio samples into a buffer for analysis
 * 3. Relay playback control commands to the YouTube player
 * 4. Report player state back to the background script
 */

import { ContentMessage, ContentResponse } from '../types';

let audioContext: AudioContext | null = null;
let mediaSource: MediaElementAudioSourceNode | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let isCapturing = false;
let statePollingInterval: ReturnType<typeof setInterval> | null = null;

// Audio accumulation buffer for analysis
let audioChunks: Float32Array[] = [];
let totalSamplesCollected = 0;
const TARGET_DURATION_SECONDS = 30; // Capture 30s for analysis

/** Find the YouTube video element on the page */
function getVideoElement(): HTMLVideoElement | null {
  return document.querySelector('video.html5-main-video') as HTMLVideoElement
    ?? document.querySelector('video') as HTMLVideoElement;
}

/** Extract current player state from the DOM video element */
function getPlayerState(): ContentResponse | null {
  const video = getVideoElement();
  if (!video) {
    return { type: 'ERROR', message: 'No video element found' };
  }

  const urlParams = new URLSearchParams(window.location.search);
  const videoId = urlParams.get('v') || '';

  const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')
    ?? document.querySelector('#title h1');
  const title = titleEl?.textContent?.trim() || document.title;

  return {
    type: 'PLAYER_STATE',
    videoId,
    title,
    currentTime: video.currentTime,
    duration: video.duration || 0,
    playing: !video.paused && !video.ended,
    playbackRate: video.playbackRate,
    volume: video.volume,
  };
}

/** Set up Web Audio API to capture audio from the video element */
function setupAudioCapture(): boolean {
  const video = getVideoElement();
  if (!video) return false;

  if (audioContext && mediaSource) {
    return true; // Already set up
  }

  try {
    audioContext = new AudioContext();
    mediaSource = audioContext.createMediaElementSource(video);

    // ScriptProcessorNode captures raw PCM samples.
    // We accumulate chunks locally and send the whole buffer once ready.
    const bufferSize = 4096;
    scriptNode = audioContext.createScriptProcessor(bufferSize, 1, 1);

    // Route: video -> scriptNode -> destination (audio still plays)
    mediaSource.connect(scriptNode);
    scriptNode.connect(audioContext.destination);

    scriptNode.onaudioprocess = (e) => {
      if (!isCapturing) return;

      const inputData = e.inputBuffer.getChannelData(0);
      const sampleRate = audioContext!.sampleRate;
      const targetSamples = TARGET_DURATION_SECONDS * sampleRate;

      if (totalSamplesCollected < targetSamples) {
        const chunk = new Float32Array(inputData);
        audioChunks.push(chunk);
        totalSamplesCollected += chunk.length;

        // Report progress periodically (every ~1 second of audio)
        if (totalSamplesCollected % (sampleRate * 1) < bufferSize) {
          chrome.runtime.sendMessage({
            type: 'AUDIO_CAPTURE_PROGRESS',
            progress: Math.min(1, totalSamplesCollected / targetSamples),
            totalSamples: totalSamplesCollected,
            sampleRate,
          });
        }

        // Once we have enough audio, send the full buffer
        if (totalSamplesCollected >= targetSamples) {
          sendAccumulatedAudio(sampleRate);
        }
      }
    };

    return true;
  } catch (e) {
    console.error('[YouTube DJ] Audio capture setup failed:', e);
    return false;
  }
}

/** Merge accumulated chunks and send to background for analysis */
function sendAccumulatedAudio(sampleRate: number) {
  const merged = new Float32Array(totalSamplesCollected);
  let offset = 0;
  for (const chunk of audioChunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  // Send as regular array (structured clone across extension boundary)
  chrome.runtime.sendMessage({
    type: 'AUDIO_BUFFER_READY',
    data: Array.from(merged),
    sampleRate,
  });

  // Reset buffer
  audioChunks = [];
  totalSamplesCollected = 0;
  isCapturing = false;
}

/** Start capturing audio data */
function startAudioCapture() {
  if (isCapturing) return;
  if (!setupAudioCapture()) return;

  // Reset accumulation
  audioChunks = [];
  totalSamplesCollected = 0;
  isCapturing = true;
}

/** Stop audio capture */
function stopAudioCapture() {
  isCapturing = false;
  audioChunks = [];
  totalSamplesCollected = 0;
}

/** Start polling player state at 5Hz */
function startStatePolling() {
  if (statePollingInterval) return;

  statePollingInterval = setInterval(() => {
    const state = getPlayerState();
    if (state && state.type === 'PLAYER_STATE') {
      chrome.runtime.sendMessage(state);
    }
  }, 200); // 5Hz
}

function stopStatePolling() {
  if (statePollingInterval) {
    clearInterval(statePollingInterval);
    statePollingInterval = null;
  }
}

/** Set up event listeners on the video element */
function setupVideoEventListeners() {
  const video = getVideoElement();
  if (!video) return;

  const events: Array<[string, string]> = [
    ['play', 'playing'],
    ['pause', 'paused'],
    ['ended', 'ended'],
    ['waiting', 'buffering'],
    ['seeked', 'seeked'],
  ];

  for (const [domEvent, djEvent] of events) {
    video.addEventListener(domEvent, () => {
      chrome.runtime.sendMessage({
        type: 'PLAYER_EVENT',
        event: djEvent,
      } as ContentResponse);
    });
  }
}

/** Handle messages from the background script */
chrome.runtime.onMessage.addListener(
  (message: ContentMessage, _sender, sendResponse) => {
    const video = getVideoElement();

    switch (message.type) {
      case 'GET_PLAYER_STATE': {
        sendResponse(getPlayerState());
        return true;
      }

      case 'CAPTURE_AUDIO': {
        startAudioCapture();
        startStatePolling();
        sendResponse({ success: true });
        return true;
      }

      case 'STOP_CAPTURE': {
        stopAudioCapture();
        stopStatePolling();
        sendResponse({ success: true });
        return true;
      }

      case 'PLAYER_COMMAND': {
        if (!video) {
          sendResponse({ type: 'ERROR', message: 'No video element' });
          return true;
        }
        if (message.command === 'play') {
          video.play();
        } else if (message.command === 'pause') {
          video.pause();
        }
        sendResponse({ success: true });
        return true;
      }

      case 'PLAYER_SEEK': {
        if (!video) {
          sendResponse({ type: 'ERROR', message: 'No video element' });
          return true;
        }
        video.currentTime = message.time;
        sendResponse({ success: true });
        return true;
      }

      case 'PLAYER_SET_RATE': {
        if (!video) {
          sendResponse({ type: 'ERROR', message: 'No video element' });
          return true;
        }
        video.playbackRate = message.rate;
        sendResponse({ success: true });
        return true;
      }

      case 'PLAYER_SET_VOLUME': {
        if (!video) {
          sendResponse({ type: 'ERROR', message: 'No video element' });
          return true;
        }
        video.volume = message.volume;
        sendResponse({ success: true });
        return true;
      }
    }

    return false;
  }
);

/** Initialize: wait for video element, then set up */
function init() {
  const video = getVideoElement();
  if (video) {
    setupVideoEventListeners();
    startStatePolling();
    chrome.runtime.sendMessage({ type: 'CONTENT_READY' } as ContentResponse);
    return;
  }

  const observer = new MutationObserver((_mutations, obs) => {
    const v = getVideoElement();
    if (v) {
      obs.disconnect();
      setupVideoEventListeners();
      startStatePolling();
      chrome.runtime.sendMessage({ type: 'CONTENT_READY' } as ContentResponse);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

init();
