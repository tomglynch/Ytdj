"""
Analyzer wrapping librosa's default beat_track function.
"""

import sys
from pathlib import Path

import numpy as np
import librosa

sys.path.insert(0, str(Path(__file__).parent.parent))
from interface import BaseAnalyzer, AnalyzerResult


class LibrosaDefaultAnalyzer(BaseAnalyzer):
    """Thin wrapper around librosa.beat.beat_track with default parameters."""

    name = "librosa_default"
    capabilities = {"bpm", "beats"}

    def analyze(self, audio: np.ndarray, sr: int) -> AnalyzerResult:
        tempo, beat_frames = librosa.beat.beat_track(y=audio, sr=sr)

        # tempo may be returned as a numpy array (librosa >= 0.10); extract scalar
        if isinstance(tempo, np.ndarray):
            tempo = float(tempo[0])
        else:
            tempo = float(tempo)

        beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()

        return AnalyzerResult(
            analyzer_name=self.name,
            bpm=tempo,
            beats=beat_times,
            metadata={
                "confidence": None,
                "num_beats": len(beat_times),
            },
        )


def create_analyzer() -> LibrosaDefaultAnalyzer:
    return LibrosaDefaultAnalyzer()
