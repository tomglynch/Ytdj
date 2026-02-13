/**
 * Offscreen document for audio processing.
 *
 * This runs in a full DOM context (unlike the service worker) so it can:
 * - Accumulate audio chunks over time
 * - Run CPU-intensive beat detection without blocking the service worker
 * - Eventually load Essentia.js + WASM when needed
 *
 * Communication:
 *   Background sends: ANALYZE_AUDIO { audioData: number[], videoId, title, sampleRate }
 *   Offscreen sends:  ANALYSIS_RESULT { analysis: TrackAnalysisSerialized }
 *                  or ANALYSIS_ERROR { error: string }
 */

import { analyzeTrack } from '../audio/beatDetector';
import { TrackAnalysisSerialized } from '../types';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'ANALYZE_AUDIO') {
    const { audioData, videoId, title, sampleRate } = message as {
      type: string;
      audioData: number[];
      videoId: string;
      title: string;
      sampleRate: number;
    };

    try {
      const pcm = new Float32Array(audioData);
      const analysis = analyzeTrack(pcm, videoId, title, {
        sampleRate,
        onProgress: (p) => {
          chrome.runtime.sendMessage({
            type: 'ANALYSIS_PROGRESS_FROM_OFFSCREEN',
            videoId,
            progress: p,
          });
        },
      });

      // Serialize for message passing (Float32Array -> number[])
      const serialized: TrackAnalysisSerialized = {
        ...analysis,
        waveformPeaks: Array.from(analysis.waveformPeaks),
      };

      chrome.runtime.sendMessage({
        type: 'ANALYSIS_RESULT',
        analysis: serialized,
      });
    } catch (e) {
      chrome.runtime.sendMessage({
        type: 'ANALYSIS_ERROR_FROM_OFFSCREEN',
        videoId,
        error: String(e),
      });
    }

    sendResponse({ received: true });
    return true;
  }

  return false;
});
