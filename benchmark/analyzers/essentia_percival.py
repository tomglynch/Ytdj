"""
Analyzer wrapping Essentia's PercivalBpmEstimator.

This is a pure BPM estimator based on Percival & Tzanetakis's
autocorrelation-based tempo estimation method.  It does not produce
beat positions or downbeats — only a global BPM value.
"""

import sys
from pathlib import Path

import numpy as np
import essentia.standard

sys.path.insert(0, str(Path(__file__).parent.parent))
from interface import BaseAnalyzer, AnalyzerResult


class EssentiaPercivalAnalyzer(BaseAnalyzer):
    """BPM-only estimator using Essentia's PercivalBpmEstimator."""

    name = "essentia_percival"
    capabilities = {"bpm"}

    def analyze(self, audio: np.ndarray, sr: int) -> AnalyzerResult:
        bpm = essentia.standard.PercivalBpmEstimator()(audio)
        return AnalyzerResult(
            analyzer_name=self.name,
            bpm=float(bpm),
        )


def create_analyzer() -> EssentiaPercivalAnalyzer:
    """Factory required by the benchmark runner."""
    return EssentiaPercivalAnalyzer()
