"""
Spectral-flux onset detector built from scratch using scipy and numpy.

Pipeline:
  Audio buffer -> STFT (2048-sample window, 1024-sample hop) -> magnitude
  spectra -> spectral flux (sum of positive frame-to-frame differences)
  -> normalisation -> adaptive peak-picking -> BPM from median IOI
  -> regular beat grid

This tests whether frequency-domain onset detection (spectral flux)
outperforms the time-domain energy approach used by current_energy.
"""

import sys
from pathlib import Path

import numpy as np
from scipy.signal import stft, find_peaks

sys.path.insert(0, str(Path(__file__).parent.parent))
from interface import BaseAnalyzer, AnalyzerResult


class SpectralFluxAnalyzer(BaseAnalyzer):
    """Frequency-domain onset detector based on spectral flux."""

    name = "spectral_flux"
    capabilities = {"bpm", "beats"}

    # STFT parameters --------------------------------------------------
    WINDOW_SAMPLES = 2048       # ~46.4 ms at 44100 Hz
    HOP_SAMPLES = 1024          # ~23.2 ms at 44100 Hz

    # Peak-picking parameters ------------------------------------------
    LOCAL_WINDOW_SEC = 3.0      # seconds for adaptive threshold window
    THRESHOLD_COEFF = 1.5       # multiplier on std above median
    MIN_ONSET_SEP_SEC = 0.1     # minimum 100 ms between onsets

    # BPM clamping range -----------------------------------------------
    BPM_MIN = 60.0
    BPM_MAX = 200.0

    def analyze(self, audio: np.ndarray, sr: int) -> AnalyzerResult:
        duration = len(audio) / sr

        # --- 1. Compute STFT -------------------------------------------
        freq, times, Zxx = stft(
            audio,
            fs=sr,
            window="hann",
            nperseg=self.WINDOW_SAMPLES,
            noverlap=self.WINDOW_SAMPLES - self.HOP_SAMPLES,
        )
        magnitude = np.abs(Zxx)  # shape: (n_freq_bins, n_frames)

        if magnitude.shape[1] < 2:
            return AnalyzerResult(
                analyzer_name=self.name,
                bpm=120.0,
                beats=[],
            )

        # --- 2. Spectral flux ------------------------------------------
        # Positive half-wave rectified difference between consecutive frames
        diff = np.diff(magnitude, axis=1)
        diff[diff < 0] = 0.0
        flux = np.sum(diff, axis=0)  # shape: (n_frames - 1,)

        # Align flux timestamps with STFT frame centres (skip the first
        # frame because diff loses one).
        flux_times = times[1:]

        # --- 3. Normalise the flux -------------------------------------
        flux_max = np.max(flux)
        if flux_max > 0:
            flux = flux / flux_max

        # --- 4. Adaptive peak-picking ----------------------------------
        # Build a per-sample adaptive threshold: median + 1.5 * std in a
        # local window around each point.
        local_window_frames = max(
            1, int(self.LOCAL_WINDOW_SEC / (self.HOP_SAMPLES / sr))
        )
        half_w = local_window_frames // 2

        adaptive_threshold = np.zeros_like(flux)
        for i in range(len(flux)):
            lo = max(0, i - half_w)
            hi = min(len(flux), i + half_w + 1)
            local = flux[lo:hi]
            adaptive_threshold[i] = (
                np.median(local) + self.THRESHOLD_COEFF * np.std(local)
            )

        # Minimum distance between peaks in frames
        min_dist_frames = max(1, int(self.MIN_ONSET_SEP_SEC * sr / self.HOP_SAMPLES))

        # find_peaks with height threshold and minimum distance
        peak_indices, _ = find_peaks(
            flux,
            height=adaptive_threshold,
            distance=min_dist_frames,
        )

        # --- 5. Convert peak indices to time positions -----------------
        onsets = flux_times[peak_indices].tolist()

        if len(onsets) < 2:
            return AnalyzerResult(
                analyzer_name=self.name,
                bpm=120.0,
                beats=onsets if onsets else [],
            )

        # --- 6. Estimate BPM from median inter-onset interval ----------
        intervals = np.diff(onsets)
        median_interval = float(np.median(intervals))

        if median_interval <= 0:
            return AnalyzerResult(
                analyzer_name=self.name,
                bpm=120.0,
                beats=onsets,
            )

        bpm = 60.0 / median_interval

        # Clamp to [60, 200] by halving / doubling
        while bpm > self.BPM_MAX:
            bpm /= 2.0
        while bpm < self.BPM_MIN:
            bpm *= 2.0

        beat_interval = 60.0 / bpm

        # --- 7. Build a regular beat grid from first onset -------------
        beats: list[float] = []
        t = onsets[0]
        while t < duration:
            beats.append(round(t, 6))
            t += beat_interval

        # --- 8. Confidence from IOI regularity -------------------------
        deviations = np.abs(intervals - median_interval)
        avg_deviation = float(np.mean(deviations))
        confidence = max(0.0, 1.0 - avg_deviation / median_interval)

        return AnalyzerResult(
            analyzer_name=self.name,
            bpm=round(bpm, 2),
            bpm_confidence=round(confidence, 4),
            beats=beats,
        )


def create_analyzer() -> SpectralFluxAnalyzer:
    """Factory required by the benchmark runner."""
    return SpectralFluxAnalyzer()
