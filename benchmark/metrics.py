"""
Evaluation metrics for beat detection benchmarking.

Implements standard MIR evaluation metrics from MIREX:
- BPM accuracy (with octave tolerance)
- Beat F-measure at ±70ms
- Downbeat F-measure at ±70ms
- Phrase boundary F-measure at ±0.5s and ±3.0s
- CMLc / AMLc (continuity-based metrics)
"""

from __future__ import annotations

import numpy as np
from dataclasses import dataclass, field


@dataclass
class MetricResult:
    """Results for a single metric evaluation."""
    precision: float = 0.0
    recall: float = 0.0
    f_measure: float = 0.0
    accuracy: float = 0.0  # Used for BPM
    raw: dict = field(default_factory=dict)


@dataclass
class FullEvaluation:
    """Complete evaluation of an analyzer against ground truth."""
    analyzer_name: str = ""
    bpm_eval: MetricResult = field(default_factory=MetricResult)
    beat_eval: MetricResult = field(default_factory=MetricResult)
    downbeat_eval: MetricResult = field(default_factory=MetricResult)
    phrase_eval_tight: MetricResult = field(default_factory=MetricResult)   # ±0.5s
    phrase_eval_loose: MetricResult = field(default_factory=MetricResult)   # ±3.0s
    cmlc: float = 0.0
    amlc: float = 0.0
    processing_time_ms: float = 0.0


def bpm_accuracy(
    estimated_bpm: float | None,
    true_bpm: float,
    tolerance_pct: float = 0.04,
    octave_tolerant: bool = True,
) -> MetricResult:
    """
    Evaluate BPM estimation accuracy.

    Args:
        estimated_bpm: Estimated BPM (None = no estimate)
        true_bpm: Ground truth BPM
        tolerance_pct: Percentage tolerance (default 4% = MIREX standard)
        octave_tolerant: If True, 0.5x, 2x, 3x multiples are considered correct
    """
    if estimated_bpm is None or true_bpm <= 0:
        return MetricResult(accuracy=0.0, raw={"error": "no estimate"})

    candidates = [estimated_bpm]
    if octave_tolerant:
        candidates.extend([
            estimated_bpm * 2,
            estimated_bpm / 2,
            estimated_bpm * 3,
            estimated_bpm / 3,
        ])

    best_error = float("inf")
    best_candidate = estimated_bpm
    for c in candidates:
        error = abs(c - true_bpm) / true_bpm
        if error < best_error:
            best_error = error
            best_candidate = c

    correct = best_error <= tolerance_pct
    return MetricResult(
        accuracy=1.0 if correct else 0.0,
        raw={
            "estimated": estimated_bpm,
            "best_match": best_candidate,
            "true": true_bpm,
            "error_pct": best_error * 100,
            "within_tolerance": correct,
        },
    )


def _event_f_measure(
    estimated: list[float],
    reference: list[float],
    tolerance: float,
) -> MetricResult:
    """
    Compute precision, recall, F-measure for event detection.

    An estimated event is a true positive if it falls within ±tolerance
    of a reference event. Each reference event can only be matched once.
    """
    if len(reference) == 0 and len(estimated) == 0:
        return MetricResult(precision=1.0, recall=1.0, f_measure=1.0)
    if len(reference) == 0:
        return MetricResult(precision=0.0, recall=0.0, f_measure=0.0)
    if len(estimated) == 0:
        return MetricResult(precision=0.0, recall=0.0, f_measure=0.0)

    est = np.array(sorted(estimated))
    ref = np.array(sorted(reference))

    matched_ref = set()
    true_positives = 0

    for e in est:
        distances = np.abs(ref - e)
        for idx in np.argsort(distances):
            if distances[idx] > tolerance:
                break
            if idx not in matched_ref:
                matched_ref.add(idx)
                true_positives += 1
                break

    precision = true_positives / len(est) if len(est) > 0 else 0.0
    recall = true_positives / len(ref) if len(ref) > 0 else 0.0
    f_measure = (
        2 * precision * recall / (precision + recall)
        if (precision + recall) > 0
        else 0.0
    )

    return MetricResult(
        precision=precision,
        recall=recall,
        f_measure=f_measure,
        raw={
            "true_positives": true_positives,
            "num_estimated": len(est),
            "num_reference": len(ref),
        },
    )


def beat_f_measure(
    estimated_beats: list[float],
    reference_beats: list[float],
    tolerance: float = 0.07,
) -> MetricResult:
    """Beat F-measure at ±70ms tolerance (MIREX standard)."""
    return _event_f_measure(estimated_beats, reference_beats, tolerance)


def downbeat_f_measure(
    estimated_downbeats: list[float],
    reference_downbeats: list[float],
    tolerance: float = 0.07,
) -> MetricResult:
    """Downbeat F-measure at ±70ms tolerance."""
    return _event_f_measure(estimated_downbeats, reference_downbeats, tolerance)


def phrase_f_measure(
    estimated_phrases: list[float],
    reference_phrases: list[float],
    tolerance: float = 0.5,
) -> MetricResult:
    """Phrase boundary F-measure at given tolerance."""
    return _event_f_measure(estimated_phrases, reference_phrases, tolerance)


