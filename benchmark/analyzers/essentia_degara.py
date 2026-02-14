"""
Analyzer wrapping Essentia's BeatTrackerDegara algorithm.

The Degara beat tracker is based on complex spectral difference and
probabilistic models (hidden Markov models), offering a different
approach from the MultiFeature beat tracker.

Reference:
    Degara, N., Rua, E. A., Pena, A., Torres-Guijarro, S., Davies, M. E. P.,
    & Plumbley, M. D. (2012). Reliability-informed beat tracking of musical
    signals. IEEE Transactions on Audio, Speech, and Language Processing.
"""

import sys
from pathlib import Path

import numpy as np
import essentia.standard

sys.path.insert(0, str(Path(__file__).parent.parent))
from interface import BaseAnalyzer, AnalyzerResult


class EssentiaDegaraAnalyzer(BaseAnalyzer):
    """Beat tracking using Essentia's BeatTrackerDegara algorithm."""

    name = "essentia_degara"
    capabilities = {"bpm", "beats"}

    def analyze(self, audio: np.ndarray, sr: int) -> AnalyzerResult:
        # Ensure audio is float32 as required by Essentia
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)

        # BeatTrackerDegara returns beat positions in seconds
        beat_positions = essentia.standard.BeatTrackerDegara()(audio)
        beat_times = beat_positions.tolist()

        # Estimate BPM from median inter-beat interval
        bpm = None
        if len(beat_times) >= 2:
            intervals = np.diff(beat_times)
            median_ibi = float(np.median(intervals))
            if median_ibi > 0:
                bpm = 60.0 / median_ibi

        return AnalyzerResult(
            analyzer_name=self.name,
            bpm=bpm,
            beats=beat_times,
            metadata={
                "algorithm": "BeatTrackerDegara",
                "num_beats": len(beat_times),
            },
        )


def create_analyzer() -> EssentiaDegaraAnalyzer:
    return EssentiaDegaraAnalyzer()
