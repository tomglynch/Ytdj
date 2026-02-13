import { describe, it, expect } from 'vitest';
import {
  calculateTempoMatchRate,
  calculatePhaseOffset,
  calculateBeatAlignSeek,
  generateSyncCommands,
  calculateDriftCorrection,
  getBeatPosition,
} from '../src/audio/syncEngine';
import { DeckState, TrackAnalysis } from '../src/types';

/** Helper to create a mock deck state */
function mockDeck(overrides: Partial<DeckState> = {}): DeckState {
  return {
    id: 'A',
    videoId: 'test',
    tabId: 1,
    playing: true,
    currentTime: 0,
    playbackRate: 1.0,
    volume: 1.0,
    analysis: null,
    currentBeatIndex: 0,
    isMaster: false,
    ...overrides,
  };
}

/** Helper to create mock analysis with regular beats */
function mockAnalysis(bpm: number, duration: number = 180): TrackAnalysis {
  const beatInterval = 60 / bpm;
  const beats: number[] = [];
  for (let t = 0; t < duration; t += beatInterval) {
    beats.push(t);
  }
  const downbeats = beats.filter((_, i) => i % 4 === 0);

  return {
    videoId: 'test',
    title: 'Test Track',
    bpm,
    bpmConfidence: 0.95,
    beats,
    downbeats,
    duration,
    waveformPeaks: new Float32Array(duration * 200),
    analyzedAt: Date.now(),
  };
}

describe('calculateTempoMatchRate', () => {
  it('should return 1.0 for matching BPMs', () => {
    expect(calculateTempoMatchRate(120, 120)).toBeCloseTo(1.0);
  });

  it('should calculate correct ratio for different BPMs', () => {
    // 128 BPM master, 120 BPM slave -> slave needs to speed up
    expect(calculateTempoMatchRate(128, 120)).toBeCloseTo(128 / 120);
  });

  it('should handle double/half time BPMs', () => {
    // 140 BPM master, 70 BPM slave -> ratio would be 2.0, keep as-is or halve
    const rate = calculateTempoMatchRate(140, 70);
    expect(rate).toBeGreaterThanOrEqual(0.25);
    expect(rate).toBeLessThanOrEqual(2.0);
  });

  it('should clamp to YouTube range (0.25 - 2.0)', () => {
    expect(calculateTempoMatchRate(200, 50)).toBeLessThanOrEqual(2.0);
    expect(calculateTempoMatchRate(50, 200)).toBeGreaterThanOrEqual(0.25);
  });

  it('should return 1.0 for zero BPM', () => {
    expect(calculateTempoMatchRate(0, 120)).toBe(1.0);
    expect(calculateTempoMatchRate(120, 0)).toBe(1.0);
  });
});

describe('calculatePhaseOffset', () => {
  it('should return 0 when both decks are at beat positions', () => {
    const masterAnalysis = mockAnalysis(120);
    const master = mockDeck({ currentTime: 0.5, analysis: masterAnalysis, isMaster: true });
    const slave = mockDeck({ id: 'B', currentTime: 0.5, analysis: mockAnalysis(120) });

    const offset = calculatePhaseOffset(master, slave);
    expect(Math.abs(offset)).toBeLessThan(0.001);
  });

  it('should detect positive phase offset (slave ahead)', () => {
    const analysis = mockAnalysis(120); // beats every 0.5s
    const master = mockDeck({ currentTime: 1.0, analysis, isMaster: true }); // on beat
    const slave = mockDeck({ id: 'B', currentTime: 1.1, analysis: mockAnalysis(120) }); // 0.1s ahead

    const offset = calculatePhaseOffset(master, slave);
    expect(offset).toBeGreaterThan(0);
  });

  it('should return 0 when analysis is missing', () => {
    const master = mockDeck({ isMaster: true });
    const slave = mockDeck({ id: 'B' });
    expect(calculatePhaseOffset(master, slave)).toBe(0);
  });
});

