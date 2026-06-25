#!/usr/bin/env python3
"""Render candidate "agent is thinking" cues to WAV so they can be auditioned.

Mirrors the app's palette (app/src/lib/callSounds.ts): pure sine tones, soft
gain, fast attack + exponential-ish decay so there are never clicks. Each file
loops the pattern a few times so the repeat/pause cadence is audible.
"""

import math
import struct
import wave

SR = 44100
MASTER = 0.5  # headroom; cues sit softly under the voice

# Equal-tempered note frequencies (Hz), same set the app uses.
NOTE = {
    "C3": 130.81, "G3": 196.00,
    "C4": 261.63, "E4": 329.63, "G4": 392.00, "A4": 440.00,
    "C5": 523.25, "D5": 587.33, "E5": 659.25, "G5": 783.99, "A5": 880.00,
    "C6": 1046.50,
}


class Track:
    def __init__(self):
        self.samples = []  # float buffer

    def _ensure(self, n):
        if len(self.samples) < n:
            self.samples.extend([0.0] * (n - len(self.samples)))

    def tone(self, freq, at, dur, gain=1.0, wave_type="sine", attack_s=0.012):
        """One enveloped tone scheduled `at` seconds from the start."""
        start = int(at * SR)
        length = int(dur * SR)
        self._ensure(start + length + 1)
        attack = max(1, int(attack_s * SR))
        for i in range(length):
            t = i / SR
            # fast linear attack, smooth exponential decay to ~silence
            if i < attack:
                env = i / attack
            else:
                env = math.exp(-3.0 * (i - attack) / length)
            if wave_type == "sine":
                s = math.sin(2 * math.pi * freq * t)
            elif wave_type == "triangle":
                # crude triangle from the fundamental
                s = (2 / math.pi) * math.asin(math.sin(2 * math.pi * freq * t))
            else:
                s = math.sin(2 * math.pi * freq * t)
            self.samples[start + i] += s * env * gain

    def write(self, path):
        peak = max((abs(x) for x in self.samples), default=1.0) or 1.0
        norm = MASTER / peak if peak > MASTER else 1.0
        with wave.open(path, "w") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            frames = bytearray()
            for x in self.samples:
                v = int(max(-1.0, min(1.0, x * norm)) * 32767)
                frames += struct.pack("<h", v)
            w.writeframes(bytes(frames))
        print(f"wrote {path}  ({len(self.samples)/SR:.1f}s)")


def loop(builder, period, times):
    """Render `builder(track, offset)` `times`, spaced `period` apart."""
    tr = Track()
    for k in range(times):
        builder(tr, k * period)
    return tr


# ----------------------------------------------------------------------------
# 1. descending-pulse — the requested one.
#    "BUM bum bum bum" on one low note, each hit quieter, then a pause, repeat.
def descending_pulse(tr, o, step=0.26, dur=0.30, attack_s=0.012):
    # Longer `dur` than `step` makes the tails overlap, so the bums blur into
    # one another (less "defined"); a slower `attack_s` rounds off each onset.
    gains = [0.95, 0.6, 0.38, 0.24]
    for i, g in enumerate(gains):
        tr.tone(NOTE["C4"], o + i * step, dur, gain=g, attack_s=attack_s)


# ----------------------------------------------------------------------------
# 2. heartbeat — a calm "lub-dub" of two soft low thumps, long pause, repeat.
#    Reassuring, biological; reads as "still here, still working".
def heartbeat(tr, o):
    tr.tone(NOTE["C3"], o + 0.00, 0.22, gain=0.9, wave_type="triangle")
    tr.tone(NOTE["G3"], o + 0.16, 0.30, gain=0.6, wave_type="triangle")


# ----------------------------------------------------------------------------
# 3. breathing-pad — a slow swell that fades in and back out, like a breath.
#    Two stacked fifths with very long, overlapping envelopes (inhale/exhale).
def breathing_pad(tr, o):
    # long soft attack: emulate by layering quiet staggered tones
    tr.tone(NOTE["C4"], o + 0.00, 1.6, gain=0.30)
    tr.tone(NOTE["G4"], o + 0.20, 1.5, gain=0.22)
    tr.tone(NOTE["C5"], o + 0.40, 1.3, gain=0.16)


# ----------------------------------------------------------------------------
# 4. curious-blips — three quick playful ascending pips, then a beat of silence.
#    Light, inquisitive; "hmm, let me check…".
def curious_blips(tr, o):
    tr.tone(NOTE["E5"], o + 0.00, 0.12, gain=0.7)
    tr.tone(NOTE["G5"], o + 0.14, 0.12, gain=0.7)
    tr.tone(NOTE["C6"], o + 0.28, 0.18, gain=0.6)


# ----------------------------------------------------------------------------
# 5. pendulum — two notes gently rock back and forth (A-B-A) like a metronome
#    or a swinging thought, with a small pause before the next swing.
def pendulum(tr, o):
    tr.tone(NOTE["A4"], o + 0.00, 0.26, gain=0.55)
    tr.tone(NOTE["D5"], o + 0.30, 0.26, gain=0.55)
    tr.tone(NOTE["A4"], o + 0.60, 0.32, gain=0.45)


def comparison(variants):
    """One file: for each variant, play `count` high marker pips, a beat, then
    the pulse twice, then a clear long silence."""
    tr = Track()
    cursor = 0.0
    for count, step, dur, attack in variants:
        for n in range(count):
            tr.tone(NOTE["C6"], cursor + n * 0.16, 0.10, gain=0.6)
        cursor += count * 0.16 + 0.7  # pips + breath
        pattern_len = 3 * step + dur
        for k in range(2):
            descending_pulse(tr, cursor + k * (pattern_len + 0.9),
                             step=step, dur=dur, attack_s=attack)
        cursor += 2 * (pattern_len + 0.9) + 1.6  # 2 patterns + section gap
    return tr


# Final pick: original defined bum, spaced at 500ms between hits. No blur.
STEP = 0.50
tr = Track()
for k in range(4):
    descending_pulse(tr, k * (3 * STEP + 0.30 + 1.6), step=STEP)
tr.write("01-bum-500ms-final.wav")
