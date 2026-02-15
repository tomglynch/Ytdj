# YouTube DJ — Project Architecture & Plans

## Overview

YouTube DJ is a Chrome extension that turns two YouTube tabs into a DJ mixing interface with beat-synced playback, waveform visualization, and tempo matching.

## Architecture

The extension is built as a modular system with strict separation of concerns. Each module communicates via typed Chrome message protocols — no modules import each other across extension contexts.

```
src/
├── audio/
│   ├── beatDetector.ts      — Pure functions: beat detection, waveform extraction
│   └── syncEngine.ts        — Pure functions: DJ sync/tempo matching algorithms
├── background/
│   └── index.ts             — Service worker: orchestration hub, state, message routing
├── content/
│   └── index.ts             — Content script: YouTube tab audio capture & control
├── controller/
│   ├── index.ts             — Popup UI logic & event handling
│   ├── waveformRenderer.ts  — Canvas-based waveform visualization
│   └── controller.html      — UI template
├── offscreen/
│   ├── index.ts             — Offscreen doc: CPU-intensive audio analysis
│   └── offscreen.html       — Offscreen document
├── storage/
│   └── analysisCache.ts     — IndexedDB caching layer
├── types.ts                 — Central type definitions (all message contracts)
└── manifest.json            — Extension configuration
```

### Dependency Graph (acyclic)

```
types.ts (0 dependencies)
    ↑
    ├─ audio/beatDetector.ts
    │      ↑
    │      └─ audio/syncEngine.ts
    │             ↑
    │             └─ background/index.ts (+ analysisCache)
    │
    ├─ storage/analysisCache.ts
    ├─ content/index.ts
    ├─ offscreen/index.ts (+ beatDetector)
    └─ controller/index.ts (+ waveformRenderer)
```

### Key Design Decisions

1. **Message-driven architecture**: The 4 runtime contexts (background, content, controller, offscreen) never import each other. They communicate via typed discriminated union message protocols defined in `types.ts`.

2. **Pure core logic**: `beatDetector.ts` and `syncEngine.ts` are pure functions with no side effects — deterministic, testable, swappable.

3. **4 webpack entry points**: Each extension context gets its own bundle, enforcing isolation at the build level.

4. **Offscreen document for analysis**: CPU-intensive beat detection runs in the offscreen document to avoid blocking the service worker.

## Current Status

### Completed
- Full extension scaffolding with all 4 contexts
- Energy-envelope beat detection algorithm
- DJ sync engine (tempo matching, phase alignment, drift correction)
- Dual-deck controller UI with waveform visualization
- IndexedDB analysis caching
- 43 passing unit tests

### In Progress
- **Beat detection benchmarking** (`benchmark/`): Comparing 19 different algorithms across multiple libraries to find the best approach for EDM and Rock music. See [benchmark/README.md](benchmark/README.md).

### Planned
- Replace current beat detector with best-performing algorithm from benchmarks
- Potentially integrate Essentia.js WASM for production beat detection
- Phrase/section detection for long-mix planning
- EQ and effects processing
- Crossfader with automated transitions

## Beat Detection Benchmark

The current energy-envelope beat detector (`src/audio/beatDetector.ts`) is functional but basic. We're benchmarking it against 18 alternatives to find the best combination of:

- **BPM estimation** accuracy
- **Beat tracking** precision (F-measure at ±70ms)
- **Downbeat detection** for bar-level sync
- **Phrase analysis** for structural awareness
- **Runtime performance** (must process 30s of audio quickly)

### Preliminary Results (synthetic audio)

| Rank | Analyzer | Beat F1 | BPM Acc | Speed |
|------|----------|---------|---------|-------|
| 1 | essentia_multifeature | 0.992 | 100% | 333ms |
| 2 | essentia_rhythm2013 | 0.992 | 75% | 381ms |
| 3 | essentia_onsets | 0.689 | 75% | 56ms |
| 4 | essentia_degara | 0.503 | 100% | 67ms |
| 5 | current_energy (ours) | 0.165 | 100% | 92ms |

Full results: [benchmark/results/comparison.md](benchmark/results/comparison.md)

### Next Step

Run benchmarks against real EDM and Rock audio files to validate these results on actual music (synthetic drums are much simpler than real recordings).

## Development

```bash
# Build the extension
npm run build

# Run tests
npx vitest

# Run beat detection benchmarks
cd benchmark && python runner.py audio/
```

## Tech Stack

- **TypeScript** with strict mode
- **Webpack** multi-entry compilation
- **Vitest** for unit testing
- **Chrome Extension Manifest V3**
- **Web Audio API** for audio capture
- **IndexedDB** (via `idb`) for caching
- **Python** (librosa, essentia, scipy) for benchmarking
