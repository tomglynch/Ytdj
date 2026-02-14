# Benchmark Harness Plan: Beat Detection Algorithm Comparison

## Goal
Build a benchmarking framework that tests every available beat/BPM/downbeat/phrase detection algorithm against EDM and Rock audio, producing a comparison report showing which algorithm (or combination) performs best for each sub-task.

## Architecture

```
benchmark/
├── interface.py              # AnalyzerResult dataclass + BaseAnalyzer ABC
├── metrics.py                # F-measure, BPM accuracy, CMLc/AMLc
├── runner.py                 # Orchestrator: loads analyzers, runs, scores, reports
├── generate_test_audio.py    # Synthetic audio with known ground truth for validation
├── requirements.txt          # All Python deps
├── analyzers/                # Each file = one independent analyzer (parallel work)
│   ├── __init__.py
│   ├── current_energy.py         # [1]  Port of our TS energy-envelope algorithm
│   ├── librosa_default.py        # [2]  librosa.beat.beat_track (dynamic programming)
│   ├── librosa_plp.py            # [3]  librosa.beat.plp (predominant local pulse)
│   ├── librosa_onset.py          # [4]  librosa.onset.onset_detect + custom BPM
│   ├── essentia_multifeature.py  # [5]  Essentia BeatTrackerMultiFeature
│   ├── essentia_degara.py        # [6]  Essentia BeatTrackerDegara
│   ├── essentia_rhythm.py        # [7]  Essentia RhythmExtractor2013 (BPM+beats+downbeats)
│   ├── essentia_percival.py      # [8]  Essentia PercivalBpmEstimator (BPM specialist)
│   ├── essentia_loopbpm.py       # [9]  Essentia LoopBpmEstimator (loop-focused BPM)
│   ├── essentia_onsets.py        # [10] Essentia OnsetDetection (multiple methods)
│   ├── aubio_default.py          # [11] aubio tempo + beat tracker
│   ├── spectral_flux.py          # [12] Custom spectral flux onset detection (scipy)
│   ├── autocorrelation_bpm.py    # [13] Custom autocorrelation-based BPM estimation
│   └── combo_best.py             # [14] Mix-and-match: best BPM algo + best beat algo + best downbeat algo
├── js_analyzers/             # JS/WASM analyzers (run via Node.js subprocess)
│   ├── package.json
│   ├── run_analyzer.js           # Common Node.js entry point
│   ├── current_ts.js             # [15] Our current TypeScript beatDetector (compiled)
│   ├── essentia_js.js            # [16] essentia.js WASM beat tracking
│   ├── meyda_spectral.js         # [17] Meyda spectral features + custom onset detection
│   └── web_audio_beat.js         # [18] web-audio-beat-detector (OfflineAudioContext)
├── heavy/                    # Optional heavy analyzers (need pytorch ~2GB)
│   ├── beatnet_analyzer.py       # [19] BeatNet CRNN + particle filter
│   └── allin1_analyzer.py        # [20] allin1 structural/phrase analysis
├── audio/                    # User drops test files here
│   └── .gitkeep
└── results/                  # Generated reports
    └── .gitkeep
```

## Common Interface (interface.py)

Every analyzer implements this contract:

```python
@dataclass
class AnalyzerResult:
    analyzer_name: str
    bpm: float | None                    # Estimated BPM
    bpm_confidence: float | None         # 0-1 confidence
    beats: list[float]                   # Beat positions in seconds
    downbeats: list[float]               # Downbeat (bar start) positions in seconds
    phrase_boundaries: list[float]        # Phrase/section boundary positions
    processing_time_ms: float            # Wall-clock time for analysis
    metadata: dict                       # Algorithm-specific extra data

class BaseAnalyzer(ABC):
    name: str
    capabilities: set[str]  # subset of {'bpm', 'beats', 'downbeats', 'phrases'}

    @abstractmethod
    def analyze(self, audio: np.ndarray, sr: int) -> AnalyzerResult: ...
```

## Metrics (metrics.py)

- **BPM accuracy**: |estimated - truth| / truth (with octave-tolerance: 0.5x, 2x, 3x considered correct)
- **Beat F-measure**: precision/recall/F1 at ±70ms tolerance (MIREX standard)
- **Downbeat F-measure**: same, only on beat-1 positions
- **Phrase F-measure**: ±0.5s and ±3.0s tolerance windows
- **CMLc / AMLc**: Continuity-based metrics (longest continuous correct segment)
- **Runtime**: ms per second of audio

## Phase 1: Scaffold (sequential, do first)

Build the shared infrastructure that all analyzers depend on:

1. `benchmark/interface.py` — AnalyzerResult, BaseAnalyzer ABC, audio loading utility
2. `benchmark/metrics.py` — all metric functions
3. `benchmark/runner.py` — discovers analyzers, runs them, produces comparison table
4. `benchmark/generate_test_audio.py` — creates synthetic WAV files with exact known beat positions (sine + kick patterns at known BPMs) so we can validate metrics even without real audio
5. `benchmark/requirements.txt` — all deps
6. `benchmark/js_analyzers/package.json` — JS deps
7. `benchmark/js_analyzers/run_analyzer.js` — common Node entry point that loads a JS analyzer, reads WAV, outputs JSON

