/**
 * Meyda-based spectral feature extraction analyzer.
 *
 * Uses Meyda's spectral flux computation for onset detection, then derives
 * BPM and a regular beat grid from the detected onsets.
 *
 * If Meyda fails at runtime (e.g. missing Web Audio API stubs), falls back
 * to a manual FFT-based spectral flux implementation using the same fftjs
 * library that Meyda bundles.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Attempt to load Meyda. It is a CJS module (module.exports = Meyda object).
// In an ESM context with "type":"module", default-import grabs that object.
// ---------------------------------------------------------------------------
let Meyda = null;
try {
  Meyda = require('meyda');
  // CJS default may be wrapped in { default: ... } by some loaders
  if (Meyda && Meyda.default) Meyda = Meyda.default;
} catch (_) {
  Meyda = null;
}

// ---------------------------------------------------------------------------
// Fallback FFT helpers -- used when Meyda cannot run in pure Node.js
// We pull fftjs the same way Meyda does internally.
// ---------------------------------------------------------------------------
let fftjs = null;
try {
  fftjs = require('fftjs');
  if (fftjs && fftjs.default) fftjs = fftjs.default;
} catch (_) {
  fftjs = null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BUFFER_SIZE = 2048;
const HOP_SIZE = 1024;

// ---------------------------------------------------------------------------
// Hanning window (matches Meyda's default)
// ---------------------------------------------------------------------------
function hanningWindow(size) {
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  }
  return win;
}

// ---------------------------------------------------------------------------
// Manual spectral flux via FFT -- fallback path
// ---------------------------------------------------------------------------
function computeAmpSpectrum(frame, fftInstance) {
  const out = fftInstance.createComplexArray();
  fftInstance.realTransform(out, frame);
  fftInstance.completeSpectrum(out);

  const half = frame.length / 2;
  const amp = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    const re = out[2 * i];
    const im = out[2 * i + 1];
    amp[i] = Math.sqrt(re * re + im * im);
  }
  return amp;
}

function spectralFluxManual(currentAmp, previousAmp) {
  let flux = 0;
  for (let i = 0; i < currentAmp.length; i++) {
    const diff = currentAmp[i] - previousAmp[i];
    if (diff > 0) flux += diff;
  }
  return flux;
}

function computeRms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i] * frame[i];
  }
  return Math.sqrt(sum / frame.length);
}

function computeEnergy(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i] * frame[i];
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Feature extraction: iterate over overlapping frames
// ---------------------------------------------------------------------------
function extractFeaturesMeyda(audioData, sampleRate) {
  Meyda.sampleRate = sampleRate;
  Meyda.bufferSize = BUFFER_SIZE;
  Meyda.windowingFunction = 'hanning';

  const numFrames = Math.floor((audioData.length - BUFFER_SIZE) / HOP_SIZE) + 1;
  const fluxValues = [];
  const energyValues = [];
  const rmsValues = [];

  let previousFrame = null;

  for (let i = 0; i < numFrames; i++) {
    const start = i * HOP_SIZE;
    const frame = audioData.slice(start, start + BUFFER_SIZE);

    if (frame.length < BUFFER_SIZE) break;

    // Ensure Float32Array for Meyda
    const signal = frame instanceof Float32Array ? frame : new Float32Array(frame);

    const features = Meyda.extract(
      ['energy', 'rms'],
      signal,
      previousFrame
    );

    // spectralFlux requires previousSignal; extract separately
    let flux = 0;
    if (previousFrame) {
      try {
        flux = Meyda.extract('spectralFlux', signal, previousFrame);
        if (typeof flux !== 'number' || isNaN(flux)) flux = 0;
      } catch (_) {
        flux = 0;
      }
    }

    fluxValues.push(flux);
    energyValues.push(typeof features.energy === 'number' ? features.energy : 0);
    rmsValues.push(typeof features.rms === 'number' ? features.rms : 0);

    previousFrame = signal;
  }

  return { fluxValues, energyValues, rmsValues, numFrames: fluxValues.length };
}

function extractFeaturesFallback(audioData, sampleRate) {
  // Try to use fftjs (the library Meyda ships with)
  let FFT;
  if (fftjs) {
    FFT = fftjs;
  } else {
    // Last resort: inline Cooley-Tukey radix-2 DIT FFT
    FFT = null;
  }

  const numFrames = Math.floor((audioData.length - BUFFER_SIZE) / HOP_SIZE) + 1;
  const fluxValues = [];
  const energyValues = [];
  const rmsValues = [];
  const window = hanningWindow(BUFFER_SIZE);

  let fftInstance = null;
  if (FFT) {
    // fftjs exports a constructor: new FFT(size)
    try {
      fftInstance = new FFT(BUFFER_SIZE);
    } catch (_) {
      fftInstance = null;
    }
  }

  let previousAmp = null;

  for (let i = 0; i < numFrames; i++) {
    const start = i * HOP_SIZE;
    const raw = audioData.slice(start, start + BUFFER_SIZE);
    if (raw.length < BUFFER_SIZE) break;

    // Apply Hanning window
    const frame = new Float32Array(BUFFER_SIZE);
    for (let j = 0; j < BUFFER_SIZE; j++) {
      frame[j] = raw[j] * window[j];
    }

    rmsValues.push(computeRms(raw));
    energyValues.push(computeEnergy(raw));

    if (fftInstance) {
      const currentAmp = computeAmpSpectrum(frame, fftInstance);
      if (previousAmp) {
        fluxValues.push(spectralFluxManual(currentAmp, previousAmp));
      } else {
        fluxValues.push(0);
      }
      previousAmp = currentAmp;
    } else {
      // Without FFT, approximate spectral flux from time-domain energy change
      if (energyValues.length >= 2) {
        const diff = energyValues[energyValues.length - 1] - energyValues[energyValues.length - 2];
        fluxValues.push(diff > 0 ? diff : 0);
      } else {
        fluxValues.push(0);
      }
    }
  }

  return { fluxValues, energyValues, rmsValues, numFrames: fluxValues.length };
}

// ---------------------------------------------------------------------------
// Onset detection from spectral flux via adaptive threshold peak-picking
// ---------------------------------------------------------------------------
function detectOnsets(fluxValues, sampleRate) {
  const onsets = [];
  const localWindowHalf = 8; // look +/- 8 frames for adaptive median
  const thresholdMultiplier = 1.5;
  const minOnsetIntervalSec = 0.1; // 100 ms minimum gap between onsets

  for (let i = 1; i < fluxValues.length; i++) {
    // Positive first difference of spectral flux (onset detection function)
    const odf = Math.max(0, fluxValues[i] - fluxValues[i - 1]);

    // Build local window for adaptive threshold
    const wStart = Math.max(0, i - localWindowHalf);
    const wEnd = Math.min(fluxValues.length, i + localWindowHalf + 1);
    const localFlux = [];
    for (let j = wStart; j < wEnd; j++) {
      localFlux.push(Math.max(0, (j > 0 ? fluxValues[j] - fluxValues[j - 1] : 0)));
    }
    localFlux.sort((a, b) => a - b);
    const median = localFlux[Math.floor(localFlux.length / 2)];

    const adaptiveThreshold = median * thresholdMultiplier;

    if (odf > adaptiveThreshold && odf > 0) {
      // Ensure local peak: current ODF > neighbor ODFs
      const prevOdf = i >= 2 ? Math.max(0, fluxValues[i - 1] - fluxValues[i - 2]) : 0;
      const nextOdf = i + 1 < fluxValues.length
        ? Math.max(0, fluxValues[i + 1] - fluxValues[i])
        : 0;

      if (odf >= prevOdf && odf >= nextOdf) {
        const timeSec = (i * HOP_SIZE) / sampleRate;
        // Enforce minimum inter-onset interval
        if (onsets.length === 0 || timeSec - onsets[onsets.length - 1] > minOnsetIntervalSec) {
          onsets.push(timeSec);
        }
      }
    }
  }

  return onsets;
}

// ---------------------------------------------------------------------------
// BPM estimation from inter-onset intervals
// ---------------------------------------------------------------------------
function estimateBpm(onsets) {
  if (onsets.length < 2) {
    return { bpm: 120, beatInterval: 0.5 };
  }

  const intervals = [];
  for (let i = 1; i < onsets.length; i++) {
    intervals.push(onsets[i] - onsets[i - 1]);
  }

  // Median inter-onset interval
  const sorted = [...intervals].sort((a, b) => a - b);
  const medianInterval = sorted[Math.floor(sorted.length / 2)];

  let bpm = 60 / medianInterval;

  // Clamp to 60-200 BPM range via octave folding
  while (bpm < 60 && bpm > 0) bpm *= 2;
  while (bpm > 200) bpm /= 2;

  // Final safety clamp
  if (bpm < 60 || !isFinite(bpm)) bpm = 120;

  const beatInterval = 60 / bpm;
  return { bpm, beatInterval };
}

// ---------------------------------------------------------------------------
// Build a regular beat grid from first onset and beat interval
// ---------------------------------------------------------------------------
function buildBeatGrid(onsets, beatInterval, duration) {
  if (onsets.length === 0 || beatInterval <= 0) {
    return [];
  }

  const beats = [];
  let t = onsets[0];
  while (t < duration) {
    beats.push(Math.round(t * 1000) / 1000); // round to ms precision
    t += beatInterval;
  }
  return beats;
}

// ---------------------------------------------------------------------------
// Main exported analysis function
// ---------------------------------------------------------------------------
export async function analyze(audioData, sampleRate) {
  const duration = audioData.length / sampleRate;

  // Try Meyda first, fall back to manual implementation
  let features;
  let usedMeyda = false;

  if (Meyda && typeof Meyda.extract === 'function') {
    try {
      features = extractFeaturesMeyda(audioData, sampleRate);
      usedMeyda = true;
    } catch (_) {
      features = null;
    }
  }

  if (!features || features.numFrames === 0) {
    features = extractFeaturesFallback(audioData, sampleRate);
    usedMeyda = false;
  }

  // Onset detection from spectral flux
  const onsets = detectOnsets(features.fluxValues, sampleRate);

  // BPM estimation
  const { bpm, beatInterval } = estimateBpm(onsets);

  // Beat grid
  const beats = buildBeatGrid(onsets, beatInterval, duration);

  return {
    analyzer_name: 'meyda_spectral',
    bpm,
    beats,
    metadata: {
      features_used: 'spectralFlux',
      backend: usedMeyda ? 'meyda' : 'fallback_fft',
      num_onsets: onsets.length,
      num_frames: features.numFrames,
    },
  };
}
