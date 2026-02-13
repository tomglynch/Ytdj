/**
 * Beat detection module using Essentia.js
 *
 * Pipeline:
 *   Audio buffer → Essentia RhythmExtractor2013 → { bpm, beats[], confidence }
 *   Audio buffer → Essentia BeatTrackerDegara → { beats[] } (more accurate positions)
 *
 * We use RhythmExtractor2013 for BPM estimation and initial beats,
 * then refine beat positions if needed.
 *
 * For downbeat detection, we use bar estimation from the rhythm extractor.
 *
 * Waveform peaks are computed separately for visualization.
 */

import { TrackAnalysis } from '../types';

/**
 * Essentia module types (essentia.js doesn't ship perfect TS types).
 * We load essentia.js dynamically in the worker context.
 */
interface EssentiaInstance {
  RhythmExtractor2013: (signal: Float32Array) => {
    bpm: number;
    ticks: Float32Array;
    confidence: number;
    estimates: Float32Array;
    bpmIntervals: Float32Array;
  };
  arrayToVector: (arr: Float32Array) => any;
  vectorToArray: (vec: any) => Float32Array;
}

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
 * Uses a simple heuristic: group beats into bars of 4 (most common time signature)
 * and mark the first beat of each group as a downbeat.
 *
 * A more sophisticated approach would analyze accent patterns,
 * but this works for the vast majority of electronic/pop music.
 */
export function estimateDownbeats(beats: number[], beatsPerBar: number = 4): number[] {
  const downbeats: number[] = [];
  for (let i = 0; i < beats.length; i += beatsPerBar) {
    downbeats.push(beats[i]);
  }
  return downbeats;
}

/**
 * Simple peak-based beat detection as a fallback when Essentia.js is unavailable.
 *
 * Algorithm:
 * 1. Compute energy envelope using RMS in short windows
 * 2. Detect onset peaks using adaptive threshold
 * 3. Estimate BPM from peak intervals
 * 4. Quantize peaks to a regular grid
 */
export function detectBeatsFallback(
  audioData: Float32Array,
  sampleRate: number
): { bpm: number; beats: number[]; confidence: number } {
  const windowSize = Math.floor(sampleRate * 0.01); // 10ms windows
  const hopSize = Math.floor(windowSize / 2);
  const numFrames = Math.floor((audioData.length - windowSize) / hopSize);

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

  // Step 2: Onset detection using spectral flux-like approach
  const onsets: number[] = [];
  const threshold = 1.5; // Adaptive threshold multiplier
  const medianWindow = 16;

  for (let i = medianWindow; i < numFrames - 1; i++) {
    // Local median energy for adaptive threshold
    const window = energy.slice(i - medianWindow, i);
    const sorted = Array.from(window).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    if (energy[i] > median * threshold && energy[i] > energy[i - 1] && energy[i] >= energy[i + 1]) {
      const timeInSeconds = (i * hopSize) / sampleRate;
      // Minimum interval between beats: 200ms (300 BPM max)
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

  // Cluster intervals to find the most common beat period
  const sorted = [...intervals].sort((a, b) => a - b);
  const medianInterval = sorted[Math.floor(sorted.length / 2)];
  const bpm = 60 / medianInterval;

  // Clamp BPM to reasonable range (60-200)
  const clampedBpm = bpm < 60 ? bpm * 2 : bpm > 200 ? bpm / 2 : bpm;
  const beatInterval = 60 / clampedBpm;

  // Step 4: Build a regular beat grid from the estimated BPM
  // Start from the first detected onset
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

/**
 * Analyze a track's audio data for beats, BPM, and waveform.
 *
 * @param audioData - Raw PCM audio data (mono, float32)
 * @param videoId - YouTube video ID for caching
 * @param title - Track title
 * @param config - Detection configuration
 * @returns Full track analysis
 */
export async function analyzeTrack(
  audioData: Float32Array,
  videoId: string,
  title: string,
  config: Partial<BeatDetectorConfig> = {}
): Promise<TrackAnalysis> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { sampleRate, onProgress } = cfg;

  onProgress?.(0);

  // Try Essentia.js first, fall back to simple detection
  let bpm: number;
  let beats: number[];
  let confidence: number;

  try {
    // Dynamic import of essentia.js
    const { Essentia, EssentiaWASM } = await import('essentia.js');
    const essentia: EssentiaInstance = new Essentia(await EssentiaWASM());

    onProgress?.(0.1);

    const result = essentia.RhythmExtractor2013(audioData);
    bpm = result.bpm;
    beats = Array.from(result.ticks);
    confidence = result.confidence;

    onProgress?.(0.6);
  } catch (e) {
    console.warn('[YouTube DJ] Essentia.js unavailable, using fallback beat detection:', e);
    const result = detectBeatsFallback(audioData, sampleRate);
    bpm = result.bpm;
    beats = result.beats;
    confidence = result.confidence;

    onProgress?.(0.6);
  }

  // Compute downbeats
  const downbeats = estimateDownbeats(beats);
  onProgress?.(0.7);

  // Compute waveform peaks for visualization
  const waveformPeaks = computeWaveformPeaks(audioData, sampleRate);
  onProgress?.(0.9);

  const duration = audioData.length / sampleRate;

  const analysis: TrackAnalysis = {
    videoId,
    title,
    bpm,
    bpmConfidence: confidence,
    beats,
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
    // Beats are sorted, so once distance starts increasing, we can stop
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
