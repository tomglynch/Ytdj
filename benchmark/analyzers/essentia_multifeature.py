"""
Analyzer wrapping Essentia's BeatTrackerMultiFeature algorithm.

BeatTrackerMultiFeature combines multiple onset detection functions and
tempo estimation strategies to produce robust beat positions along with
a confidence value.
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))
from interface import BaseAnalyzer, AnalyzerResult


class EssentiaMultiFeatureAnalyzer(BaseAnalyzer):
    """Beat tracker using essentia.standard.BeatTrackerMultiFeature."""

    name = "essentia_multifeature"
    capabilities = {"bpm", "beats"}

    def analyze(self, audio: np.ndarray, sr: int) -> AnalyzerResult:
        import essentia.standard as es

        # Ensure audio is float32 (Essentia requirement)
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)

        # BeatTrackerMultiFeature returns (beats, confidence)
        # beats: array of beat positions in seconds
        # confidence: scalar confidence value for the estimation
        beat_tracker = es.BeatTrackerMultiFeature()
        beats, confidence = beat_tracker(audio)

        beats = beats.tolist() if hasattr(beats, "tolist") else list(beats)
        confidence = float(confidence)

        # Estimate BPM from median inter-beat interval
        bpm = None
        if len(beats) >= 2:
            intervals = np.diff(beats)
            median_interval = float(np.median(intervals))
            if median_interval > 0:
                bpm = 60.0 / median_interval

        return AnalyzerResult(
            analyzer_name=self.name,
            bpm=bpm,
            beats=beats,
            bpm_confidence=confidence,
            metadata={
                "num_beats": len(beats),
            },
        )


def create_analyzer() -> EssentiaMultiFeatureAnalyzer:
    """Factory function used by the analyzer discovery mechanism."""
    try:
        import essentia.standard  # noqa: F401
    except ImportError as exc:
        raise ImportError(
            "essentia is required for the essentia_multifeature analyzer. "
            "Install it with: pip install essentia"
        ) from exc
    return EssentiaMultiFeatureAnalyzer()
