/**
 * Beat detection module.
 *
 * Uses an energy-envelope peak detection algorithm for BPM and beat grid extraction.
 * This runs in the offscreen document context where we have full DOM access.
 *
 * Future: Essentia.js can be loaded here via importScripts or a Web Worker
 * since the offscreen document supports it. For now, the fallback algorithm
 * is sufficient and has no WASM/dynamic-import complications.
 *
 * Pipeline:
 *   Audio buffer → energy envelope → onset detection → BPM estimation → beat grid
 */

import { TrackAnalysis } from '../types';

/** Configuration for beat detection */
export interface BeatDetectorConfig {
  /** Sample rate of the input audio */
  sampleRate: number;
  /** Callback for progress updates (0-1) */
  onProgress?: (progress: number) => void;
}

const DEFAULT_CONFIG: BeatDetectorConfig = {
  sampleRate: 44100,
};

/**
 * Compute waveform peaks for visualization.
 * Downsamples the audio to `peaksPerSecond` samples per second,
 * taking the max absolute value in each window.
 */
export function computeWaveformPeaks(
  audioData: Float32Array,
  sampleRate: number,
  peaksPerSecond: number = 200
): Float32Array {
  const samplesPerPeak = Math.floor(sampleRate / peaksPerSecond);
  const numPeaks = Math.ceil(audioData.length / samplesPerPeak);
  const peaks = new Float32Array(numPeaks);

  for (let i = 0; i < numPeaks; i++) {
    const start = i * samplesPerPeak;
    const end = Math.min(start + samplesPerPeak, audioData.length);
    let max = 0;
    for (let j = start; j < end; j++) {
      const abs = Math.abs(audioData[j]);
      if (abs > max) max = abs;
    }
    peaks[i] = max;
  }

  return peaks;
}

/**
 * Estimate downbeats from beat positions.
 * Groups beats into bars of `beatsPerBar` (default 4, most common time signature)
 * and marks the first beat of each group as a downbeat.
 */
export function estimateDownbeats(beats: number[], beatsPerBar: number = 4): number[] {
  const downbeats: number[] = [];
  for (let i = 0; i < beats.length; i += beatsPerBar) {
    downbeats.push(beats[i]);
  }
  return downbeats;
}

/**
 * Energy-envelope beat detection algorithm.
 *
 * Algorithm:
 * 1. Compute energy envelope using RMS in short windows
 * 2. Detect onset peaks using adaptive median threshold
 * 3. Estimate BPM from inter-onset intervals
 * 4. Build a regular beat grid quantized to the estimated BPM
 */
export function detectBeats(
  audioData: Float32Array,
  sampleRate: number
): { bpm: number; beats: number[]; confidence: number } {
  const windowSize = Math.floor(sampleRate * 0.01); // 10ms windows
  const hopSize = Math.floor(windowSize / 2);
  const numFrames = Math.floor((audioData.length - windowSize) / hopSize);

  if (numFrames <= 0) {
    return { bpm: 120, beats: [], confidence: 0 };
  }

  // Step 1: Compute energy envelope
  const energy = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    const start = i * hopSize;
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      sum += audioData[start + j] * audioData[start + j];
    }
    energy[i] = Math.sqrt(sum / windowSize);
  }

  // Step 2: Onset detection using adaptive median threshold
  const onsets: number[] = [];
  const threshold = 1.5;
  const medianWindow = 16;

  for (let i = medianWindow; i < numFrames - 1; i++) {
    const window = energy.slice(i - medianWindow, i);
    const sorted = Array.from(window).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    if (energy[i] > median * threshold && energy[i] > energy[i - 1] && energy[i] >= energy[i + 1]) {
      const timeInSeconds = (i * hopSize) / sampleRate;
      // Minimum interval between onsets: 200ms (300 BPM max)
      if (onsets.length === 0 || timeInSeconds - onsets[onsets.length - 1] > 0.2) {
        onsets.push(timeInSeconds);
      }
    }
  }

  // Step 3: Estimate BPM from inter-onset intervals
  if (onsets.length < 2) {
    return { bpm: 120, beats: onsets, confidence: 0 };
  }

  const intervals: number[] = [];
  for (let i = 1; i < onsets.length; i++) {
    intervals.push(onsets[i] - onsets[i - 1]);
  }

  const sorted = [...intervals].sort((a, b) => a - b);
  const medianInterval = sorted[Math.floor(sorted.length / 2)];
  const bpm = 60 / medianInterval;

  // Clamp BPM to reasonable range (60-200)
  const clampedBpm = bpm < 60 ? bpm * 2 : bpm > 200 ? bpm / 2 : bpm;
  const beatInterval = 60 / clampedBpm;

  // Step 4: Build a regular beat grid
  const beats: number[] = [];
  const duration = audioData.length / sampleRate;
  let t = onsets[0];
  while (t < duration) {
    beats.push(t);
    t += beatInterval;
  }

  // Confidence based on how regular the intervals are
  const deviations = intervals.map(i => Math.abs(i - medianInterval));
  const avgDeviation = deviations.reduce((a, b) => a + b, 0) / deviations.length;
  const confidence = Math.max(0, 1 - avgDeviation / medianInterval);

  return { bpm: clampedBpm, beats, confidence };
}

// Keep the old name as an alias for backward compatibility with tests
export const detectBeatsFallback = detectBeats;

/**
 * Analyze a track's audio data for beats, BPM, and waveform.
 * This is a synchronous-capable function (no dynamic imports).
 *
 * @param audioData - Raw PCM audio data (mono, float32)
 * @param videoId - YouTube video ID for caching
 * @param title - Track title
 * @param config - Detection configuration
 * @returns Full track analysis
 */
export function analyzeTrack(
  audioData: Float32Array,
  videoId: string,
  title: string,
  config: Partial<BeatDetectorConfig> = {}
): TrackAnalysis {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { sampleRate, onProgress } = cfg;

  onProgress?.(0);

  const result = detectBeats(audioData, sampleRate);
  onProgress?.(0.6);

  const downbeats = estimateDownbeats(result.beats);
  onProgress?.(0.7);

  const waveformPeaks = computeWaveformPeaks(audioData, sampleRate);
  onProgress?.(0.9);

  const duration = audioData.length / sampleRate;

  const analysis: TrackAnalysis = {
    videoId,
    title,
    bpm: result.bpm,
    bpmConfidence: result.confidence,
    beats: result.beats,
    downbeats,
    duration,
    waveformPeaks,
    analyzedAt: Date.now(),
  };

  onProgress?.(1);
  return analysis;
}

/**
 * Get the index of the nearest beat to a given time position.
 */
export function getNearestBeatIndex(beats: number[], time: number): number {
  if (beats.length === 0) return -1;

  let closest = 0;
  let minDist = Math.abs(beats[0] - time);

  for (let i = 1; i < beats.length; i++) {
    const dist = Math.abs(beats[i] - time);
    if (dist < minDist) {
      minDist = dist;
      closest = i;
    }
    if (beats[i] > time && dist > minDist) break;
  }

  return closest;
}

/**
 * Get the index of the next beat after a given time.
 */
export function getNextBeatIndex(beats: number[], time: number): number {
  for (let i = 0; i < beats.length; i++) {
    if (beats[i] > time) return i;
  }
  return beats.length - 1;
}

/**
 * Get the index of the nearest downbeat to a given time.
 */
export function getNearestDownbeatIndex(downbeats: number[], time: number): number {
  return getNearestBeatIndex(downbeats, time);
}
