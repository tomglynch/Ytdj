#!/usr/bin/env python3
"""
Generate more realistic synthetic EDM and Rock tracks for benchmarking.

These add basslines, synth pads, and noise layers on top of drums to better
simulate real music — harder for beat detection than pure kick patterns.
"""

import json
import numpy as np
import soundfile as sf
from pathlib import Path

SAMPLE_RATE = 44100
AUDIO_DIR = Path(__file__).parent / "audio"


def generate_kick(sr=SAMPLE_RATE, duration=0.15):
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    freq = 160 * np.exp(-25 * t) + 45
    phase = np.cumsum(2 * np.pi * freq / sr)
    kick = np.sin(phase) * np.exp(-12 * t)
    # Add sub-bass click
    click = np.sin(2 * np.pi * 4000 * t) * np.exp(-80 * t) * 0.3
    return (kick + click) * 0.7


def generate_snare(sr=SAMPLE_RATE, duration=0.15):
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    noise = np.random.randn(len(t)) * np.exp(-12 * t)
    tone = np.sin(2 * np.pi * 185 * t) * np.exp(-20 * t)
    return (noise * 0.4 + tone * 0.4) * 0.6


def generate_hihat(sr=SAMPLE_RATE, duration=0.05):
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    noise = np.random.randn(len(t)) * np.exp(-50 * t)
    # High-pass effect
    filtered = np.diff(noise, prepend=0) * 0.8
    return filtered * 0.15


def generate_open_hihat(sr=SAMPLE_RATE, duration=0.2):
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    noise = np.random.randn(len(t)) * np.exp(-8 * t)
    return noise * 0.12


def generate_clap(sr=SAMPLE_RATE, duration=0.12):
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    # Multiple noise bursts for clap texture
    env = np.exp(-15 * t) + 0.5 * np.exp(-20 * (t - 0.02)**2 * 1000)
    noise = np.random.randn(len(t)) * env
    return noise * 0.3


def place_sound(audio, sound, position_samples):
    end = min(position_samples + len(sound), len(audio))
    length = end - position_samples
    if length > 0 and position_samples >= 0:
        audio[position_samples:end] += sound[:length]


def generate_bassline(duration, bpm, root_freq=55, sr=SAMPLE_RATE):
    """Generate a simple bass synth pattern."""
    total_samples = int(sr * duration)
    bass = np.zeros(total_samples)
    beat_interval = 60.0 / bpm
    t_global = np.arange(total_samples) / sr

    # Bass pattern: root on 1 and 3, fifth on 2 and 4
    pattern_freqs = [root_freq, root_freq * 1.5, root_freq, root_freq * 1.5]
    note_dur = beat_interval * 0.7
    beat_idx = 0
    t = 0.0

    while t < duration - 0.1:
        freq = pattern_freqs[beat_idx % len(pattern_freqs)]
        start = int(t * sr)
        end = min(start + int(note_dur * sr), total_samples)
        note_t = np.arange(end - start) / sr
        note = np.sin(2 * np.pi * freq * note_t) * np.exp(-2 * note_t)
        # Add harmonics
        note += 0.3 * np.sin(2 * np.pi * freq * 2 * note_t) * np.exp(-3 * note_t)
        bass[start:end] += note * 0.25
        t += beat_interval
        beat_idx += 1

    return bass


def generate_synth_pad(duration, bpm, root_freq=220, sr=SAMPLE_RATE):
    """Generate a sustained synth pad with slow modulation."""
    total_samples = int(sr * duration)
    t = np.arange(total_samples) / sr

    # Chord: root + third + fifth
    pad = (np.sin(2 * np.pi * root_freq * t) +
           0.7 * np.sin(2 * np.pi * root_freq * 1.26 * t) +
           0.5 * np.sin(2 * np.pi * root_freq * 1.5 * t))

    # Slow amplitude modulation
    mod = 0.5 + 0.5 * np.sin(2 * np.pi * 0.25 * t)
    pad *= mod * 0.08

    return pad


