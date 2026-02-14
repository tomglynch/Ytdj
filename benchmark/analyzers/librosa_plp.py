"""
Beat tracker using librosa's Predominant Local Pulse (PLP).

PLP estimates a pulse curve that captures the locally predominant tempo
at each point in time, making it well suited for music with variable or
ambiguous tempo.  Beat positions are extracted as peaks of the pulse curve.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import librosa
from scipy.signal import find_peaks

# Ensure the benchmark root is importable so we can reach interface.py.
sys.path.insert(0, str(Path(__file__).parent.parent))
from interface import BaseAnalyzer, AnalyzerResult


class LibrosaPLPAnalyzer(BaseAnalyzer):
    """Predominant Local Pulse beat tracker backed by librosa."""

    name = "librosa_plp"
    capabilities = {"bpm", "beats"}

    def analyze(self, audio: np.ndarray, sr: int) -> AnalyzerResult:
        # 1. Compute the onset-strength envelope.
        onset_env = librosa.onset.onset_strength(y=audio, sr=sr)

        # 2. Estimate the global tempo from the onset envelope.
        tempo = librosa.feature.tempo(onset_envelope=onset_env, sr=sr)[0]

        # 3. Compute the Predominant Local Pulse curve.
        pulse = librosa.beat.plp(
            onset_envelope=onset_env,
            sr=sr,
            tempo_min=60,
            tempo_max=200,
        )

        # 4. Locate beat positions as peaks of the pulse curve.
        #    - distance: minimum number of frames between consecutive beats,
        #      derived from the estimated tempo so we don't pick spurious peaks.
        #    - prominence: require peaks to stand out from their surroundings.
        hop_length = 512  # librosa default hop length
        min_beat_frames = int((60.0 / max(tempo, 60)) * sr / hop_length * 0.5)
        peaks, _ = find_peaks(
            pulse,
            distance=max(min_beat_frames, 1),
            prominence=0.05,
        )

        # 5. Convert frame indices to time in seconds.
        beat_times = librosa.frames_to_time(peaks, sr=sr, hop_length=hop_length)

        return AnalyzerResult(
            analyzer_name=self.name,
            bpm=float(tempo),
            beats=beat_times.tolist(),
        )


def create_analyzer() -> LibrosaPLPAnalyzer:
    """Factory function expected by the benchmark runner."""
    return LibrosaPLPAnalyzer()
