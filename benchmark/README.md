# Beat Detection Benchmark

A comprehensive benchmarking framework for comparing beat detection, BPM estimation, downbeat detection, and phrase analysis algorithms. Built to determine the best algorithm combination for the YouTube DJ Chrome extension.

## Quick Start

```bash
cd benchmark

# Install dependencies
pip install -r requirements.txt
cd js_analyzers && npm install && cd ..

# Generate synthetic test audio (for validation)
python generate_test_audio.py

# Run the benchmark
python runner.py audio/

# Results appear in results/comparison.md
```

## Adding Your Own Audio

Drop `.wav`, `.flac`, or `.mp3` files into `benchmark/audio/`. Optionally add ground truth annotations as `.json` files with the same filename stem:

```json
{
  "bpm": 128.0,
  "beats": [0.469, 0.938, 1.406],
  "downbeats": [0.469, 2.344],
  "phrases": [0.469, 15.0, 30.0]
}
```

Without ground truth, the runner reports raw analyzer outputs (estimated BPM, beat positions, timing) but cannot compute F-measure scores.

## Analyzers

### Python Analyzers (15)

| Analyzer | Library | What It Does | Capabilities |
|----------|---------|-------------|---|
| `current_energy` | numpy | Port of our existing TS energy-envelope algorithm | bpm, beats, downbeats |
| `librosa_default` | librosa | `beat_track()` — dynamic programming beat tracker | bpm, beats |
| `librosa_plp` | librosa | Predominant Local Pulse — handles variable tempo | bpm, beats |
| `librosa_onset` | librosa | Spectral flux onset detection + BPM from intervals | bpm, beats |
| `essentia_multifeature` | essentia | Multi-feature beat tracker (top performer) | bpm, beats |
| `essentia_degara` | essentia | Degara et al. probabilistic beat tracker | bpm, beats |
| `essentia_rhythm2013` | essentia | RhythmExtractor2013 — full pipeline with downbeats | bpm, beats, downbeats |
| `essentia_percival` | essentia | Percival & Tzanetakis autocorrelation BPM estimator | bpm |
| `essentia_loopbpm` | essentia | Loop-optimized BPM (designed for electronic music) | bpm |
| `essentia_onsets` | essentia | OnsetRate — onset detection + rate estimation | bpm, beats |
| `essentia_superflux` | essentia | SuperFlux vibrato-robust onset detection | bpm, beats |
| `essentia_tempotap` | essentia | TempoTapDegara with custom ODF | bpm, beats |
| `essentia_bpmhistogram` | essentia | BPM histogram from novelty curve | bpm |
| `spectral_flux` | scipy | Custom spectral flux from scratch (no MIR library) | bpm, beats |
| `autocorrelation_bpm` | numpy/scipy | Custom autocorrelation BPM estimation | bpm, beats |

### JS/WASM Analyzers (4)

These run via Node.js subprocess and test what's viable in the Chrome extension:

| Analyzer | Library | What It Does | Capabilities |
|----------|---------|-------------|---|
| `current_ts` | vanilla JS | Direct port of our TypeScript `beatDetector.ts` | bpm, beats, downbeats |
| `essentia_js` | essentia.js WASM | Essentia running as WASM (same as extension would use) | bpm, beats, downbeats |
| `meyda_spectral` | meyda | Spectral feature extraction + custom onset detection | bpm, beats |
| `web_audio_beat` | vanilla JS | Autocorrelation onset envelope (Node.js reimpl) | bpm, beats |

## Evaluation Metrics

All metrics follow [MIREX](https://www.music-ir.org/mirex/) standards:

| Metric | Tolerance | What It Measures |
|--------|-----------|------------------|
| **BPM Accuracy** | ±4%, octave-tolerant | Is the tempo estimate correct? (2x/0.5x counts as correct) |
| **Beat F-measure** | ±70ms | Precision/recall of beat positions |
| **Downbeat F-measure** | ±70ms | Precision/recall of bar-start positions |
| **Phrase F-measure** | ±0.5s and ±3.0s | Precision/recall of phrase/section boundaries |
| **CMLc** | ±70ms | Longest continuously correct beat segment (normalized) |
| **AMLc** | ±70ms | Like CMLc but tolerates offbeat/double/half tempo |

## Architecture

```
benchmark/
├── interface.py              # AnalyzerResult dataclass + BaseAnalyzer ABC
├── metrics.py                # MIREX-standard evaluation functions
├── runner.py                 # Auto-discovers analyzers, runs, scores, reports
├── generate_test_audio.py    # Synthetic test audio with known ground truth
├── requirements.txt          # Python dependencies
├── analyzers/                # Python analyzer plugins (auto-discovered)
│   ├── current_energy.py
│   ├── librosa_default.py
│   ├── ...
│   └── spectral_flux.py
├── js_analyzers/             # JS/WASM analyzer plugins (auto-discovered)
│   ├── package.json
│   ├── run_analyzer.js       # Common Node.js entry point
│   ├── current_ts.js
│   └── ...
├── audio/                    # Test audio files + ground truth JSON
└── results/                  # Generated comparison reports
```

### Adding a New Analyzer

**Python:** Create a file in `analyzers/` with a `create_analyzer()` function:

```python
from interface import BaseAnalyzer, AnalyzerResult

class MyAnalyzer(BaseAnalyzer):
    name = "my_analyzer"
    capabilities = {"bpm", "beats"}

    def analyze(self, audio, sr):
        # Your algorithm here
        return AnalyzerResult(
            analyzer_name=self.name,
            bpm=120.0,
            beats=[0.5, 1.0, 1.5, ...],
        )

def create_analyzer():
    return MyAnalyzer()
```

**JS:** Create a file in `js_analyzers/` exporting an `analyze` function:

```javascript
export async function analyze(audioData, sampleRate) {
  // Your algorithm here
  return {
    analyzer_name: 'my_js_analyzer',
    bpm: 120.0,
    beats: [0.5, 1.0, 1.5],
    downbeats: [],
    phrase_boundaries: [],
    metadata: {},
  };
}
```

The runner auto-discovers both types on startup.

## Dependencies

| Package | Required For | Install |
|---------|-------------|---------|
| numpy, soundfile, librosa | Core + librosa analyzers | `pip install -r requirements.txt` |
| essentia | Essentia analyzers (8 of them) | Included in requirements.txt |
| scipy | spectral_flux, autocorrelation_bpm | Included in requirements.txt |
| essentia.js, meyda | JS analyzers | `cd js_analyzers && npm install` |
