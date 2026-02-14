#!/usr/bin/env python3
"""
Generate synthetic test audio files with known ground truth.

Creates WAV files + JSON ground truth for validating the benchmark harness
without needing real music files.

Tracks generated:
  1. edm_synthetic_128bpm.wav  — 4/4 kick pattern at 128 BPM (classic EDM)
  2. rock_synthetic_120bpm.wav — kick+snare pattern at 120 BPM (standard rock)
  3. variable_tempo.wav        — tempo ramp from 100 to 140 BPM
  4. complex_rhythm.wav        — syncopated pattern with accents
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import soundfile as sf


SAMPLE_RATE = 44100
AUDIO_DIR = Path(__file__).parent / "audio"


def generate_kick(sr: int = SAMPLE_RATE, duration: float = 0.08) -> np.ndarray:
    """Generate a synthetic kick drum sound (exponential sine sweep down)."""
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    freq = 150 * np.exp(-30 * t) + 40
    phase = np.cumsum(2 * np.pi * freq / sr)
    kick = np.sin(phase) * np.exp(-20 * t)
    return kick * 0.8


def generate_snare(sr: int = SAMPLE_RATE, duration: float = 0.1) -> np.ndarray:
    """Generate a synthetic snare sound (noise burst + sine)."""
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    noise = np.random.randn(len(t)) * np.exp(-15 * t)
    tone = np.sin(2 * np.pi * 200 * t) * np.exp(-25 * t)
    return (noise * 0.3 + tone * 0.5) * 0.6


def generate_hihat(sr: int = SAMPLE_RATE, duration: float = 0.04) -> np.ndarray:
    """Generate a synthetic hi-hat (filtered noise)."""
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    noise = np.random.randn(len(t)) * np.exp(-40 * t)
    return noise * 0.2


def place_sound(audio: np.ndarray, sound: np.ndarray, position_samples: int) -> None:
    """Place a sound at a given sample position in the audio buffer."""
    end = min(position_samples + len(sound), len(audio))
    length = end - position_samples
    if length > 0 and position_samples >= 0:
        audio[position_samples:end] += sound[:length]


def generate_edm_128bpm(duration: float = 30.0) -> tuple[np.ndarray, dict]:
    """
    EDM track: 128 BPM, 4-on-the-floor kick, hi-hats on 8ths.
    Clear, predictable beat structure.
    """
    bpm = 128.0
    beat_interval = 60.0 / bpm
    total_samples = int(SAMPLE_RATE * duration)
    audio = np.zeros(total_samples)

    kick = generate_kick()
    hihat = generate_hihat()

    beats = []
    downbeats = []
    phrases = []
    beat_idx = 0
    t = 0.0

    while t < duration - 0.1:
        sample_pos = int(t * SAMPLE_RATE)
        place_sound(audio, kick, sample_pos)
        beats.append(round(t, 6))

        if beat_idx % 4 == 0:
            downbeats.append(round(t, 6))
        if beat_idx % 32 == 0:
            phrases.append(round(t, 6))

        # Hi-hat on off-beats (8th notes)
        hihat_pos = int((t + beat_interval / 2) * SAMPLE_RATE)
        if hihat_pos < total_samples:
            place_sound(audio, hihat, hihat_pos)

        t += beat_interval
        beat_idx += 1

    # Normalize
    audio = audio / (np.max(np.abs(audio)) + 1e-8) * 0.9

    ground_truth = {
        "bpm": bpm,
        "beats": beats,
        "downbeats": downbeats,
        "phrases": phrases,
        "description": "EDM 4-on-the-floor, 128 BPM, 4/4 time",
    }

    return audio, ground_truth


def generate_rock_120bpm(duration: float = 30.0) -> tuple[np.ndarray, dict]:
    """
    Rock track: 120 BPM, kick-snare-kick-snare pattern, hi-hats on 8ths.
    """
    bpm = 120.0
    beat_interval = 60.0 / bpm
    total_samples = int(SAMPLE_RATE * duration)
    audio = np.zeros(total_samples)

    kick = generate_kick()
    snare = generate_snare()
    hihat = generate_hihat()

    beats = []
    downbeats = []
    phrases = []
    beat_idx = 0
    t = 0.0

    while t < duration - 0.1:
        sample_pos = int(t * SAMPLE_RATE)
        beats.append(round(t, 6))

        bar_beat = beat_idx % 4
        if bar_beat == 0:
            downbeats.append(round(t, 6))
            place_sound(audio, kick, sample_pos)
        elif bar_beat == 1:
            place_sound(audio, snare, sample_pos)
        elif bar_beat == 2:
            place_sound(audio, kick, sample_pos)
        elif bar_beat == 3:
            place_sound(audio, snare, sample_pos)

        if beat_idx % 32 == 0:
            phrases.append(round(t, 6))

        # Hi-hats on 8ths
        place_sound(audio, hihat, sample_pos)
        hihat_pos = int((t + beat_interval / 2) * SAMPLE_RATE)
        if hihat_pos < total_samples:
            place_sound(audio, hihat, hihat_pos)

        t += beat_interval
        beat_idx += 1

    audio = audio / (np.max(np.abs(audio)) + 1e-8) * 0.9

    ground_truth = {
        "bpm": bpm,
        "beats": beats,
        "downbeats": downbeats,
        "phrases": phrases,
        "description": "Rock kick-snare, 120 BPM, 4/4 time",
    }

    return audio, ground_truth


def generate_variable_tempo(duration: float = 30.0) -> tuple[np.ndarray, dict]:
    """
    Variable tempo track: BPM ramps from 100 to 140 linearly.
    Tests how well algorithms handle non-constant tempo.
    """
    start_bpm = 100.0
    end_bpm = 140.0
    total_samples = int(SAMPLE_RATE * duration)
    audio = np.zeros(total_samples)

    kick = generate_kick()

    beats = []
    downbeats = []
    beat_idx = 0
    t = 0.0

    while t < duration - 0.1:
        # Linear BPM interpolation
        progress = t / duration
        current_bpm = start_bpm + (end_bpm - start_bpm) * progress
        beat_interval = 60.0 / current_bpm

        sample_pos = int(t * SAMPLE_RATE)
        place_sound(audio, kick, sample_pos)
        beats.append(round(t, 6))

        if beat_idx % 4 == 0:
            downbeats.append(round(t, 6))

        t += beat_interval
        beat_idx += 1

    audio = audio / (np.max(np.abs(audio)) + 1e-8) * 0.9

    # Average BPM for reference
    avg_bpm = (start_bpm + end_bpm) / 2

    ground_truth = {
        "bpm": avg_bpm,
        "beats": beats,
        "downbeats": downbeats,
        "phrases": [],
        "description": f"Variable tempo {start_bpm}-{end_bpm} BPM",
    }

    return audio, ground_truth


def generate_complex_rhythm(duration: float = 30.0) -> tuple[np.ndarray, dict]:
    """
    Complex rhythm: 135 BPM with syncopation and accent patterns.
    Tests algorithms on less predictable rhythmic structures.
    """
    bpm = 135.0
    beat_interval = 60.0 / bpm
    total_samples = int(SAMPLE_RATE * duration)
    audio = np.zeros(total_samples)

    kick = generate_kick()
    snare = generate_snare()
    hihat = generate_hihat()

    beats = []
    downbeats = []
    phrases = []
    beat_idx = 0
    t = 0.0

    # Syncopation pattern (which 16th notes get kicks)
    # Pattern per bar: K..K ..S. K.K. ..S.  (K=kick, S=snare, .=hihat)
    kick_16ths = {0, 3, 8, 10}
    snare_16ths = {6, 14}

    while t < duration - 0.1:
        sample_pos = int(t * SAMPLE_RATE)
        beats.append(round(t, 6))

        if beat_idx % 4 == 0:
            downbeats.append(round(t, 6))
        if beat_idx % 32 == 0:
            phrases.append(round(t, 6))

        # Place 16th note subdivisions within this beat
        sixteenth = beat_interval / 4
        bar_beat = beat_idx % 4

        for sub in range(4):
            abs_16th = bar_beat * 4 + sub
            sub_time = t + sub * sixteenth
            sub_pos = int(sub_time * SAMPLE_RATE)

            if sub_pos >= total_samples:
                break

            if abs_16th in kick_16ths:
                place_sound(audio, kick, sub_pos)
            elif abs_16th in snare_16ths:
                place_sound(audio, snare, sub_pos)
            else:
                place_sound(audio, hihat, sub_pos)

        t += beat_interval
        beat_idx += 1

    audio = audio / (np.max(np.abs(audio)) + 1e-8) * 0.9

    ground_truth = {
        "bpm": bpm,
        "beats": beats,
        "downbeats": downbeats,
        "phrases": phrases,
        "description": "Complex syncopated rhythm, 135 BPM, 4/4 time",
    }

    return audio, ground_truth


def main():
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)

    tracks = [
        ("edm_synthetic_128bpm", generate_edm_128bpm),
        ("rock_synthetic_120bpm", generate_rock_120bpm),
        ("variable_tempo_100_140bpm", generate_variable_tempo),
        ("complex_rhythm_135bpm", generate_complex_rhythm),
    ]

    for name, generator in tracks:
        print(f"Generating {name}...")
        audio, ground_truth = generator()

        wav_path = AUDIO_DIR / f"{name}.wav"
        gt_path = AUDIO_DIR / f"{name}.json"

        sf.write(str(wav_path), audio, SAMPLE_RATE)
        with open(gt_path, "w") as f:
            json.dump(ground_truth, f, indent=2)

        beat_count = len(ground_truth["beats"])
        db_count = len(ground_truth["downbeats"])
        print(f"  -> {wav_path.name} ({len(audio)/SAMPLE_RATE:.1f}s, "
              f"{ground_truth['bpm']} BPM, {beat_count} beats, {db_count} downbeats)")

    print(f"\nDone! {len(tracks)} test tracks written to {AUDIO_DIR}/")


if __name__ == "__main__":
    main()
