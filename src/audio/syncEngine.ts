/**
 * Phase Alignment / Sync Engine
 *
 * Implements DJ-style sync behavior modeled after djay Pro:
 *
 * 1. **Tempo Sync**: Match BPM of slave deck to master deck
 *    - Computes the ratio and sets playback rate accordingly
 *    - YouTube supports 0.25x-2x range
 *
 * 2. **Beat Sync**: Tempo sync + phase alignment
 *    - Finds the current beat position on the master
 *    - Aligns the slave's nearest beat to match
 *    - Applies a seek offset to bring beats in phase
 *
 * 3. **Drift Correction**: Continuous micro-adjustments
 *    - Monitors phase offset over time
 *    - Applies tiny rate adjustments to maintain alignment
 *    - Snaps back once aligned (avoids oscillation)
 *
 * The sync engine operates on the beat grids from TrackAnalysis
 * and produces commands (seek, rate change) for the decks.
 */

import { DeckState, SyncMode, QuantizeMode } from '../types';
import { getNearestBeatIndex, getNextBeatIndex, getNearestDownbeatIndex } from './beatDetector';

/** Sync command to be executed on a deck */
export interface SyncCommand {
  type: 'seek' | 'rate' | 'seek_and_rate';
  seekTo?: number;
  rate?: number;
}

/** Tolerance for considering beats "in phase" (seconds) */
const PHASE_TOLERANCE = 0.020; // 20ms

/** Maximum drift before correction kicks in (seconds) */
const DRIFT_THRESHOLD = 0.030; // 30ms

/** Rate adjustment amount for drift correction */
const DRIFT_CORRECTION_RATE = 0.005; // 0.5% speed change

/** Maximum allowed rate deviation from target for drift correction */
const MAX_DRIFT_CORRECTION = 0.03; // 3%

/**
 * Calculate the playback rate needed to match slave BPM to master BPM.
 * Clamps to YouTube's supported range (0.25 - 2.0).
 */
export function calculateTempoMatchRate(masterBpm: number, slaveBpm: number): number {
  if (slaveBpm <= 0 || masterBpm <= 0) return 1.0;

  const ratio = masterBpm / slaveBpm;

  // If ratio is way off, try doubling/halving to find closer match
  let bestRatio = ratio;
  if (ratio > 1.5) bestRatio = ratio / 2;
  if (ratio < 0.667) bestRatio = ratio * 2;

  // Clamp to YouTube's playback rate range
  return Math.max(0.25, Math.min(2.0, bestRatio));
}

/**
 * Calculate the phase offset between two decks.
 *
 * Phase is measured as the time difference between the current position
 * relative to the beat grid. A phase of 0 means beats are aligned.
 *
 * Returns offset in seconds (positive = slave is ahead, negative = behind).
 */
export function calculatePhaseOffset(
  master: DeckState,
  slave: DeckState
): number {
  if (!master.analysis || !slave.analysis) return 0;
  if (master.analysis.beats.length === 0 || slave.analysis.beats.length === 0) return 0;

  const masterBeats = master.analysis.beats;
  const slaveBeats = slave.analysis.beats;

  // Find the master's current position within its beat cycle
  const masterBeatIdx = getNearestBeatIndex(masterBeats, master.currentTime);
  const masterBeatTime = masterBeats[masterBeatIdx];
  const masterPhase = master.currentTime - masterBeatTime;

  // Find the slave's current position within its beat cycle
  const slaveBeatIdx = getNearestBeatIndex(slaveBeats, slave.currentTime);
  const slaveBeatTime = slaveBeats[slaveBeatIdx];
  const slavePhase = slave.currentTime - slaveBeatTime;

  // Phase offset: how far off the slave's phase is from master's
  return slavePhase - masterPhase;
}

/**
 * Calculate the seek position needed to align the slave's beat
 * to the master's current beat phase.
 *
 * @param master - Master deck state
 * @param slave - Slave deck state
 * @param quantize - Quantize level (beat, bar, phrase)
 * @returns Target seek time for the slave, or null if no adjustment needed
 */
