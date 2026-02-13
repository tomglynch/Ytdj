import { describe, it, expect } from 'vitest';
import {
  computeWaveformPeaks,
  estimateDownbeats,
  detectBeatsFallback,
  getNearestBeatIndex,
  getNextBeatIndex,
} from '../src/audio/beatDetector';

describe('computeWaveformPeaks', () => {
  it('should downsample audio to the specified peaks per second', () => {
    const sampleRate = 44100;
    const duration = 1; // 1 second
    const audio = new Float32Array(sampleRate * duration);

    // Fill with a simple sine wave at 440Hz
    for (let i = 0; i < audio.length; i++) {
      audio[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate);
    }

    const peaks = computeWaveformPeaks(audio, sampleRate, 200);

    // Should have ~200 peaks for 1 second of audio (ceil division may add 1)
    expect(peaks.length).toBeGreaterThanOrEqual(200);
    expect(peaks.length).toBeLessThanOrEqual(201);

    // All peaks should be > 0 (sine wave)
    for (let i = 0; i < peaks.length; i++) {
      expect(peaks[i]).toBeGreaterThan(0);
    }

    // Peaks should be <= 1.0 (normalized sine)
    for (let i = 0; i < peaks.length; i++) {
      expect(peaks[i]).toBeLessThanOrEqual(1.0);
    }
  });

  it('should handle empty audio', () => {
    const peaks = computeWaveformPeaks(new Float32Array(0), 44100, 200);
    expect(peaks.length).toBe(0);
  });

  it('should handle very short audio', () => {
    const audio = new Float32Array(100);
    audio[50] = 0.5;
    const peaks = computeWaveformPeaks(audio, 44100, 200);
    expect(peaks.length).toBeGreaterThan(0);
  });
});

describe('estimateDownbeats', () => {
  it('should return every 4th beat as a downbeat by default', () => {
    const beats = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5];
    const downbeats = estimateDownbeats(beats);
    expect(downbeats).toEqual([0, 2.0]);
  });

  it('should handle custom beats per bar', () => {
    const beats = [0, 0.5, 1.0, 1.5, 2.0, 2.5];
    const downbeats = estimateDownbeats(beats, 3);
    expect(downbeats).toEqual([0, 1.5]);
  });

  it('should handle empty beats', () => {
    expect(estimateDownbeats([])).toEqual([]);
  });

  it('should handle fewer beats than beats per bar', () => {
    const beats = [0, 0.5];
    const downbeats = estimateDownbeats(beats, 4);
    expect(downbeats).toEqual([0]);
  });
});

describe('detectBeatsFallback', () => {
  it('should detect BPM of a click track', () => {
    const sampleRate = 44100;
    const bpm = 120;
    const beatInterval = 60 / bpm;
    const duration = 10; // 10 seconds
    const audio = new Float32Array(sampleRate * duration);

    // Create a click track: short impulses at every beat
    for (let beat = 0; beat < duration / beatInterval; beat++) {
      const samplePos = Math.floor(beat * beatInterval * sampleRate);
      // Short 5ms click
      for (let j = 0; j < sampleRate * 0.005 && samplePos + j < audio.length; j++) {
        audio[samplePos + j] = 0.9 * Math.sin(2 * Math.PI * 1000 * j / sampleRate);
      }
    }

    const result = detectBeatsFallback(audio, sampleRate);

    // BPM should be within 10% of target
    expect(result.bpm).toBeGreaterThan(bpm * 0.9);
    expect(result.bpm).toBeLessThan(bpm * 1.1);

    // Should detect multiple beats
    expect(result.beats.length).toBeGreaterThan(5);

    // Confidence should be reasonable
    expect(result.confidence).toBeGreaterThan(0.3);
  });

  it('should handle silence gracefully', () => {
    const audio = new Float32Array(44100 * 5); // 5 seconds of silence
    const result = detectBeatsFallback(audio, 44100);

    // Should return some result without crashing
    expect(result.bpm).toBeGreaterThan(0);
    expect(result.beats).toBeDefined();
  });

  it('should clamp BPM to 60-200 range', () => {
    const sampleRate = 44100;
    const audio = new Float32Array(sampleRate * 5);

    // Very fast clicks at 300 BPM should be halved
    const interval = 60 / 300;
    for (let beat = 0; beat < 5 / interval; beat++) {
      const pos = Math.floor(beat * interval * sampleRate);
      if (pos < audio.length) {
        for (let j = 0; j < 100 && pos + j < audio.length; j++) {
          audio[pos + j] = 0.9;
        }
      }
    }

    const result = detectBeatsFallback(audio, sampleRate);
    expect(result.bpm).toBeLessThanOrEqual(200);
    expect(result.bpm).toBeGreaterThanOrEqual(60);
  });
});

describe('getNearestBeatIndex', () => {
  const beats = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0];

  it('should find exact match', () => {
    expect(getNearestBeatIndex(beats, 1.0)).toBe(2);
  });

  it('should find nearest beat when between beats', () => {
    expect(getNearestBeatIndex(beats, 1.2)).toBe(2); // Closer to 1.0
    expect(getNearestBeatIndex(beats, 1.3)).toBe(3); // Closer to 1.5
  });

  it('should handle time before first beat', () => {
    expect(getNearestBeatIndex(beats, -0.1)).toBe(0);
  });

  it('should handle time after last beat', () => {
    expect(getNearestBeatIndex(beats, 5.0)).toBe(6);
  });

  it('should return -1 for empty beats', () => {
    expect(getNearestBeatIndex([], 1.0)).toBe(-1);
  });
});

describe('getNextBeatIndex', () => {
  const beats = [0, 0.5, 1.0, 1.5, 2.0];

  it('should find next beat after current time', () => {
    expect(getNextBeatIndex(beats, 0.3)).toBe(1);
    expect(getNextBeatIndex(beats, 1.0)).toBe(3); // Next after exact match
  });

  it('should return last index when past all beats', () => {
    expect(getNextBeatIndex(beats, 5.0)).toBe(4);
  });
});