def continuity_metrics(
    estimated_beats: list[float],
    reference_beats: list[float],
    tolerance: float = 0.07,
) -> tuple[float, float]:
    """
    Compute CMLc and AMLc (Continuity-based Metrics Longest segment).

    CMLc: Longest continuously correct segment / total reference beats
    AMLc: Like CMLc but allows offbeat (half-beat offset) and double/half tempo

    Returns:
        (cmlc, amlc) both in [0, 1]
    """
    if len(reference_beats) == 0 or len(estimated_beats) == 0:
        return 0.0, 0.0

    ref = np.array(sorted(reference_beats))
    est = np.array(sorted(estimated_beats))

    def _longest_continuous(est_arr: np.ndarray, ref_arr: np.ndarray) -> int:
        """Find longest run of consecutive correct beats."""
        current_run = 0
        longest = 0
        ref_idx = 0

        for e in est_arr:
            # Find nearest ref beat
            while ref_idx < len(ref_arr) - 1 and ref_arr[ref_idx + 1] <= e:
                ref_idx += 1

            # Check if within tolerance of nearest ref
            min_dist = float("inf")
            for ri in range(max(0, ref_idx - 1), min(len(ref_arr), ref_idx + 2)):
                dist = abs(ref_arr[ri] - e)
                if dist < min_dist:
                    min_dist = dist

            if min_dist <= tolerance:
                current_run += 1
                longest = max(longest, current_run)
            else:
                current_run = 0
            ref_idx = 0  # Reset for next search

        return longest

    # CMLc: correct metrical level
    cmlc_longest = _longest_continuous(est, ref)
    cmlc = cmlc_longest / len(ref)

    # AMLc: try offbeat and double/half tempo alternatives
    best_amlc = cmlc_longest

    # Try half-beat offset
    if len(ref) > 1:
        half_interval = np.median(np.diff(ref)) / 2
        offbeat_ref = ref + half_interval
        offbeat_longest = _longest_continuous(est, offbeat_ref)
        best_amlc = max(best_amlc, offbeat_longest)

    # Try double tempo reference
    if len(ref) > 1:
        double_ref = []
        for i in range(len(ref) - 1):
            double_ref.append(ref[i])
            double_ref.append((ref[i] + ref[i + 1]) / 2)
        double_ref.append(ref[-1])
        double_longest = _longest_continuous(est, np.array(double_ref))
        best_amlc = max(best_amlc, double_longest)

    # Try half tempo reference
    half_ref = ref[::2]
    if len(half_ref) > 0:
        half_longest = _longest_continuous(est, half_ref)
        best_amlc = max(best_amlc, half_longest)

    amlc = best_amlc / len(ref)

    return min(cmlc, 1.0), min(amlc, 1.0)


def evaluate(
    result,  # AnalyzerResult
    ground_truth: dict,
) -> FullEvaluation:
    """
    Full evaluation of an AnalyzerResult against ground truth.

    ground_truth dict keys:
        bpm: float
        beats: list[float]
        downbeats: list[float]  (optional)
        phrases: list[float]    (optional)
    """
    evaluation = FullEvaluation(
        analyzer_name=result.analyzer_name,
        processing_time_ms=result.processing_time_ms,
    )

    # BPM
    if "bpm" in ground_truth and result.bpm is not None:
        evaluation.bpm_eval = bpm_accuracy(result.bpm, ground_truth["bpm"])

    # Beats
    if "beats" in ground_truth and len(result.beats) > 0:
        evaluation.beat_eval = beat_f_measure(result.beats, ground_truth["beats"])
        cmlc, amlc = continuity_metrics(result.beats, ground_truth["beats"])
        evaluation.cmlc = cmlc
        evaluation.amlc = amlc

    # Downbeats
    if "downbeats" in ground_truth and len(result.downbeats) > 0:
        evaluation.downbeat_eval = downbeat_f_measure(
            result.downbeats, ground_truth["downbeats"]
        )

    # Phrases
    if "phrases" in ground_truth and len(result.phrase_boundaries) > 0:
        evaluation.phrase_eval_tight = phrase_f_measure(
            result.phrase_boundaries, ground_truth["phrases"], tolerance=0.5
        )
        evaluation.phrase_eval_loose = phrase_f_measure(
            result.phrase_boundaries, ground_truth["phrases"], tolerance=3.0
        )

    return evaluation


def format_comparison_table(evaluations: list[FullEvaluation]) -> str:
    """Format a markdown comparison table from evaluation results."""
    lines = []
    lines.append("| Analyzer | BPM Acc | Beat F1 | Downbeat F1 | Phrase F1 (±0.5s) | Phrase F1 (±3s) | CMLc | AMLc | Time (ms) |")
    lines.append("|----------|---------|---------|-------------|-------------------|-----------------|------|------|-----------|")

    for ev in sorted(evaluations, key=lambda e: e.beat_eval.f_measure, reverse=True):
        lines.append(
            f"| {ev.analyzer_name:30s} "
            f"| {ev.bpm_eval.accuracy:5.1%}   "
            f"| {ev.beat_eval.f_measure:5.3f}   "
            f"| {ev.downbeat_eval.f_measure:9.3f}   "
            f"| {ev.phrase_eval_tight.f_measure:15.3f}   "
            f"| {ev.phrase_eval_loose.f_measure:13.3f}   "
            f"| {ev.cmlc:4.2f} "
            f"| {ev.amlc:4.2f} "
            f"| {ev.processing_time_ms:9.0f} |"
        )

    return "\n".join(lines)
