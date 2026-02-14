"""
Analyzer using Essentia's SuperFluxExtractor for onset-based beat detection.

SuperFlux is a vibrato-robust onset detection method that improves upon
standard spectral flux by applying maximum-filtering across frequency bands
before computing the flux.  This suppresses the spectral fluctuations caused
by vibrato and tremolo, which would otherwise produce spurious onsets.

If Essentia's built-in SuperFluxExtractor is available it is used directly.
Otherwise a manual implementation is provided that:

  1. Computes STFT frames (windowed, overlapping).
  2. Applies max-filtering across frequency bands to the magnitude spectrum.
  3. Computes spectral flux with vibrato suppression (positive half-wave
     rectified difference between the current frame and the max-filtered
     previous frame).
  4. Peak-picks onsets from the resulting SuperFlux function.

BPM is then estimated from the median inter-onset interval, octave-folded
into the 60-200 BPM range.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import essentia.standard

sys.path.insert(0, str(Path(__file__).parent.parent))
from interface import BaseAnalyzer, AnalyzerResult


# ---------------------------------------------------------------------------
# Check whether SuperFluxExtractor is available in this Essentia build
# ---------------------------------------------------------------------------
_HAS_SUPERFLUX_EXTRACTOR = hasattr(essentia.standard, "SuperFluxExtractor")


# ---------------------------------------------------------------------------
# Manual SuperFlux implementation (fallback)
# ---------------------------------------------------------------------------

def _manual_superflux(
    audio: np.ndarray,
    sr: int,
    frame_size: int = 2048,
    hop_size: int = 512,
    max_filter_width: int = 3,
    threshold_factor: float = 1.4,
    combine_ms: float = 30.0,
) -> np.ndarray:
    """Compute SuperFlux onset detection function and return onset times.

    Parameters
    ----------
    audio : np.ndarray
        Mono float32 audio signal.
    sr : int
        Sample rate in Hz.
    frame_size : int
        FFT window length in samples.
    hop_size : int
        Hop length in samples.
    max_filter_width : int
        Width (in frequency bins) of the max-filter applied across bands.
        Must be odd.
    threshold_factor : float
        Multiplier on the adaptive (median-based) threshold for peak-picking.
    combine_ms : float
        Minimum time gap in milliseconds between successive onsets.

    Returns
    -------
    np.ndarray
        Onset times in seconds.
    """
    if max_filter_width % 2 == 0:
        max_filter_width += 1

    # ---- 1. STFT magnitude spectrogram ------------------------------------
    window = np.hanning(frame_size).astype(np.float32)
    num_frames = 1 + (len(audio) - frame_size) // hop_size
    n_bins = frame_size // 2 + 1

    mag = np.zeros((num_frames, n_bins), dtype=np.float32)
    for i in range(num_frames):
        start = i * hop_size
        frame = audio[start : start + frame_size] * window
        spectrum = np.fft.rfft(frame)
        mag[i] = np.abs(spectrum)

    # ---- 2. Max-filtering across frequency bands --------------------------
    half_w = max_filter_width // 2
    mag_filtered = np.copy(mag)
    for i in range(num_frames):
        for b in range(n_bins):
            lo = max(0, b - half_w)
            hi = min(n_bins, b + half_w + 1)
            mag_filtered[i, b] = np.max(mag[i, lo:hi])

    # ---- 3. Spectral flux with vibrato suppression ------------------------
    # The SuperFlux novelty: compare the current magnitude spectrum against
    # the *max-filtered* previous frame, not the raw previous frame.
    flux = np.zeros(num_frames, dtype=np.float32)
    for i in range(1, num_frames):
        diff = mag[i] - mag_filtered[i - 1]
        # Half-wave rectification: only keep increases
        flux[i] = np.sum(np.maximum(diff, 0.0))

    # ---- 4. Adaptive peak-picking -----------------------------------------
    # Use a running median as a local adaptive threshold.
    median_len = max(7, int(0.1 * sr / hop_size))  # ~100 ms window
    if median_len % 2 == 0:
        median_len += 1
    half_med = median_len // 2

    threshold = np.zeros_like(flux)
    for i in range(num_frames):
        lo = max(0, i - half_med)
        hi = min(num_frames, i + half_med + 1)
        threshold[i] = np.median(flux[lo:hi]) * threshold_factor

    # Minimum gap between onsets (in frames)
    min_gap_frames = max(1, int(combine_ms / 1000.0 * sr / hop_size))

    onset_frames: list[int] = []
    last_onset = -min_gap_frames
    for i in range(1, num_frames - 1):
        if (
            flux[i] > threshold[i]
            and flux[i] >= flux[i - 1]
            and flux[i] >= flux[i + 1]
            and (i - last_onset) >= min_gap_frames
        ):
            onset_frames.append(i)
            last_onset = i

    # Convert frame indices to time in seconds
    onset_times = np.array(onset_frames, dtype=np.float64) * hop_size / sr
    return onset_times


# ---------------------------------------------------------------------------
# Analyzer class
# ---------------------------------------------------------------------------

class EssentiaSuperFluxAnalyzer(BaseAnalyzer):
    """Onset-based beat / BPM detection using the SuperFlux method.

    SuperFlux applies max-filtering across frequency bands before computing
    spectral flux, making it robust against vibrato and tremolo artefacts
    that plague standard spectral-flux onset detectors.
    """

    name = "essentia_superflux"
    capabilities = {"bpm", "beats"}

    def analyze(self, audio: np.ndarray, sr: int) -> AnalyzerResult:
        # Essentia requires float32
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)

        if _HAS_SUPERFLUX_EXTRACTOR:
            onset_times = self._analyze_builtin(audio, sr)
            method = "SuperFluxExtractor"
        else:
            onset_times = self._analyze_manual(audio, sr)
            method = "manual_superflux"

        onset_list = onset_times.tolist() if hasattr(onset_times, "tolist") else list(onset_times)
        bpm = self._estimate_bpm(onset_list)

        return AnalyzerResult(
            analyzer_name=self.name,
            bpm=bpm,
            beats=onset_list,
            metadata={
                "algorithm": method,
                "num_onsets": len(onset_list),
            },
        )

    # ------------------------------------------------------------------
    # Built-in Essentia path
    # ------------------------------------------------------------------

    @staticmethod
    def _analyze_builtin(audio: np.ndarray, sr: int) -> np.ndarray:
        """Use Essentia's SuperFluxExtractor directly."""
        onsets = essentia.standard.SuperFluxExtractor(sampleRate=sr)(audio)
        return onsets

    # ------------------------------------------------------------------
    # Manual fallback path
    # ------------------------------------------------------------------

    @staticmethod
    def _analyze_manual(audio: np.ndarray, sr: int) -> np.ndarray:
        """Manual SuperFlux implementation as a fallback."""
        return _manual_superflux(audio, sr)

    # ------------------------------------------------------------------
    # BPM estimation from inter-onset intervals
    # ------------------------------------------------------------------

    @staticmethod
    def _estimate_bpm(onset_times: list[float]) -> float | None:
        """Estimate BPM from median inter-onset interval, clamped to 60-200.

        Uses octave-folding (halving / doubling) to bring the raw BPM
        estimate into a musically plausible range.
        """
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

        # Octave-fold into 60-200 BPM
        while bpm > 200.0:
            bpm /= 2.0
        while bpm < 60.0:
            bpm *= 2.0

        if not (60.0 <= bpm <= 200.0):
            return None

        return round(bpm, 2)


def create_analyzer() -> EssentiaSuperFluxAnalyzer:
    """Factory function expected by the benchmark runner."""
    return EssentiaSuperFluxAnalyzer()
