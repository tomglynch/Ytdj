"""
BPM estimator using Essentia's LoopBpmEstimator.

LoopBpmEstimator is specifically designed for electronic music loops with
regular beats.  It provides a single global BPM estimate, making it a good
baseline for EDM tracks.
"""

import sys
from pathlib import Path

import numpy as np
import essentia.standard

sys.path.insert(0, str(Path(__file__).parent.parent))
from interface import BaseAnalyzer, AnalyzerResult


class EssentiaLoopBpmAnalyzer(BaseAnalyzer):
    """BPM estimator tailored for electronic music loops via Essentia."""

    name = "essentia_loopbpm"
    capabilities = {"bpm"}

    def analyze(self, audio: np.ndarray, sr: int) -> AnalyzerResult:
        # LoopBpmEstimator expects single-precision floats.
        audio32 = audio.astype(np.float32, copy=False)

        bpm = essentia.standard.LoopBpmEstimator()(audio32)

        return AnalyzerResult(
            analyzer_name=self.name,
            bpm=float(bpm),
        )


def create_analyzer() -> EssentiaLoopBpmAnalyzer:
    """Factory function expected by the benchmark runner."""
    return EssentiaLoopBpmAnalyzer()
