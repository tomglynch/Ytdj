"""
Analyzer using librosa's onset detection with spectral flux methods.

Uses onset_strength + onset_detect (with backtracking) to find note onsets,
then estimates BPM from median inter-onset intervals.  This tests whether
spectral-flux onset detection outperforms the current energy-envelope approach
used by librosa's default beat_track.
"""

import sys
from pathlib import Path

import numpy as np
import librosa

sys.path.insert(0, str(Path(__file__).parent.parent))
from interface import BaseAnalyzer, AnalyzerResult


class LibrosaOnsetAnalyzer(BaseAnalyzer):
    """Beat / BPM detection via librosa spectral-flux onset detection."""

    name = "librosa_onset"
    capabilities = {"bpm", "beats"}

    def analyze(self, audio: np.ndarray, sr: int) -> AnalyzerResult:
        # Compute onset strength envelope (spectral flux based)
        onset_env = librosa.onset.onset_strength(y=audio, sr=sr)

        # Detect onset frames with backtracking for more precise placement
        onset_frames = librosa.onset.onset_detect(
            y=audio, sr=sr, onset_envelope=onset_env, backtrack=True
        )

        # Convert frame indices to time stamps
        onset_times = librosa.frames_to_time(onset_frames, sr=sr).tolist()

        # Estimate BPM from median inter-onset interval
        bpm = self._estimate_bpm(onset_times)

        return AnalyzerResult(
            analyzer_name=self.name,
            bpm=bpm,
            beats=onset_times,
            metadata={
                "num_onsets": len(onset_times),
                "method": "spectral_flux_onset",
            },
        )

    @staticmethod
    def _estimate_bpm(onset_times: list[float]) -> float | None:
        """Estimate BPM from median inter-onset interval, clamped to 60-200."""
        if len(onset_times) < 2:
            return None

        intervals = np.diff(onset_times)
        # Filter out very short intervals (likely not beat-level)
        intervals = intervals[intervals > 0]
        if len(intervals) == 0:
            return None

        median_ioi = float(np.median(intervals))
        if median_ioi <= 0:
            return None

        bpm = 60.0 / median_ioi

        # Clamp to a musically reasonable range (60-200 BPM)
        # Use octave folding: halve or double until within range
        while bpm > 200.0:
            bpm /= 2.0
        while bpm < 60.0:
            bpm *= 2.0

        return round(bpm, 2)


def create_analyzer() -> LibrosaOnsetAnalyzer:
    return LibrosaOnsetAnalyzer()
