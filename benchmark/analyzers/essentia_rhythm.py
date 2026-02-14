"""
Analyzer wrapping Essentia's RhythmExtractor2013.

RhythmExtractor2013 is the most comprehensive beat-tracking algorithm in
Essentia, returning BPM, beat positions (ticks), a confidence score,
per-frame BPM estimates, and inter-beat intervals — all in a single call.

Downbeats are estimated by grouping beats into bars of 4 (common time).
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import essentia.standard

# Ensure the benchmark root is importable so we can reach interface.py.
sys.path.insert(0, str(Path(__file__).parent.parent))
from interface import BaseAnalyzer, AnalyzerResult


class EssentiaRhythm2013Analyzer(BaseAnalyzer):
    """Beat tracker backed by Essentia's RhythmExtractor2013.

    RhythmExtractor2013 combines multiple tempo-estimation strategies
    (multi-feature, degara, multifeature) and returns:

      - bpm:            global BPM estimate
      - ticks:          beat positions in seconds
      - confidence:     overall confidence in [0, 1]
      - estimates:      array of per-window BPM estimates
      - bpmIntervals:   array of inter-beat intervals (seconds)
    """

    name = "essentia_rhythm2013"
    capabilities = {"bpm", "beats", "downbeats"}

    def analyze(self, audio: np.ndarray, sr: int) -> AnalyzerResult:
        # RhythmExtractor2013 expects a plain float32 vector.
        # Essentia typically operates at 44100 Hz; the audio loader in
        # interface.py already resamples to that rate.
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)

        extractor = essentia.standard.RhythmExtractor2013()
        bpm, ticks, confidence, estimates, bpm_intervals = extractor(audio)

        bpm = float(bpm)
        confidence = float(confidence)
        ticks = ticks.tolist() if hasattr(ticks, "tolist") else list(ticks)

        # ------------------------------------------------------------------
        # Downbeat estimation
        # ------------------------------------------------------------------
        # RhythmExtractor2013 does not directly output downbeat positions.
        # We approximate them by grouping every `beats_per_bar` beats and
        # treating the first beat of each group as a downbeat.
        #
        # Default assumption: 4/4 time (beats_per_bar = 4).
        # If Essentia's BeatTrackerDegara or other components ever expose a
        # time-signature estimate, it could be plugged in here.
        beats_per_bar = 4
        downbeats = self._estimate_downbeats(ticks, beats_per_bar)

        # ------------------------------------------------------------------
        # Pack metadata for downstream analysis
        # ------------------------------------------------------------------
        metadata = {
            "num_beats": len(ticks),
            "num_downbeats": len(downbeats),
            "beats_per_bar": beats_per_bar,
            "estimates": (
                estimates.tolist()
                if hasattr(estimates, "tolist")
                else list(estimates)
            ),
            "bpm_intervals": (
                bpm_intervals.tolist()
                if hasattr(bpm_intervals, "tolist")
                else list(bpm_intervals)
            ),
        }

        return AnalyzerResult(
            analyzer_name=self.name,
            bpm=bpm,
            bpm_confidence=confidence,
            beats=ticks,
            downbeats=downbeats,
            metadata=metadata,
        )

    # ------------------------------------------------------------------
    # Downbeat helper
    # ------------------------------------------------------------------

    @staticmethod
    def _estimate_downbeats(
        beats: list[float], beats_per_bar: int = 4
    ) -> list[float]:
        """Mark every *beats_per_bar*-th beat as a downbeat.

        Starting from the first detected beat, every Nth beat is considered
        the downbeat (first beat of a new bar).
        """
        return [beats[i] for i in range(0, len(beats), beats_per_bar)]


def create_analyzer() -> EssentiaRhythm2013Analyzer:
    """Factory function expected by the benchmark runner."""
    return EssentiaRhythm2013Analyzer()
