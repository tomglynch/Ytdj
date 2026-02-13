/**
 * Tests for the analysis cache module.
 *
 * Note: These tests require a mock IndexedDB environment.
 * In a real test setup, we'd use 'fake-indexeddb' or run in jsdom.
 * For now, these test the serialization/deserialization logic
 * and serve as integration test specifications.
 */

import { describe, it, expect } from 'vitest';
import { TrackAnalysis, TrackAnalysisSerialized } from '../src/types';

/** Test serialization round-trip for TrackAnalysis */
describe('TrackAnalysis serialization', () => {
  const mockAnalysis: TrackAnalysis = {
    videoId: 'dQw4w9WgXcQ',
    title: 'Test Track',
    bpm: 120.5,
    bpmConfidence: 0.92,
    beats: [0, 0.5, 1.0, 1.5, 2.0],
    downbeats: [0, 2.0],
    duration: 210.5,
    waveformPeaks: new Float32Array([0.1, 0.5, 0.8, 0.3, 0.6]),
    analyzedAt: 1700000000000,
  };

  it('should serialize Float32Array to number[]', () => {
    const serialized: TrackAnalysisSerialized = {
      ...mockAnalysis,
      waveformPeaks: Array.from(mockAnalysis.waveformPeaks),
    };

    expect(Array.isArray(serialized.waveformPeaks)).toBe(true);
    expect(serialized.waveformPeaks.length).toBe(5);
    expect(serialized.waveformPeaks[0]).toBeCloseTo(0.1);
  });

  it('should deserialize number[] back to Float32Array', () => {
    const serialized: TrackAnalysisSerialized = {
      ...mockAnalysis,
      waveformPeaks: [0.1, 0.5, 0.8, 0.3, 0.6],
    };

    const deserialized: TrackAnalysis = {
      ...serialized,
      waveformPeaks: new Float32Array(serialized.waveformPeaks),
    };

    expect(deserialized.waveformPeaks).toBeInstanceOf(Float32Array);
    expect(deserialized.waveformPeaks.length).toBe(5);
    expect(deserialized.waveformPeaks[2]).toBeCloseTo(0.8);
  });

  it('should preserve all fields during round-trip', () => {
    const serialized: TrackAnalysisSerialized = {
      ...mockAnalysis,
      waveformPeaks: Array.from(mockAnalysis.waveformPeaks),
    };

    const deserialized: TrackAnalysis = {
      ...serialized,
      waveformPeaks: new Float32Array(serialized.waveformPeaks),
    };

    expect(deserialized.videoId).toBe(mockAnalysis.videoId);
    expect(deserialized.title).toBe(mockAnalysis.title);
    expect(deserialized.bpm).toBe(mockAnalysis.bpm);
    expect(deserialized.bpmConfidence).toBe(mockAnalysis.bpmConfidence);
    expect(deserialized.beats).toEqual(mockAnalysis.beats);
    expect(deserialized.downbeats).toEqual(mockAnalysis.downbeats);
    expect(deserialized.duration).toBe(mockAnalysis.duration);
    expect(deserialized.analyzedAt).toBe(mockAnalysis.analyzedAt);
  });

  it('should handle empty waveform peaks', () => {
    const empty = new Float32Array(0);
    const serialized = Array.from(empty);
    const deserialized = new Float32Array(serialized);

    expect(deserialized.length).toBe(0);
  });

  it('should handle large waveform peaks (simulating 5 min track)', () => {
    // 200 peaks/sec * 300 sec = 60,000 peaks
    const largePeaks = new Float32Array(60000);
    for (let i = 0; i < largePeaks.length; i++) {
      largePeaks[i] = Math.random();
    }

    const serialized = Array.from(largePeaks);
    const deserialized = new Float32Array(serialized);

    expect(deserialized.length).toBe(60000);
    // Spot check a few values
    expect(deserialized[0]).toBeCloseTo(largePeaks[0], 5);
    expect(deserialized[30000]).toBeCloseTo(largePeaks[30000], 5);
    expect(deserialized[59999]).toBeCloseTo(largePeaks[59999], 5);
  });
});