describe('calculateBeatAlignSeek', () => {
  it('should return null when already aligned', () => {
    const analysis = mockAnalysis(120);
    const master = mockDeck({ currentTime: 1.0, analysis, isMaster: true });
    const slave = mockDeck({ id: 'B', currentTime: 1.0, analysis: mockAnalysis(120) });

    expect(calculateBeatAlignSeek(master, slave, 'beat')).toBeNull();
  });

  it('should return a seek position when out of phase', () => {
    const analysis = mockAnalysis(120);
    const master = mockDeck({ currentTime: 1.0, analysis, isMaster: true });
    const slave = mockDeck({ id: 'B', currentTime: 1.15, analysis: mockAnalysis(120) });

    const seekTo = calculateBeatAlignSeek(master, slave, 'beat');
    expect(seekTo).not.toBeNull();
    expect(seekTo).toBeGreaterThanOrEqual(0);
  });

  it('should return null without analysis', () => {
    const master = mockDeck({ isMaster: true });
    const slave = mockDeck({ id: 'B' });
    expect(calculateBeatAlignSeek(master, slave)).toBeNull();
  });
});

describe('generateSyncCommands', () => {
  it('should return empty array when sync is off', () => {
    const master = mockDeck({ analysis: mockAnalysis(120), isMaster: true });
    const slave = mockDeck({ id: 'B', analysis: mockAnalysis(128) });

    const commands = generateSyncCommands(master, slave, 'off');
    expect(commands).toEqual([]);
  });

  it('should generate rate command for tempo sync', () => {
    const master = mockDeck({ analysis: mockAnalysis(128), isMaster: true });
    const slave = mockDeck({ id: 'B', analysis: mockAnalysis(120), playbackRate: 1.0 });

    const commands = generateSyncCommands(master, slave, 'tempo');
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.some(c => c.type === 'rate')).toBe(true);

    const rateCmd = commands.find(c => c.type === 'rate');
    expect(rateCmd?.rate).toBeCloseTo(128 / 120);
  });

  it('should generate seek + rate for beatSync', () => {
    const master = mockDeck({
      currentTime: 5.0,
      analysis: mockAnalysis(120),
      isMaster: true,
    });
    const slave = mockDeck({
      id: 'B',
      currentTime: 5.15, // Out of phase
      analysis: mockAnalysis(128),
      playbackRate: 1.0,
    });

    const commands = generateSyncCommands(master, slave, 'beatSync');
    expect(commands.length).toBeGreaterThan(0);
  });

  it('should not generate commands without analysis', () => {
    const master = mockDeck({ isMaster: true });
    const slave = mockDeck({ id: 'B' });

    const commands = generateSyncCommands(master, slave, 'beatSync');
    expect(commands).toEqual([]);
  });
});

describe('calculateDriftCorrection', () => {
  it('should return 0 when in phase', () => {
    const analysis = mockAnalysis(120);
    const master = mockDeck({ currentTime: 1.0, analysis, isMaster: true });
    const slave = mockDeck({ id: 'B', currentTime: 1.0, analysis: mockAnalysis(120) });

    expect(calculateDriftCorrection(master, slave, 1.0)).toBe(0);
  });

  it('should return non-zero correction when drifted', () => {
    const analysis = mockAnalysis(120);
    const master = mockDeck({ currentTime: 5.0, analysis, isMaster: true });
    // Slave is 50ms ahead - beyond drift threshold
    const slaveAnalysis = mockAnalysis(120);
    const slave = mockDeck({ id: 'B', currentTime: 5.05, analysis: slaveAnalysis });

    const correction = calculateDriftCorrection(master, slave, 1.0);
    // Should slow down slave (negative correction) since slave is ahead
    expect(correction).not.toBe(0);
  });

  it('should return 0 without analysis', () => {
    const master = mockDeck({ isMaster: true });
    const slave = mockDeck({ id: 'B' });
    expect(calculateDriftCorrection(master, slave, 1.0)).toBe(0);
  });
});

describe('getBeatPosition', () => {
  it('should return beat index and fraction', () => {
    const analysis = mockAnalysis(120); // beats at 0, 0.5, 1.0, 1.5, ...
    const deck = mockDeck({ currentTime: 1.25, analysis });

    const pos = getBeatPosition(deck);
    expect(pos.beatIndex).toBe(2); // beat at 1.0s
    expect(pos.fraction).toBeCloseTo(0.5); // halfway to next beat
  });

  it('should handle no analysis', () => {
    const deck = mockDeck();
    const pos = getBeatPosition(deck);
    expect(pos.beatIndex).toBe(0);
    expect(pos.fraction).toBe(0);
  });

  it('should clamp fraction to 0-1', () => {
    const analysis = mockAnalysis(120);
    const deck = mockDeck({ currentTime: 0.0, analysis });

    const pos = getBeatPosition(deck);
    expect(pos.fraction).toBeGreaterThanOrEqual(0);
    expect(pos.fraction).toBeLessThanOrEqual(1);
  });
});
