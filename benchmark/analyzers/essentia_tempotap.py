"""
Analyzer wrapping Essentia's TempoTapDegara algorithm.

Unlike BeatTrackerDegara (which handles onset detection internally),
this approach gives explicit control over the onset detection function.
We compute a complex-domain onset detection function frame-by-frame
and then pass it to TempoTapDegara for beat tracking.

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


class EssentiaTempoTapAnalyzer(BaseAnalyzer):
    """Beat tracking using a manually computed ODF fed into TempoTapDegara."""

    name = "essentia_tempotap"
    capabilities = {"bpm", "beats"}

    def __init__(self, frame_size: int = 2048, hop_size: int = 512):
        self.frame_size = frame_size
        self.hop_size = hop_size

    def analyze(self, audio: np.ndarray, sr: int) -> AnalyzerResult:
        # Ensure audio is float32 as required by Essentia
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)

        # --- Step 1: Compute onset detection function frame-by-frame ---
        windowing = essentia.standard.Windowing(type="hann")
        fft = essentia.standard.FFT()
        c2p = essentia.standard.CartesianToPolar()
        onset_detection = essentia.standard.OnsetDetection(method="complex")

        odf_values = []
        for frame in essentia.standard.FrameGenerator(
            audio, frameSize=self.frame_size, hopSize=self.hop_size
        ):
            windowed = windowing(frame)
            spectrum = fft(windowed)
            magnitude, phase = c2p(spectrum)
            odf_value = onset_detection(magnitude, phase)
            odf_values.append(odf_value)

        odf_values = np.array(odf_values, dtype=np.float32)

        # --- Step 2: Feed ODF into TempoTapDegara to get beat ticks ---
        tempo_tap = essentia.standard.TempoTapDegara()
        beat_ticks = tempo_tap(odf_values)
        beat_times = beat_ticks.tolist()

        # --- Step 3: Estimate BPM from median inter-beat interval ---
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
                "algorithm": "TempoTapDegara",
                "onset_method": "complex",
                "frame_size": self.frame_size,
                "hop_size": self.hop_size,
                "num_odf_frames": len(odf_values),
                "num_beats": len(beat_times),
            },
        )


def create_analyzer() -> EssentiaTempoTapAnalyzer:
    """Factory function used by the analyzer discovery mechanism."""
    return EssentiaTempoTapAnalyzer()
