/**
 * Content script injected into YouTube tabs.
 * Responsibilities:
 * 1. Capture audio from the YouTube player via Web Audio API
 * 2. Relay playback control commands to the YouTube player
 * 3. Report player state back to the background script
 */

import { ContentMessage, ContentResponse } from '../types';

let audioContext: AudioContext | null = null;
let mediaSource: MediaElementAudioSourceNode | null = null;
let analyserNode: AnalyserNode | null = null;
let gainNode: GainNode | null = null;
let isCapturing = false;
let statePollingInterval: ReturnType<typeof setInterval> | null = null;

/** Find the YouTube video element on the page */
function getVideoElement(): HTMLVideoElement | null {
  // Main YouTube player
  const video = document.querySelector('video.html5-main-video') as HTMLVideoElement
    ?? document.querySelector('video') as HTMLVideoElement;
  return video;
}

/** Extract current player state from the DOM video element */
function getPlayerState(): ContentResponse | null {
  const video = getVideoElement();
  if (!video) {
    return { type: 'ERROR', message: 'No video element found' };
  }

  // Extract video ID from URL
  const urlParams = new URLSearchParams(window.location.search);
  const videoId = urlParams.get('v') || '';

  // Extract title
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
    // Already set up
    return true;
  }

  try {
    audioContext = new AudioContext();
    mediaSource = audioContext.createMediaElementSource(video);
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 2048;
    gainNode = audioContext.createGain();

    // Route: video -> analyser -> gain -> destination
    // This lets us analyze audio while still hearing it
    mediaSource.connect(analyserNode);
    analyserNode.connect(gainNode);
    gainNode.connect(audioContext.destination);

    return true;
  } catch (e) {
    console.error('[YouTube DJ] Audio capture setup failed:', e);
    return false;
  }
}

/** Start capturing audio data and sending it to the background */
function startAudioCapture() {
  if (isCapturing) return;
  if (!setupAudioCapture()) return;
  if (!analyserNode) return;

  isCapturing = true;
  const bufferLength = analyserNode.fftSize;
  const dataArray = new Float32Array(bufferLength);

  function captureFrame() {
    if (!isCapturing || !analyserNode) return;
    analyserNode.getFloatTimeDomainData(dataArray);

    // Send audio data to background
    chrome.runtime.sendMessage({
      type: 'AUDIO_DATA',
      data: Array.from(dataArray),
    } as any);

    requestAnimationFrame(captureFrame);
  }

  captureFrame();
}

/** Stop audio capture */
function stopAudioCapture() {
  isCapturing = false;
}

/** Start polling player state and sending updates to background */
function startStatePolling() {
  if (statePollingInterval) return;

  statePollingInterval = setInterval(() => {
    const state = getPlayerState();
    if (state) {
      chrome.runtime.sendMessage(state);
    }
  }, 100); // 10Hz state updates
}

/** Stop state polling */
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
        const state = getPlayerState();
        sendResponse(state);
        return true;
      }

      case 'CAPTURE_AUDIO': {
        const success = setupAudioCapture();
        if (success) {
          startAudioCapture();
          startStatePolling();
        }
        sendResponse({ success });
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
  const observer = new MutationObserver((_mutations, obs) => {
    const video = getVideoElement();
    if (video) {
      obs.disconnect();
      setupVideoEventListeners();
      startStatePolling();
      chrome.runtime.sendMessage({ type: 'CONTENT_READY' } as ContentResponse);
    }
  });

  // Check immediately
  const video = getVideoElement();
  if (video) {
    setupVideoEventListeners();
    startStatePolling();
    chrome.runtime.sendMessage({ type: 'CONTENT_READY' } as ContentResponse);
  } else {
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

init();
