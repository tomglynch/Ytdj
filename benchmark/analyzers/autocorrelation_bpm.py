"""
Custom autocorrelation-based BPM estimator built from scratch.

Pipeline:
  1. Compute onset strength envelope:
     a) Short-window (~10ms) energy computation
     b) First-order difference (onset = energy increase)
     c) Half-wave rectification (keep only positive values)
  2. Autocorrelation of the onset envelope
  3. Peak search in autocorrelation at lags corresponding to 60-200 BPM
  4. Highest autocorrelation peak determines estimated BPM
  5. Build a regular beat grid starting from the first strong onset

Classic signal processing approach to tempo estimation.
"""

import sys
from pathlib import Path

import numpy as np
from scipy.signal import find_peaks

sys.path.insert(0, str(Path(__file__).parent.parent))
from interface import BaseAnalyzer, AnalyzerResult


class AutocorrelationBPMAnalyzer(BaseAnalyzer):
    """Autocorrelation-based tempo and beat estimator."""

    name = "autocorrelation_bpm"
    capabilities = {"bpm", "beats"}

    # Tuneable parameters
    ENERGY_WINDOW_SEC = 0.01       # 10ms energy windows
    MIN_BPM = 60.0
    MAX_BPM = 200.0
    ONSET_THRESHOLD_FACTOR = 0.3   # fraction of max onset strength for "strong" onset

    def analyze(self, audio: np.ndarray, sr: int) -> AnalyzerResult:
        # ------------------------------------------------------------------
        # Step 1: Compute onset strength envelope
        # ------------------------------------------------------------------
        window_size = int(sr * self.ENERGY_WINDOW_SEC)
        hop_size = window_size // 2

        num_frames = (len(audio) - window_size) // hop_size
        if num_frames <= 1:
            return AnalyzerResult(
                analyzer_name=self.name,
                bpm=120.0,
                beats=[],
                metadata={"error": "audio too short"},
            )

        # (a) Energy in short windows — vectorised via strided view
        frame_starts = np.arange(num_frames) * hop_size
        indices = frame_starts[:, np.newaxis] + np.arange(window_size)
        frames = audio[indices]
        energy = np.sum(frames * frames, axis=1)  # proportional to RMS^2

        # (b) First-order difference (onset = energy increase between frames)
        diff = np.diff(energy)

        # (c) Half-wave rectification: keep only positive increases
        onset_env = np.maximum(diff, 0.0)

        # ------------------------------------------------------------------
        # Step 2: Autocorrelation of the onset envelope
        # ------------------------------------------------------------------
        # Normalise the envelope so autocorrelation is in [0, 1]
        onset_env = onset_env - np.mean(onset_env)
        norm = np.dot(onset_env, onset_env)
        if norm < 1e-12:
            # Silent or constant signal — return default
            return AnalyzerResult(
                analyzer_name=self.name,
                bpm=120.0,
                beats=[],
                metadata={"error": "no detectable onsets"},
            )

        # Full autocorrelation via FFT (much faster than naive O(n^2))
        n = len(onset_env)
        fft_size = 1
        while fft_size < 2 * n:
            fft_size *= 2
        fft_env = np.fft.rfft(onset_env, n=fft_size)
        acf_full = np.fft.irfft(fft_env * np.conj(fft_env), n=fft_size)[:n]
        acf = acf_full / norm  # normalise so acf[0] == 1.0

        # ------------------------------------------------------------------
        # Step 3: Search for peaks in the BPM range [MIN_BPM, MAX_BPM]
        # ------------------------------------------------------------------
        # Convert BPM limits to lag limits (in onset-envelope frames).
        # Each onset-envelope frame = hop_size samples = hop_size/sr seconds.
        frame_duration = hop_size / sr  # seconds per onset-envelope frame

        # lag (frames) = 60 / (BPM * frame_duration)
        min_lag = int(np.floor(60.0 / (self.MAX_BPM * frame_duration)))
        max_lag = int(np.ceil(60.0 / (self.MIN_BPM * frame_duration)))
        max_lag = min(max_lag, n - 1)

        if min_lag >= max_lag or min_lag < 1:
            return AnalyzerResult(
                analyzer_name=self.name,
                bpm=120.0,
                beats=[],
                metadata={"error": "lag range empty"},
            )

        acf_segment = acf[min_lag : max_lag + 1]

        # Find peaks in the autocorrelation segment
        peaks, properties = find_peaks(acf_segment, height=0)

        if len(peaks) == 0:
            # No clear peak — fall back to argmax in range
            best_local = int(np.argmax(acf_segment))
        else:
            # Pick the peak with the highest autocorrelation value
            best_peak_idx = int(np.argmax(properties["peak_heights"]))
            best_local = peaks[best_peak_idx]

        best_lag = best_local + min_lag
        bpm = 60.0 / (best_lag * frame_duration)

        # ------------------------------------------------------------------
        # Step 4: Confidence estimate
        # ------------------------------------------------------------------
        # Ratio of best-lag autocorrelation to the average in the search range
        acf_at_best = acf[best_lag]
        acf_mean = float(np.mean(np.abs(acf_segment)))
        confidence = min(1.0, max(0.0, float(acf_at_best / (acf_mean + 1e-12) - 1.0) / 3.0))

        # ------------------------------------------------------------------
        # Step 5: Build a regular beat grid
        # ------------------------------------------------------------------
        beat_interval = 60.0 / bpm  # seconds between beats
        duration = len(audio) / sr

        # Find the first "strong" onset to anchor the grid
        onset_threshold = self.ONSET_THRESHOLD_FACTOR * np.max(onset_env)
        strong_indices = np.where(onset_env >= onset_threshold)[0]

        if len(strong_indices) > 0:
            first_onset_frame = strong_indices[0]
            # Convert onset-envelope frame index to time
            # onset_env is diff of energy, so frame i of onset_env corresponds
            # to energy frame i+1; energy frame j is centred at j*hop_size samples.
            first_onset_time = float((first_onset_frame + 1) * hop_size) / sr
        else:
            first_onset_time = 0.0

        # Walk backwards from the first onset to cover any beats before it
        grid_start = first_onset_time
        while grid_start - beat_interval >= 0.0:
            grid_start -= beat_interval

        # Build the grid
        beats: list[float] = []
        t = grid_start
        while t < duration:
            if t >= 0.0:
                beats.append(round(t, 6))
            t += beat_interval

        return AnalyzerResult(
            analyzer_name=self.name,
            bpm=round(bpm, 2),
            bpm_confidence=round(confidence, 4),
            beats=beats,
            metadata={
                "best_lag_frames": best_lag,
                "num_beats": len(beats),
                "first_onset_time": round(first_onset_time, 6),
            },
        )


def create_analyzer() -> AutocorrelationBPMAnalyzer:
    """Factory required by the benchmark runner."""
    return AutocorrelationBPMAnalyzer()
