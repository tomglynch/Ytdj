"""
Analyzer using Essentia's OnsetRate for combined onset detection.

OnsetRate uses multiple onset detection methods (HFC, complex-domain,
spectral flux, etc.) combined to produce robust onset positions.
This tests Essentia's onset-based approach separately from its dedicated
beat tracking algorithms (e.g. BeatTrackerDegara, BeatTrackerMultiFeature).

BPM is estimated from the reported onset rate or, as a fallback, from
the median inter-onset interval, clamped to 60-200 BPM via octave folding.
"""

import sys
from pathlib import Path

import numpy as np
import essentia.standard

sys.path.insert(0, str(Path(__file__).parent.parent))
from interface import BaseAnalyzer, AnalyzerResult


class EssentiaOnsetsAnalyzer(BaseAnalyzer):
    """BPM and beat detection using Essentia's OnsetRate algorithm."""

    name = "essentia_onsets"
    capabilities = {"bpm", "beats"}

    def analyze(self, audio: np.ndarray, sr: int) -> AnalyzerResult:
        # Ensure audio is float32 as required by Essentia
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)

        # OnsetRate returns (onsets, onsetRate)
        #   onsets    = onset positions in seconds
        #   onsetRate = average number of onsets per second
        onsets, onset_rate = essentia.standard.OnsetRate()(audio)
        onset_times = onsets.tolist()

        # Estimate BPM ---------------------------------------------------------
        # Primary: derive from onset rate (onsets/sec * 60 = onsets/min)
        bpm = self._bpm_from_rate(onset_rate)

        # Fallback: use median inter-onset interval if rate-based BPM is outside
        # a reasonable musical range or unavailable
        if bpm is None:
            bpm = self._bpm_from_intervals(onset_times)

        return AnalyzerResult(
            analyzer_name=self.name,
            bpm=bpm,
            beats=onset_times,
            metadata={
                "algorithm": "OnsetRate",
                "onset_rate_per_sec": float(onset_rate),
                "num_onsets": len(onset_times),
            },
        )

    @staticmethod
    def _bpm_from_rate(onset_rate: float) -> float | None:
        """Convert onsets-per-second to BPM, clamped to 60-200 via octave folding."""
        if onset_rate <= 0:
            return None

        bpm = float(onset_rate) * 60.0

        # Octave-fold into the musically reasonable range
        while bpm > 200.0:
            bpm /= 2.0
        while bpm < 60.0:
            bpm *= 2.0

        # If folding still lands outside [60, 200] (e.g. extremely low rate),
        # fall back to interval-based estimation.
        if not (60.0 <= bpm <= 200.0):
            return None

        return round(bpm, 2)

    @staticmethod
    def _bpm_from_intervals(onset_times: list[float]) -> float | None:
        """Estimate BPM from median inter-onset interval, clamped to 60-200."""
        if len(onset_times) < 2:
            return None

        intervals = np.diff(onset_times)
        intervals = intervals[intervals > 0]
        if len(intervals) == 0:
            return None

        median_ioi = float(np.median(intervals))
        if median_ioi <= 0:
            return None

        bpm = 60.0 / median_ioi

        # Octave-fold into reasonable range
        while bpm > 200.0:
            bpm /= 2.0
        while bpm < 60.0:
            bpm *= 2.0

        return round(bpm, 2)


def create_analyzer() -> EssentiaOnsetsAnalyzer:
    return EssentiaOnsetsAnalyzer()