def generate_edm_realistic(duration=60.0):
    """
    Realistic EDM: 128 BPM, 4-on-the-floor, with bass, synth pad,
    hi-hats on 16ths, claps on 2 and 4, buildup/drop structure.
    """
    bpm = 128.0
    beat_interval = 60.0 / bpm
    total_samples = int(SAMPLE_RATE * duration)
    audio = np.zeros(total_samples)

    kick = generate_kick()
    clap = generate_clap()
    hihat = generate_hihat()
    open_hh = generate_open_hihat()

    beats = []
    downbeats = []
    phrases = []
    beat_idx = 0
    t = 0.0

    while t < duration - 0.1:
        sample_pos = int(t * SAMPLE_RATE)
        beats.append(round(t, 6))

        bar_beat = beat_idx % 4
        bar_num = beat_idx // 4

        if bar_beat == 0:
            downbeats.append(round(t, 6))
        if beat_idx % 32 == 0:
            phrases.append(round(t, 6))

        # Kick on every beat (4-on-the-floor)
        place_sound(audio, kick, sample_pos)

        # Clap on beats 2 and 4
        if bar_beat in (1, 3):
            place_sound(audio, clap, sample_pos)

        # Hi-hats on 16th notes
        sixteenth = beat_interval / 4
        for sub in range(4):
            hh_time = t + sub * sixteenth
            hh_pos = int(hh_time * SAMPLE_RATE)
            if hh_pos < total_samples:
                if sub == 2 and bar_beat % 2 == 1:
                    place_sound(audio, open_hh, hh_pos)
                else:
                    place_sound(audio, hihat, hh_pos)

        t += beat_interval
        beat_idx += 1

    # Add bassline and synth pad
    audio += generate_bassline(duration, bpm, root_freq=55)
    audio += generate_synth_pad(duration, bpm, root_freq=220)

    # Add subtle noise floor
    audio += np.random.randn(total_samples) * 0.005

    # Normalize
    audio = audio / (np.max(np.abs(audio)) + 1e-8) * 0.9

    ground_truth = {
        "bpm": bpm,
        "beats": beats,
        "downbeats": downbeats,
        "phrases": phrases,
        "description": "Realistic EDM, 128 BPM, 4-on-the-floor with bass+synth+hihats",
    }

    return audio, ground_truth


