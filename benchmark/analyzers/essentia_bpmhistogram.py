"""
BPM estimator using Essentia's BpmHistogramDescriptors with NoveltyCurve.

This analyzer builds a novelty curve from frame-by-frame frequency band
energies and then feeds it to BpmHistogramDescriptors (or BpmHistogram)
to obtain a histogram-based tempo estimate.  The histogram approach
captures tempo distributions across time, making it especially effective
at finding the dominant tempo in music with complex rhythmic structures.
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))
from interface import BaseAnalyzer, AnalyzerResult


class EssentiaBpmHistogramAnalyzer(BaseAnalyzer):
    """BPM estimator using frequency-band novelty curve and BPM histogram."""

    name = "essentia_bpmhistogram"
    capabilities = {"bpm"}

    # Frame/hop parameters (in samples, assuming 44100 Hz)
    FRAME_SIZE = 2048
    HOP_SIZE = 512

    def analyze(self, audio: np.ndarray, sr: int) -> AnalyzerResult:
        import essentia.standard as es

        # Ensure float32 for Essentia
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)

        # ------------------------------------------------------------------
        # Step 1: Compute frame-by-frame frequency band energies
        # ------------------------------------------------------------------
        windowing = es.Windowing(type="hann", size=self.FRAME_SIZE)
        spectrum = es.Spectrum(size=self.FRAME_SIZE)
        freq_bands = es.FrequencyBands(sampleRate=sr)

        band_energies = []
        for frame in es.FrameGenerator(audio,
                                       frameSize=self.FRAME_SIZE,
                                       hopSize=self.HOP_SIZE,
                                       startFromZero=True):
            windowed = windowing(frame)
            spec = spectrum(windowed)
            bands = freq_bands(spec)
            band_energies.append(bands)

        band_energies = np.array(band_energies, dtype=np.float32)

        # ------------------------------------------------------------------
        # Step 2: Compute the novelty curve from band energies
        # ------------------------------------------------------------------
        novelty_curve = es.NoveltyCurve(frameRate=sr / self.HOP_SIZE)(band_energies)

        # ------------------------------------------------------------------
        # Step 3: Feed the novelty curve into BpmHistogram(Descriptors)
        # ------------------------------------------------------------------
        bpm, confidence = self._compute_bpm_histogram(es, novelty_curve)

        return AnalyzerResult(
            analyzer_name=self.name,
            bpm=bpm,
            bpm_confidence=confidence,
            metadata={
                "confidence": confidence,
                "num_frames": len(band_energies),
                "frame_size": self.FRAME_SIZE,
                "hop_size": self.HOP_SIZE,
            },
        )

    # ------------------------------------------------------------------
    # Helper: try BpmHistogramDescriptors first, fall back to BpmHistogram
    # ------------------------------------------------------------------
    @staticmethod
    def _compute_bpm_histogram(es, novelty_curve: np.ndarray):
        """Return (bpm, confidence) using whichever histogram algo is available."""

        # Primary attempt — BpmHistogramDescriptors
        try:
            bpm_hist = es.BpmHistogramDescriptors()
            result = bpm_hist(novelty_curve)
            # BpmHistogramDescriptors returns:
            #   (firstPeakBPM, firstPeakWeight, firstPeakSpread,
            #    secondPeakBPM, secondPeakWeight, secondPeakSpread)
            # Each element may be an array or scalar depending on essentia version
            def _scalar(x):
                return float(np.asarray(x).flat[0])

            first_peak_bpm = _scalar(result[0])
            first_peak_weight = _scalar(result[1])
            second_peak_weight = _scalar(result[4]) if len(result) > 4 else 0.0

            # Derive confidence from the relative weight of the first peak
            total_weight = first_peak_weight + second_peak_weight
            confidence = (first_peak_weight / total_weight) if total_weight > 0 else 0.0

            if first_peak_bpm > 0:
                return first_peak_bpm, confidence
        except (AttributeError, RuntimeError, TypeError):
            pass

        # Fallback — BpmHistogram
        try:
            bpm_hist = es.BpmHistogram()
            result = bpm_hist(novelty_curve)
            bpm = _scalar(result[0])
            conf = _scalar(result[2]) if len(result) > 2 else 0.0

            if bpm > 0:
                return bpm, conf
        except (AttributeError, RuntimeError, TypeError):
            pass

        return None, None


def create_analyzer() -> EssentiaBpmHistogramAnalyzer:
    """Factory function expected by the benchmark runner."""
    try:
        import essentia.standard  # noqa: F401
    except ImportError as exc:
        raise ImportError(
            "essentia is required for the essentia_bpmhistogram analyzer. "
            "Install it with: pip install essentia"
        ) from exc
    return EssentiaBpmHistogramAnalyzer()
