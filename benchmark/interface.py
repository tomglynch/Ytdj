"""
Common interface for all beat detection analyzers.

Every analyzer (Python or JS) must produce an AnalyzerResult.
Python analyzers subclass BaseAnalyzer; JS analyzers output JSON
matching the same schema via run_analyzer.js.
"""

from __future__ import annotations

import time
import json
import subprocess
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf


@dataclass
class AnalyzerResult:
    """Standardized output from any analyzer."""
    analyzer_name: str
    bpm: Optional[float] = None
    bpm_confidence: Optional[float] = None
    beats: list[float] = field(default_factory=list)
    downbeats: list[float] = field(default_factory=list)
    phrase_boundaries: list[float] = field(default_factory=list)
    processing_time_ms: float = 0.0
    metadata: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)

    @classmethod
    def from_dict(cls, d: dict) -> AnalyzerResult:
        return cls(**d)

    @classmethod
    def from_json(cls, s: str) -> AnalyzerResult:
        return cls.from_dict(json.loads(s))


class BaseAnalyzer(ABC):
    """Abstract base for Python analyzers."""

    name: str = "unnamed"
    # Subset of {'bpm', 'beats', 'downbeats', 'phrases'}
    capabilities: set[str] = set()

    @abstractmethod
    def analyze(self, audio: np.ndarray, sr: int) -> AnalyzerResult:
        """
        Analyze audio and return results.

        Args:
            audio: Mono audio as float32 numpy array, values in [-1, 1]
            sr: Sample rate in Hz
        Returns:
            AnalyzerResult with all detected features
        """
        ...

    def timed_analyze(self, audio: np.ndarray, sr: int) -> AnalyzerResult:
        """Run analyze() and automatically fill processing_time_ms."""
        t0 = time.perf_counter()
        result = self.analyze(audio, sr)
        result.processing_time_ms = (time.perf_counter() - t0) * 1000
        return result


def load_audio(path: str | Path, sr: int = 44100, mono: bool = True) -> tuple[np.ndarray, int]:
    """
    Load an audio file and return (samples, sample_rate).

    Args:
        path: Path to audio file (WAV, FLAC, MP3 via soundfile)
        sr: Target sample rate (resamples if needed)
        mono: Mix to mono if True
    Returns:
        (audio_array, sample_rate)
    """
    import librosa
    audio, file_sr = librosa.load(str(path), sr=sr, mono=mono)
    return audio, sr


def discover_analyzers(analyzers_dir: str | Path) -> list[BaseAnalyzer]:
    """
    Discover and instantiate all Python analyzers in a directory.

    Each .py file in the directory should have a top-level `create_analyzer()`
    function that returns a BaseAnalyzer instance.
    """
    import importlib.util

    analyzers = []
    analyzers_path = Path(analyzers_dir)

    for py_file in sorted(analyzers_path.glob("*.py")):
        if py_file.name.startswith("_"):
            continue

        spec = importlib.util.spec_from_file_location(py_file.stem, py_file)
        if spec is None or spec.loader is None:
            continue

        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        except Exception as e:
            print(f"  [SKIP] {py_file.name}: failed to import — {e}")
            continue

        factory = getattr(module, "create_analyzer", None)
        if factory is None:
            print(f"  [SKIP] {py_file.name}: no create_analyzer() function")
            continue

        try:
            analyzer = factory()
            analyzers.append(analyzer)
            print(f"  [OK]   {analyzer.name} ({', '.join(analyzer.capabilities)})")
        except Exception as e:
            print(f"  [SKIP] {py_file.name}: create_analyzer() failed — {e}")

    return analyzers


def run_js_analyzer(
    analyzer_script: str | Path,
    audio_path: str | Path,
    sr: int = 44100,
) -> AnalyzerResult:
    """
    Run a JS analyzer via Node.js subprocess.

    The JS script should accept (audioPath, sampleRate) args and print
    a JSON AnalyzerResult to stdout.
    """
    js_dir = Path(__file__).parent / "js_analyzers"
    runner = js_dir / "run_analyzer.js"

    result = subprocess.run(
        ["node", str(runner), str(analyzer_script), str(audio_path), str(sr)],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=str(js_dir),
    )

    if result.returncode != 0:
        return AnalyzerResult(
            analyzer_name=Path(analyzer_script).stem,
            metadata={"error": result.stderr.strip()},
        )

    return AnalyzerResult.from_json(result.stdout.strip())


def discover_js_analyzers(js_dir: str | Path) -> list[Path]:
    """Find all JS analyzer scripts (excluding run_analyzer.js and package.json)."""
    js_path = Path(js_dir)
    skip = {"run_analyzer.js", "package.json", "package-lock.json", "node_modules"}
    return sorted(
        p for p in js_path.glob("*.js")
        if p.name not in skip
    )