def generate_rock_realistic(duration=60.0):
    """
    Realistic Rock: 120 BPM, kick-snare pattern with fills, bass,
    power chord pad, and occasional drum fills.
    """
    bpm = 120.0
    beat_interval = 60.0 / bpm
    total_samples = int(SAMPLE_RATE * duration)
    audio = np.zeros(total_samples)

    kick = generate_kick()
    snare = generate_snare()
    hihat = generate_hihat()
    open_hh = generate_open_hihat()

    beats = []
    downbeats = []
    phrases = []
    beat_idx = 0
    t = 0.0

    while t < duration - 0.1:
        sample_pos = int(t * SAMPLE_RATE)
        beats.append(round(t, 6))

        bar_beat = beat_idx % 4
        bar_num = beat_idx // 4

        if bar_beat == 0:
            downbeats.append(round(t, 6))
        if beat_idx % 32 == 0:
            phrases.append(round(t, 6))

        # Standard kick-snare pattern
        is_fill_bar = (bar_num + 1) % 8 == 0  # Fill every 8th bar

        if is_fill_bar and bar_beat >= 2:
            # Drum fill: rapid snare hits on 16ths
            sixteenth = beat_interval / 4
            for sub in range(4):
                fill_pos = int((t + sub * sixteenth) * SAMPLE_RATE)
                if fill_pos < total_samples:
                    place_sound(audio, snare, fill_pos)
        else:
            if bar_beat == 0:
                place_sound(audio, kick, sample_pos)
            elif bar_beat == 1:
                place_sound(audio, snare, sample_pos)
            elif bar_beat == 2:
                place_sound(audio, kick, sample_pos)
                # Ghost kick before beat 3
                ghost_pos = int((t - beat_interval * 0.25) * SAMPLE_RATE)
                if ghost_pos >= 0:
                    place_sound(audio, kick * 0.3, ghost_pos)
            elif bar_beat == 3:
                place_sound(audio, snare, sample_pos)

        # Hi-hats on 8th notes
        place_sound(audio, hihat, sample_pos)
        eighth_pos = int((t + beat_interval / 2) * SAMPLE_RATE)
        if eighth_pos < total_samples:
            if bar_beat == 3:
                place_sound(audio, open_hh, eighth_pos)
            else:
                place_sound(audio, hihat, eighth_pos)

        t += beat_interval
        beat_idx += 1

    # Add rock bass (lower, more aggressive)
    audio += generate_bassline(duration, bpm, root_freq=41.2)  # Low E

    # Add power chord pad (distorted feel via overtones)
    t_arr = np.arange(total_samples) / SAMPLE_RATE
    root = 82.4  # Low E
    chord = (np.sin(2 * np.pi * root * t_arr) +
             0.8 * np.sin(2 * np.pi * root * 1.5 * t_arr) +
             0.6 * np.sin(2 * np.pi * root * 2 * t_arr) +
             0.3 * np.sin(2 * np.pi * root * 3 * t_arr) +
             0.2 * np.sin(2 * np.pi * root * 4 * t_arr))
    # Mild distortion (soft clipping)
    chord = np.tanh(chord * 2) * 0.06
    audio += chord

    # Add noise floor
    audio += np.random.randn(total_samples) * 0.008

    # Normalize
    audio = audio / (np.max(np.abs(audio)) + 1e-8) * 0.9

    ground_truth = {
        "bpm": bpm,
        "beats": beats,
        "downbeats": downbeats,
        "phrases": phrases,
        "description": "Realistic Rock, 120 BPM, kick-snare with fills, bass+power chords",
    }

    return audio, ground_truth


def generate_dnb_fast(duration=60.0):
    """
    Drum & Bass: 174 BPM, breakbeat pattern, heavy bass.
    Tests high-tempo tracking.
    """
    bpm = 174.0
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

    # DnB pattern: kick on 1, snare on 3, with offbeat kicks
    while t < duration - 0.1:
        sample_pos = int(t * SAMPLE_RATE)
        beats.append(round(t, 6))

        bar_beat = beat_idx % 4
        if bar_beat == 0:
            downbeats.append(round(t, 6))
            place_sound(audio, kick, sample_pos)
        elif bar_beat == 1:
            # Offbeat kick at the "and" of 2
            off_pos = int((t + beat_interval * 0.5) * SAMPLE_RATE)
            if off_pos < total_samples:
                place_sound(audio, kick, off_pos)
        elif bar_beat == 2:
            place_sound(audio, snare, sample_pos)
        elif bar_beat == 3:
            pass

        if beat_idx % 32 == 0:
            phrases.append(round(t, 6))

        # Fast hi-hats
        place_sound(audio, hihat, sample_pos)
        eighth_pos = int((t + beat_interval / 2) * SAMPLE_RATE)
        if eighth_pos < total_samples:
            place_sound(audio, hihat, eighth_pos)

        t += beat_interval
        beat_idx += 1

    # Heavy sub-bass
    audio += generate_bassline(duration, bpm, root_freq=36)

    audio += np.random.randn(total_samples) * 0.005
    audio = audio / (np.max(np.abs(audio)) + 1e-8) * 0.9

    ground_truth = {
        "bpm": bpm,
        "beats": beats,
        "downbeats": downbeats,
        "phrases": phrases,
        "description": "Drum & Bass, 174 BPM, breakbeat pattern with heavy sub-bass",
    }

    return audio, ground_truth


def main():
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)

    tracks = [
        ("edm_realistic_128bpm", generate_edm_realistic),
        ("rock_realistic_120bpm", generate_rock_realistic),
        ("dnb_fast_174bpm", generate_dnb_fast),
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

    print(f"\nDone! {len(tracks)} realistic tracks written to {AUDIO_DIR}/")


if __name__ == "__main__":
    main()
