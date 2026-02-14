#!/usr/bin/env python3
"""
Benchmark runner — discovers analyzers, runs them against audio files,
evaluates against ground truth, and produces a comparison report.

Usage:
    python runner.py [audio_dir] [--ground-truth gt_dir] [--output results/]

If no audio_dir given, defaults to benchmark/audio/.
Ground truth files are JSON with the same stem as the audio file.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

from interface import (
    AnalyzerResult,
    BaseAnalyzer,
    discover_analyzers,
    discover_js_analyzers,
    load_audio,
    run_js_analyzer,
)
from metrics import FullEvaluation, evaluate, format_comparison_table


AUDIO_EXTENSIONS = {".wav", ".flac", ".mp3", ".ogg", ".m4a"}


def find_audio_files(audio_dir: Path) -> list[Path]:
    """Find all audio files in a directory."""
    files = []
    for ext in AUDIO_EXTENSIONS:
        files.extend(audio_dir.glob(f"*{ext}"))
    return sorted(files)


def load_ground_truth(audio_path: Path, gt_dir: Path | None) -> dict | None:
    """
    Load ground truth for an audio file.

    Looks for a .json file with the same stem in gt_dir (or same dir as audio).
    """
    if gt_dir is None:
        gt_dir = audio_path.parent

    gt_path = gt_dir / f"{audio_path.stem}.json"
    if not gt_path.exists():
        return None

    with open(gt_path) as f:
        return json.load(f)


def run_python_analyzers(
    analyzers: list[BaseAnalyzer],
    audio: np.ndarray,
    sr: int,
) -> list[AnalyzerResult]:
    """Run all Python analyzers on the same audio."""
    results = []
    for analyzer in analyzers:
        print(f"    Running {analyzer.name}...", end="", flush=True)
        try:
            result = analyzer.timed_analyze(audio, sr)
            print(f" done ({result.processing_time_ms:.0f}ms)")
            results.append(result)
        except Exception as e:
            print(f" FAILED: {e}")
            results.append(AnalyzerResult(
                analyzer_name=analyzer.name,
                metadata={"error": str(e)},
            ))
    return results


def run_js_analyzers(
    js_scripts: list[Path],
    audio_path: Path,
    sr: int,
) -> list[AnalyzerResult]:
    """Run all JS analyzers on the same audio file."""
    results = []
    for script in js_scripts:
        print(f"    Running {script.stem} (JS)...", end="", flush=True)
        try:
            result = run_js_analyzer(script, audio_path, sr)
            if "error" in result.metadata:
                print(f" FAILED: {result.metadata['error'][:80]}")
            else:
                print(f" done ({result.processing_time_ms:.0f}ms)")
            results.append(result)
        except Exception as e:
            print(f" FAILED: {e}")
            results.append(AnalyzerResult(
                analyzer_name=script.stem,
                metadata={"error": str(e)},
            ))
    return results


def generate_report(
    all_evaluations: dict[str, list[FullEvaluation]],
    output_dir: Path,
) -> str:
    """Generate a markdown comparison report."""
    lines = [
        "# Beat Detection Benchmark Results",
        "",
        f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        "",
    ]

    # Per-track results
    for track_name, evaluations in all_evaluations.items():
        lines.append(f"## {track_name}")
        lines.append("")
        lines.append(format_comparison_table(evaluations))
        lines.append("")

    # Aggregate results (average across tracks)
    if len(all_evaluations) > 1:
        lines.append("## Aggregate (Average across all tracks)")
        lines.append("")

        # Collect all analyzer names
        all_names = set()
        for evs in all_evaluations.values():
            for ev in evs:
                all_names.add(ev.analyzer_name)

        aggregated = []
        for name in sorted(all_names):
            track_evals = []
            for evs in all_evaluations.values():
                for ev in evs:
                    if ev.analyzer_name == name:
                        track_evals.append(ev)

            if track_evals:
                avg = FullEvaluation(analyzer_name=name)
                n = len(track_evals)
                avg.bpm_eval.accuracy = sum(e.bpm_eval.accuracy for e in track_evals) / n
                avg.beat_eval.f_measure = sum(e.beat_eval.f_measure for e in track_evals) / n
                avg.beat_eval.precision = sum(e.beat_eval.precision for e in track_evals) / n
                avg.beat_eval.recall = sum(e.beat_eval.recall for e in track_evals) / n
                avg.downbeat_eval.f_measure = sum(e.downbeat_eval.f_measure for e in track_evals) / n
                avg.phrase_eval_tight.f_measure = sum(e.phrase_eval_tight.f_measure for e in track_evals) / n
                avg.phrase_eval_loose.f_measure = sum(e.phrase_eval_loose.f_measure for e in track_evals) / n
                avg.cmlc = sum(e.cmlc for e in track_evals) / n
                avg.amlc = sum(e.amlc for e in track_evals) / n
                avg.processing_time_ms = sum(e.processing_time_ms for e in track_evals) / n
                aggregated.append(avg)

        lines.append(format_comparison_table(aggregated))
        lines.append("")

    # Best-of summary
    lines.append("## Best Algorithms by Category")
    lines.append("")

    for track_name, evaluations in all_evaluations.items():
        lines.append(f"### {track_name}")
        valid = [e for e in evaluations if "error" not in (getattr(e, 'metadata', None) or {})]
        if not valid:
            lines.append("No valid results.")
            continue

        bpm_best = max(valid, key=lambda e: e.bpm_eval.accuracy)
        beat_best = max(valid, key=lambda e: e.beat_eval.f_measure)
        lines.append(f"- **Best BPM**: {bpm_best.analyzer_name} ({bpm_best.bpm_eval.accuracy:.0%})")
        lines.append(f"- **Best Beat Tracking**: {beat_best.analyzer_name} (F1={beat_best.beat_eval.f_measure:.3f})")

        db_valid = [e for e in valid if e.downbeat_eval.f_measure > 0]
        if db_valid:
            db_best = max(db_valid, key=lambda e: e.downbeat_eval.f_measure)
            lines.append(f"- **Best Downbeat**: {db_best.analyzer_name} (F1={db_best.downbeat_eval.f_measure:.3f})")

        ph_valid = [e for e in valid if e.phrase_eval_tight.f_measure > 0]
        if ph_valid:
            ph_best = max(ph_valid, key=lambda e: e.phrase_eval_tight.f_measure)
            lines.append(f"- **Best Phrases**: {ph_best.analyzer_name} (F1={ph_best.phrase_eval_tight.f_measure:.3f})")

        fastest = min(valid, key=lambda e: e.processing_time_ms if e.processing_time_ms > 0 else float("inf"))
        lines.append(f"- **Fastest**: {fastest.analyzer_name} ({fastest.processing_time_ms:.0f}ms)")
        lines.append("")

    report = "\n".join(lines)

    # Write to file
    output_dir.mkdir(parents=True, exist_ok=True)
    report_path = output_dir / "comparison.md"
    with open(report_path, "w") as f:
        f.write(report)

    # Also write raw JSON
    raw_path = output_dir / "raw_results.json"
    raw = {}
    for track_name, evaluations in all_evaluations.items():
        raw[track_name] = []
        for ev in evaluations:
            raw[track_name].append({
                "analyzer": ev.analyzer_name,
                "bpm_accuracy": ev.bpm_eval.accuracy,
                "beat_f1": ev.beat_eval.f_measure,
                "beat_precision": ev.beat_eval.precision,
                "beat_recall": ev.beat_eval.recall,
                "downbeat_f1": ev.downbeat_eval.f_measure,
                "phrase_f1_tight": ev.phrase_eval_tight.f_measure,
                "phrase_f1_loose": ev.phrase_eval_loose.f_measure,
                "cmlc": ev.cmlc,
                "amlc": ev.amlc,
                "time_ms": ev.processing_time_ms,
            })
    with open(raw_path, "w") as f:
        json.dump(raw, f, indent=2)

    return report


def main():
    parser = argparse.ArgumentParser(description="Beat detection benchmark runner")
    parser.add_argument("audio_dir", nargs="?", default="audio",
                        help="Directory containing audio files")
    parser.add_argument("--ground-truth", "-g", default=None,
                        help="Directory containing ground truth JSON files")
    parser.add_argument("--output", "-o", default="results",
                        help="Output directory for reports")
    parser.add_argument("--sr", type=int, default=44100,
                        help="Sample rate for analysis")
    args = parser.parse_args()

    benchmark_dir = Path(__file__).parent
    audio_dir = Path(args.audio_dir)
    if not audio_dir.is_absolute():
        audio_dir = benchmark_dir / audio_dir
    gt_dir = Path(args.ground_truth) if args.ground_truth else None
    output_dir = Path(args.output)
    if not output_dir.is_absolute():
        output_dir = benchmark_dir / output_dir

    # Discover audio files
    print(f"Looking for audio files in {audio_dir}...")
    audio_files = find_audio_files(audio_dir)
    if not audio_files:
        print("No audio files found! Place .wav/.flac/.mp3 files in the audio/ directory.")
        sys.exit(1)
    print(f"Found {len(audio_files)} audio file(s):")
    for f in audio_files:
        print(f"  - {f.name}")

    # Discover Python analyzers
    print("\nDiscovering Python analyzers...")
    analyzers_dir = benchmark_dir / "analyzers"
    py_analyzers = discover_analyzers(analyzers_dir)
    print(f"Found {len(py_analyzers)} Python analyzer(s)")

    # Discover JS analyzers
    print("\nDiscovering JS analyzers...")
    js_dir = benchmark_dir / "js_analyzers"
    js_scripts = discover_js_analyzers(js_dir)
    print(f"Found {len(js_scripts)} JS analyzer(s)")

    if not py_analyzers and not js_scripts:
        print("No analyzers found!")
        sys.exit(1)

    # Run benchmarks
    all_evaluations: dict[str, list[FullEvaluation]] = {}

    for audio_file in audio_files:
        track_name = audio_file.stem
        print(f"\n{'='*60}")
        print(f"Processing: {track_name}")
        print(f"{'='*60}")

        # Load audio
        print("  Loading audio...", end="", flush=True)
        audio, sr = load_audio(audio_file, sr=args.sr)
        duration = len(audio) / sr
        print(f" done ({duration:.1f}s, {sr}Hz)")

        # Load ground truth
        gt = load_ground_truth(audio_file, gt_dir)
        if gt:
            print(f"  Ground truth: BPM={gt.get('bpm', '?')}, "
                  f"{len(gt.get('beats', []))} beats, "
                  f"{len(gt.get('downbeats', []))} downbeats, "
                  f"{len(gt.get('phrases', []))} phrases")
        else:
            print("  No ground truth — will report raw results only")

        # Run Python analyzers
        print("\n  Python analyzers:")
        py_results = run_python_analyzers(py_analyzers, audio, sr)

        # Run JS analyzers
        if js_scripts:
            print("\n  JS analyzers:")
            js_results = run_js_analyzers(js_scripts, audio_file, sr)
        else:
            js_results = []

        all_results = py_results + js_results

        # Evaluate
        evaluations = []
        for result in all_results:
            if gt:
                ev = evaluate(result, gt)
            else:
                ev = FullEvaluation(
                    analyzer_name=result.analyzer_name,
                    processing_time_ms=result.processing_time_ms,
                )
                # Store raw results in metadata for no-ground-truth mode
                ev.bpm_eval.raw = {"estimated_bpm": result.bpm}
            evaluations.append(ev)

        all_evaluations[track_name] = evaluations

    # Generate report
    print(f"\n{'='*60}")
    print("Generating report...")
    report = generate_report(all_evaluations, output_dir)
    print(f"\nReport written to {output_dir / 'comparison.md'}")
    print(f"Raw results written to {output_dir / 'raw_results.json'}")
    print(f"\n{report}")


if __name__ == "__main__":
    main()