export function calculateBeatAlignSeek(
  master: DeckState,
  slave: DeckState,
  quantize: QuantizeMode = 'beat'
): number | null {
  if (!master.analysis || !slave.analysis) return null;

  const phaseOffset = calculatePhaseOffset(master, slave);

  // Already in phase?
  if (Math.abs(phaseOffset) < PHASE_TOLERANCE) return null;

  const slaveBeats = slave.analysis.beats;
  const slaveDownbeats = slave.analysis.downbeats;

  // Determine alignment target based on quantize mode
  let targetTime: number;

  switch (quantize) {
    case 'bar': {
      // Align to the nearest downbeat
      const dbIdx = getNearestDownbeatIndex(slaveDownbeats, slave.currentTime);
      targetTime = slaveDownbeats[dbIdx] - phaseOffset;
      break;
    }
    case 'phrase': {
      // Align to nearest phrase (4 bars = 16 beats)
      const phraseBeats = slaveDownbeats.filter((_, i) => i % 4 === 0);
      const pIdx = getNearestBeatIndex(phraseBeats, slave.currentTime);
      targetTime = phraseBeats[pIdx] - phaseOffset;
      break;
    }
    case 'beat':
    default: {
      // Simple beat alignment: adjust current position by phase offset
      targetTime = slave.currentTime - phaseOffset;
      break;
    }
  }

  // Ensure we don't seek before start or past end
  targetTime = Math.max(0, Math.min(targetTime, slave.analysis.duration - 0.1));

  return targetTime;
}

/**
 * Generate sync commands for the slave deck based on the current sync mode.
 *
 * @param master - Master deck state
 * @param slave - Slave deck state
 * @param mode - Current sync mode
 * @param quantize - Quantize level
 * @returns Array of commands to execute, or empty if no action needed
 */
export function generateSyncCommands(
  master: DeckState,
  slave: DeckState,
  mode: SyncMode,
  quantize: QuantizeMode = 'beat'
): SyncCommand[] {
  if (mode === 'off') return [];
  if (!master.analysis || !slave.analysis) return [];

  const commands: SyncCommand[] = [];

  // Tempo match
  const targetRate = calculateTempoMatchRate(
    master.analysis.bpm,
    slave.analysis.bpm
  );

  if (Math.abs(slave.playbackRate - targetRate) > 0.001) {
    commands.push({ type: 'rate', rate: targetRate });
  }

  // Beat sync: also align phase
  if (mode === 'beatSync') {
    const seekTo = calculateBeatAlignSeek(master, slave, quantize);
    if (seekTo !== null) {
      commands.push({ type: 'seek', seekTo });
    }
  }

  return commands;
}

/**
 * Calculate drift correction adjustment.
 *
 * When beat sync is active, this monitors the ongoing phase offset
 * and makes tiny rate adjustments to prevent drift.
 *
 * Returns a rate adjustment to apply on top of the tempo-matched rate,
 * or 0 if no correction needed.
 */
export function calculateDriftCorrection(
  master: DeckState,
  slave: DeckState,
  baseRate: number
): number {
  if (!master.analysis || !slave.analysis) return 0;

  const phaseOffset = calculatePhaseOffset(master, slave);

  // Within tolerance - no correction needed
  if (Math.abs(phaseOffset) < PHASE_TOLERANCE) return 0;

  // Outside drift threshold - apply correction
  if (Math.abs(phaseOffset) > DRIFT_THRESHOLD) {
    // Proportional correction: larger offset = larger correction
    const correction = Math.sign(phaseOffset) * DRIFT_CORRECTION_RATE *
      Math.min(1, Math.abs(phaseOffset) / 0.1);

    // Clamp total correction
    const totalCorrection = Math.max(-MAX_DRIFT_CORRECTION, Math.min(MAX_DRIFT_CORRECTION, correction));

    // Apply as a rate reduction/increase (slave ahead = slow down, behind = speed up)
    return -totalCorrection;
  }

  return 0;
}

/**
 * Compute the "virtual position" in beats for a deck.
 * Useful for UI display - shows position as beat number + fraction.
 */
export function getBeatPosition(deck: DeckState): { beatIndex: number; fraction: number } {
  if (!deck.analysis || deck.analysis.beats.length === 0) {
    return { beatIndex: 0, fraction: 0 };
  }

  const beats = deck.analysis.beats;
  const time = deck.currentTime;

  // Find surrounding beats
  let idx = 0;
  for (let i = 0; i < beats.length - 1; i++) {
    if (beats[i] <= time && beats[i + 1] > time) {
      idx = i;
      break;
    }
    if (i === beats.length - 2) idx = i;
  }

  const beatStart = beats[idx];
  const beatEnd = idx < beats.length - 1 ? beats[idx + 1] : beatStart + (60 / deck.analysis.bpm);
  const fraction = (time - beatStart) / (beatEnd - beatStart);

  return { beatIndex: idx, fraction: Math.max(0, Math.min(1, fraction)) };
}
