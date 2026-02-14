/**
 * JS port of the project's TypeScript beat detection algorithm
 * (src/audio/beatDetector.ts).
 *
 * This is a direct, line-for-line port so we can benchmark the exact same
 * algorithm running in Node.js against the Python alternatives.
 *
 * Pipeline (mirrors beatDetector.ts):
 *   1. RMS energy envelope in 10 ms windows with half-window hops
 *   2. Adaptive median-threshold onset detection (threshold=1.5, medianWindow=16)
 *   3. BPM from median inter-onset interval, clamped 60-200
 *   4. Regular beat grid starting at first onset
 *   5. Downbeats every 4th beat
 */

/**
 * Detect beats using the energy-envelope algorithm from beatDetector.ts.
 *
 * @param {Float32Array} audioData  Mono PCM float32 samples
 * @param {number}       sampleRate Sample rate in Hz
 * @returns {{ bpm: number, beats: number[], confidence: number }}
 */
function detectBeats(audioData, sampleRate) {
  const windowSize = Math.floor(sampleRate * 0.01); // 10 ms windows
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
  const onsets = [];
  const threshold = 1.5;
  const medianWindow = 16;

  for (let i = medianWindow; i < numFrames - 1; i++) {
    const window = energy.slice(i - medianWindow, i);
    const sorted = Array.from(window).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    if (
      energy[i] > median * threshold &&
      energy[i] > energy[i - 1] &&
      energy[i] >= energy[i + 1]
    ) {
      const timeInSeconds = (i * hopSize) / sampleRate;
      // Minimum interval between onsets: 200 ms (300 BPM max)
      if (onsets.length === 0 || timeInSeconds - onsets[onsets.length - 1] > 0.2) {
        onsets.push(timeInSeconds);
      }
    }
  }

  // Step 3: Estimate BPM from inter-onset intervals
  if (onsets.length < 2) {
    return { bpm: 120, beats: onsets, confidence: 0 };
  }

  const intervals = [];
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
  const beats = [];
  const duration = audioData.length / sampleRate;
  let t = onsets[0];
  while (t < duration) {
    beats.push(t);
    t += beatInterval;
  }

  // Confidence based on how regular the intervals are
  const deviations = intervals.map((iv) => Math.abs(iv - medianInterval));
  const avgDeviation = deviations.reduce((a, b) => a + b, 0) / deviations.length;
  const confidence = Math.max(0, 1 - avgDeviation / medianInterval);

  return { bpm: clampedBpm, beats, confidence };
}

/**
 * Estimate downbeats (first beat of each bar, assuming 4/4 time).
 *
 * @param {number[]} beats       Beat timestamps in seconds
 * @param {number}   beatsPerBar Beats per bar (default 4)
 * @returns {number[]}
 */
function estimateDownbeats(beats, beatsPerBar = 4) {
  const downbeats = [];
  for (let i = 0; i < beats.length; i += beatsPerBar) {
    downbeats.push(beats[i]);
  }
  return downbeats;
}

/**
 * Analyze audio data and return an AnalyzerResult-compatible object.
 *
 * @param {Float32Array} audioData  Mono PCM float32 samples
 * @param {number}       sampleRate Sample rate in Hz
 * @returns {Promise<object>}       AnalyzerResult-compatible object
 */
export async function analyze(audioData, sampleRate) {
  const { bpm, beats, confidence } = detectBeats(audioData, sampleRate);
  const downbeats = estimateDownbeats(beats);

  return {
    analyzer_name: 'current_ts',
    bpm,
    bpm_confidence: confidence,
    beats,
    downbeats,
    metadata: {},
  };
}
