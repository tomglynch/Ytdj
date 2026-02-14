"""
Python port of the TypeScript energy-envelope beat detection algorithm
from src/audio/beatDetector.ts.

Pipeline:
  Audio buffer -> RMS energy envelope (10ms windows) -> adaptive median
  threshold onset detection -> median inter-onset interval BPM estimation
  -> regular beat grid -> downbeats every 4 beats
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))
from interface import BaseAnalyzer, AnalyzerResult


class CurrentEnergyAnalyzer(BaseAnalyzer):
    """Energy-envelope beat detector, faithful port of the TypeScript original."""

    name = "current_energy"
    capabilities = {"bpm", "beats", "downbeats"}

    def analyze(self, audio: np.ndarray, sr: int) -> AnalyzerResult:
        bpm, beats, confidence = self._detect_beats(audio, sr)
        downbeats = self._estimate_downbeats(beats, beats_per_bar=4)
        return AnalyzerResult(
            analyzer_name=self.name,
            bpm=bpm,
            bpm_confidence=confidence,
            beats=beats,
            downbeats=downbeats,
        )

    # ------------------------------------------------------------------
    # Core algorithm — mirrors detectBeats() in beatDetector.ts
    # ------------------------------------------------------------------

    @staticmethod
    def _detect_beats(
        audio_data: np.ndarray, sample_rate: int
    ) -> tuple[float, list[float], float]:
        """
        Energy-envelope beat detection.

        1. Compute energy envelope using RMS in 10ms windows (hop = window/2).
        2. Detect onset peaks using an adaptive median threshold.
        3. Estimate BPM from the median inter-onset interval.
        4. Build a regular beat grid quantized to the estimated BPM.

        Returns (bpm, beats, confidence).
        """
        window_size = int(sample_rate * 0.01)  # 10ms windows
        hop_size = window_size // 2
        num_frames = (len(audio_data) - window_size) // hop_size

        if num_frames <= 0:
            return 120.0, [], 0.0

        # Step 1: Compute energy envelope (RMS per frame)
        # Build a 2-D view of overlapping frames for vectorised RMS.
        frame_starts = np.arange(num_frames) * hop_size
        # indices: shape (num_frames, window_size)
        indices = frame_starts[:, np.newaxis] + np.arange(window_size)
        frames = audio_data[indices]
        energy = np.sqrt(np.mean(frames * frames, axis=1))

        # Step 2: Onset detection using adaptive median threshold
        threshold = 1.5
        median_window = 16
        onsets: list[float] = []

        for i in range(median_window, num_frames - 1):
            window = energy[i - median_window : i]
            median = float(np.median(window))

            if (
                energy[i] > median * threshold
                and energy[i] > energy[i - 1]
                and energy[i] >= energy[i + 1]
            ):
                time_s = (i * hop_size) / sample_rate
                # Minimum 200ms between onsets (caps at ~300 BPM)
                if len(onsets) == 0 or time_s - onsets[-1] > 0.2:
                    onsets.append(time_s)

        # Step 3: Estimate BPM from inter-onset intervals
        if len(onsets) < 2:
            return 120.0, onsets, 0.0

        intervals = np.diff(onsets)
        median_interval = float(np.median(intervals))
        bpm = 60.0 / median_interval

        # Clamp BPM to [60, 200] by halving / doubling
        if bpm < 60:
            clamped_bpm = bpm * 2
        elif bpm > 200:
            clamped_bpm = bpm / 2
        else:
            clamped_bpm = bpm

        beat_interval = 60.0 / clamped_bpm

        # Step 4: Build a regular beat grid starting at the first onset
        duration = len(audio_data) / sample_rate
        beats: list[float] = []
        t = onsets[0]
        while t < duration:
            beats.append(t)
            t += beat_interval

        # Confidence: how regular the raw onset intervals are
        deviations = np.abs(intervals - median_interval)
        avg_deviation = float(np.mean(deviations))
        confidence = max(0.0, 1.0 - avg_deviation / median_interval)

        return clamped_bpm, beats, confidence

    # ------------------------------------------------------------------
    # Downbeat estimation — mirrors estimateDownbeats() in beatDetector.ts
    # ------------------------------------------------------------------

    @staticmethod
    def _estimate_downbeats(
        beats: list[float], beats_per_bar: int = 4
    ) -> list[float]:
        """Mark every *beats_per_bar*-th beat as a downbeat."""
        return [beats[i] for i in range(0, len(beats), beats_per_bar)]


def create_analyzer() -> CurrentEnergyAnalyzer:
    """Factory required by the benchmark runner."""
    return CurrentEnergyAnalyzer()
