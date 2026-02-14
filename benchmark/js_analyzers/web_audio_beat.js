/**
 * web-audio-beat-detector analyzer.
 *
 * The npm package requires Web Audio API (AudioContext, OfflineAudioContext)
 * which aren't available in Node.js. This implements the same core algorithm:
 * - Compute onset envelope via energy in frequency bands
 * - Autocorrelation-based tempo estimation
 * - Peak picking for BPM
 */

export async function analyze(audioData, sampleRate) {
  const name = 'web_audio_beat';

  try {
    // === Step 1: Compute onset strength envelope ===
    const frameSize = 2048;
    const hopSize = 512;
    const numFrames = Math.floor((audioData.length - frameSize) / hopSize);

    if (numFrames < 2) {
      return { analyzer_name: name, bpm: null, beats: [], metadata: { error: 'Audio too short' } };
    }

    // Compute energy per frame
    const energy = new Float32Array(numFrames);
    for (let i = 0; i < numFrames; i++) {
      const start = i * hopSize;
      let sum = 0;
      for (let j = 0; j < frameSize; j++) {
        const s = audioData[start + j];
        sum += s * s;
      }
      energy[i] = Math.sqrt(sum / frameSize);
    }

    // Onset detection function: half-wave rectified first difference
    const odf = new Float32Array(numFrames - 1);
    for (let i = 0; i < numFrames - 1; i++) {
      odf[i] = Math.max(0, energy[i + 1] - energy[i]);
    }

    // === Step 2: Autocorrelation for tempo estimation ===
    const framesPerSecond = sampleRate / hopSize;
    const minBPM = 60;
    const maxBPM = 200;
    const minLag = Math.floor(framesPerSecond * 60 / maxBPM);
    const maxLag = Math.ceil(framesPerSecond * 60 / minBPM);

    // Normalize ODF
    const odfMean = odf.reduce((a, b) => a + b, 0) / odf.length;
    const odfNorm = new Float32Array(odf.length);
    for (let i = 0; i < odf.length; i++) {
      odfNorm[i] = odf[i] - odfMean;
    }

    // Compute autocorrelation for BPM range
    const acLength = Math.min(maxLag + 1, odfNorm.length);
    const autocorr = new Float32Array(acLength);

    for (let lag = minLag; lag < acLength && lag <= maxLag; lag++) {
      let sum = 0;
      const n = odfNorm.length - lag;
      for (let i = 0; i < n; i++) {
        sum += odfNorm[i] * odfNorm[i + lag];
      }
      autocorr[lag] = sum / n;
    }

    // Find peak in autocorrelation
    let bestLag = minLag;
    let bestVal = -Infinity;
    for (let lag = minLag; lag <= maxLag && lag < acLength; lag++) {
      // Apply tempo preference weighting (prefer ~120 BPM range)
      const bpmAtLag = (framesPerSecond * 60) / lag;
      const weight = Math.exp(-0.5 * ((bpmAtLag - 120) / 40) ** 2);
      const weighted = autocorr[lag] * (1 + 0.5 * weight);

      if (weighted > bestVal) {
        bestVal = weighted;
        bestLag = lag;
      }
    }

    const bpm = (framesPerSecond * 60) / bestLag;

    // === Step 3: Build beat grid from onsets ===
    // Find first strong onset
    const odfThreshold = odfMean * 2;
    let firstOnsetFrame = 0;
    for (let i = 0; i < odf.length; i++) {
      if (odf[i] > odfThreshold) {
        firstOnsetFrame = i;
        break;
      }
    }

    const firstOnsetTime = firstOnsetFrame * hopSize / sampleRate;
    const beatInterval = 60 / bpm;
    const duration = audioData.length / sampleRate;

    const beats = [];
    let t = firstOnsetTime;
    while (t < duration) {
      beats.push(Math.round(t * 1000) / 1000);
      t += beatInterval;
    }

    // === Step 4: Confidence from autocorrelation peak strength ===
    // Normalize by zero-lag autocorrelation
    let zeroLagSum = 0;
    for (let i = 0; i < odfNorm.length; i++) {
      zeroLagSum += odfNorm[i] * odfNorm[i];
    }
    const zeroLag = zeroLagSum / odfNorm.length;
    const confidence = zeroLag > 0 ? Math.min(1, Math.max(0, autocorr[bestLag] / zeroLag)) : 0;

    return {
      analyzer_name: name,
      bpm: Math.round(bpm * 10) / 10,
      bpm_confidence: Math.round(confidence * 1000) / 1000,
      beats,
      downbeats: beats.filter((_, i) => i % 4 === 0),
      phrase_boundaries: [],
      metadata: {
        method: 'autocorrelation_onset_envelope',
        note: 'Reimplementation of web-audio-beat-detector algorithm for Node.js',
        best_lag: bestLag,
        frames_per_second: framesPerSecond,
      },
    };
  } catch (err) {
    return {
      analyzer_name: name,
      bpm: null,
      bpm_confidence: null,
      beats: [],
      downbeats: [],
      phrase_boundaries: [],
      metadata: { error: err.message },
    };
  }
}