## Phase 2: Analyzers (ALL parallel via subagents)

Each analyzer is completely independent — only depends on interface.py.
20 subagents can implement all 20 analyzers simultaneously.

### Python Analyzers (14)

| # | File | Library | Capabilities | Notes |
|---|------|---------|-------------|-------|
| 1 | current_energy.py | numpy only | bpm, beats | Direct port of our TS detectBeats() |
| 2 | librosa_default.py | librosa | bpm, beats | beat_track with default params |
| 3 | librosa_plp.py | librosa | bpm, beats | Predominant local pulse - better for variable tempo |
| 4 | librosa_onset.py | librosa | bpm, beats | onset_detect (spectral flux) + tempo from onsets |
| 5 | essentia_multifeature.py | essentia | bpm, beats | Multi-feature beat tracker |
| 6 | essentia_degara.py | essentia | bpm, beats | Degara et al. beat tracker |
| 7 | essentia_rhythm.py | essentia | bpm, beats, downbeats | RhythmExtractor2013 - full pipeline |
| 8 | essentia_percival.py | essentia | bpm | PercivalBpmEstimator - BPM-only specialist |
| 9 | essentia_loopbpm.py | essentia | bpm | LoopBpmEstimator - good for electronic music |
| 10 | essentia_onsets.py | essentia | beats | OnsetDetection with hfc/complex/flux methods |
| 11 | aubio_default.py | aubio | bpm, beats | aubio tempo + beat tracker |
| 12 | spectral_flux.py | scipy | bpm, beats | Custom spectral flux from scratch |
| 13 | autocorrelation_bpm.py | numpy/scipy | bpm | Autocorrelation-based tempo estimation |
| 14 | combo_best.py | (meta) | all | Assembles best sub-results from other analyzers |

### JS/WASM Analyzers (4)

| # | File | Library | Capabilities | Notes |
|---|------|---------|-------------|-------|
| 15 | current_ts.js | (our code) | bpm, beats | Import our compiled beatDetector |
| 16 | essentia_js.js | essentia.js | bpm, beats, downbeats | WASM in Node.js |
| 17 | meyda_spectral.js | meyda | bpm, beats | Spectral features + custom onset logic |
| 18 | web_audio_beat.js | web-audio-beat-detector | bpm, beats | OfflineAudioContext-based |

### Heavy/Optional Analyzers (2) — only if user opts in

| # | File | Library | Capabilities | Notes |
|---|------|---------|-------------|-------|
| 19 | beatnet_analyzer.py | BeatNet (pytorch) | bpm, beats, downbeats | CRNN + particle filter, ~2GB install |
| 20 | allin1_analyzer.py | allin1 (pytorch) | bpm, beats, downbeats, phrases | Transformer-based, ~5GB install |

## Phase 3: Integration & Run

1. Install all deps (pip + npm)
2. Generate synthetic test audio
3. Run `python runner.py audio/` on synthetic audio first (validates metrics)
4. User drops real EDM/Rock WAV files into `audio/`
5. Run full benchmark → results/comparison.md

## Parallelism Strategy for Subagents

```
Main agent:  Phase 1 scaffold (sequential)
             ↓
             Phase 2: spawn up to 20 subagents in parallel
             ├── Subagent A:  current_energy.py
             ├── Subagent B:  librosa_default.py
             ├── Subagent C:  librosa_plp.py
             ├── Subagent D:  librosa_onset.py
             ├── Subagent E:  essentia_multifeature.py
             ├── Subagent F:  essentia_degara.py
             ├── Subagent G:  essentia_rhythm.py
             ├── Subagent H:  essentia_percival.py
             ├── Subagent I:  essentia_loopbpm.py
             ├── Subagent J:  essentia_onsets.py
             ├── Subagent K:  aubio_default.py
             ├── Subagent L:  spectral_flux.py
             ├── Subagent M:  autocorrelation_bpm.py
             ├── Subagent N:  combo_best.py (stub — fills in after others complete)
             ├── Subagent O:  current_ts.js
             ├── Subagent P:  essentia_js.js
             ├── Subagent Q:  meyda_spectral.js
             └── Subagent R:  web_audio_beat.js
             ↓
             Phase 3: install deps, run benchmarks, generate report

## Verified Installability

| Package | Status | Size |
|---------|--------|------|
| librosa | YES | ~100MB with deps |
| essentia | YES | ~14MB wheel |
| aubio | YES | builds from source |
| msaf | YES | ~60MB with deps |
| BeatNet | YES but heavy | ~2GB (pytorch) |
| allin1 | YES but very heavy | ~5GB (pytorch + demucs) |
| madmom | NO — Cython build fails | skipped |
| essentia.js | YES (npm) | ~14MB WASM |
| meyda | YES (npm) | lightweight |
| aubiojs | YES (npm) | lightweight |
| web-audio-beat-detector | YES (npm) | lightweight |
```
