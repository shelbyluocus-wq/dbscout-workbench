"""Chiptune soundtrack + sound effects for the Blackcat promo (stdlib only)."""
import math
import random
import struct
import sys
import wave

SR = 22050
DUR = 70.0
N = int(SR * DUR)
music = [0.0] * N
sfx = [0.0] * N
rng = random.Random(42)
TAU = 2 * math.pi


def mtof(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def osc(kind, ph):
    x = ph % 1.0
    if kind == "sq":
        return 1.0 if x < 0.5 else -1.0
    if kind == "sq25":
        return 1.0 if x < 0.25 else -1.0
    if kind == "saw":
        return 2 * x - 1
    if kind == "tri":
        return 4 * abs(x - 0.5) - 1
    return math.sin(TAU * x)


def env(i, n, a, r):
    """Linear attack, exponential-ish release over the last `r` samples."""
    v = 1.0
    if i < a:
        v = i / a
    if i > n - r:
        v *= max(0.0, (n - i) / r)
    return v


def tone(buf, t, dur, f0, kind="sq", vol=0.2, a=0.005, r=0.04, f1=None, vib=0.0, decay=None):
    s0 = int(t * SR)
    n = int(dur * SR)
    ph = 0.0
    A, R = max(1, int(a * SR)), max(1, int(r * SR))
    for i in range(n):
        k = s0 + i
        if k >= N:
            break
        p = i / n
        f = f0 if f1 is None else f0 * (f1 / f0) ** p
        if vib:
            f *= 1 + vib * math.sin(TAU * 5.5 * i / SR)
        ph += f / SR
        v = vol * env(i, n, A, R)
        if decay:
            v *= math.exp(-i / SR / decay)
        buf[k] += v * osc(kind, ph)


def noise(buf, t, dur, vol=0.3, decay=0.1, lp=1.0, hp=False, lp_end=None, a=0.001, shape=None):
    s0 = int(t * SR)
    n = int(dur * SR)
    y = 0.0
    prev = 0.0
    A = max(1, int(a * SR))
    for i in range(n):
        k = s0 + i
        if k >= N:
            break
        x = rng.uniform(-1, 1)
        c = lp if lp_end is None else lp + (lp_end - lp) * (i / n)
        y += c * (x - y)
        out = y
        if hp:
            out, prev = y - prev, y
        v = vol * min(1.0, i / A)
        if shape == "swell":
            v *= math.sin(math.pi * i / n)
        elif decay:
            v *= math.exp(-i / SR / decay)
        buf[k] += v * out


# ---------- instruments ----------
def kick(t, vol=0.55, buf=None):
    tone(buf or music, t, 0.3, 150, "sine", vol, a=0.001, r=0.05, f1=42, decay=0.12)


def snare(t, vol=0.22):
    noise(music, t, 0.2, vol, decay=0.06, lp=0.7)
    tone(music, t, 0.08, 190, "tri", vol * 0.6, a=0.001, decay=0.04)


def hat(t, vol=0.08):
    noise(music, t, 0.05, vol, decay=0.015, lp=0.95, hp=True)


def clap(t, vol=0.2):
    for d in (0, 0.011, 0.022):
        noise(music, t + d, 0.12, vol, decay=0.03, lp=0.6, hp=True)


# ---------- sound effects ----------
def pop(t, vol=0.32):
    tone(sfx, t, 0.09, 380, "sine", vol, a=0.002, r=0.03, f1=1300)


def bloop(t, vol=0.3):
    tone(sfx, t, 0.12, 900, "sine", vol, a=0.002, r=0.05, f1=500)


def stamp(t, vol=0.6):
    tone(sfx, t, 0.35, 120, "sine", vol, a=0.001, r=0.1, f1=45, decay=0.09)
    noise(sfx, t, 0.12, vol * 0.7, decay=0.025, lp=0.5)


def whoosh(t, dur=0.35, vol=0.25, down=False):
    noise(sfx, t, dur, vol, lp=0.03 if not down else 0.4, lp_end=0.4 if not down else 0.03, shape="swell")


def boom(t, vol=0.9):
    tone(sfx, t, 1.4, 90, "sine", vol, a=0.001, r=0.3, f1=28, decay=0.35)
    noise(sfx, t, 1.3, vol * 0.8, decay=0.3, lp=0.08)


def thunder(t):
    noise(sfx, t, 2.4, 0.9, decay=0.6, lp=0.12)
    for _ in range(14):
        noise(sfx, t + rng.uniform(0, 0.5), 0.05, 0.5, decay=0.02, lp=0.9, hp=True)


def ding(t, f=1568, vol=0.25, decay=0.4):
    tone(sfx, t, decay * 3, f, "sine", vol, a=0.001, r=0.05, decay=decay)
    tone(sfx, t, decay * 2, f * 2.76, "sine", vol * 0.3, a=0.001, r=0.05, decay=decay * 0.5)


def gong(t):
    for f, v in ((110, 0.35), (163, 0.22), (231, 0.16), (305, 0.1)):
        tone(sfx, t, 2.2, f, "sine", v, a=0.004, r=0.4, decay=0.9, vib=0.003)


def siren(t0, t1, vol=0.07):
    s0, s1 = int(t0 * SR), int(t1 * SR)
    ph = 0.0
    for k in range(s0, min(s1, N)):
        tt = (k - s0) / SR
        f = 760 + 220 * math.sin(TAU * 1.6 * tt)
        ph += f / SR
        fade = min(1.0, (s1 - k) / (0.3 * SR))
        sfx[k] += vol * fade * osc("sq", ph)


def typing(t0, t1, step=0.09, vol=0.18):
    t = t0
    while t < t1:
        noise(sfx, t + rng.uniform(-0.015, 0.015), 0.03, vol * rng.uniform(0.6, 1), decay=0.006, lp=0.8, hp=True)
        t += step


def buzzer(t, dur=0.45, vol=0.22):
    tone(sfx, t, dur, 98, "saw", vol, a=0.005, r=0.05)
    tone(sfx, t, dur, 104, "sq", vol * 0.5, a=0.005, r=0.05)


def scratch(t):
    s0 = int(t * SR)
    ph = 0.0
    for i in range(int(0.45 * SR)):
        tt = i / SR
        f = 300 + 900 * abs(math.sin(TAU * 4.5 * tt))
        ph += f / SR
        sfx[s0 + i] += 0.25 * math.exp(-tt * 3) * (osc("saw", ph) * 0.5 + rng.uniform(-0.5, 0.5))


def rewind(t0, t1):
    s0, s1 = int(t0 * SR), int(t1 * SR)
    ph = 0.0
    for k in range(s0, s1):
        tt = (k - s0) / SR
        f = 1800 + 700 * math.sin(TAU * 18 * tt)
        ph += f / SR
        sfx[k] += 0.08 * osc("tri", ph)


def horn(t):
    tone(sfx, t, 0.5, 330, "saw", 0.18, a=0.02, r=0.1, f1=700, vib=0.02)


def sparkle(t, n=6, step=0.05, base=84, vol=0.12):
    for i, m in enumerate((0, 4, 7, 12, 16, 19, 24, 28)[:n]):
        ding(t + i * step, mtof(base + m), vol, 0.25)


def boing(t):
    tone(sfx, t, 0.45, 180, "sine", 0.35, a=0.002, r=0.08, f1=520, vib=0.08)


def meow(t):
    s0 = int(t * SR)
    n = int(0.75 * SR)
    ph = 0.0
    for i in range(n):
        p = i / n
        f = 520 + 380 * math.sin(math.pi * min(1.0, p * 1.6)) - 120 * p
        f *= 1 + 0.015 * math.sin(TAU * 6 * i / SR)
        ph += f / SR
        open_ = math.sin(math.pi * p) ** 0.6  # "m-e-o-w" mouth opening
        v = 0.0
        for h in range(1, 9):
            formant = math.exp(-((h * f - (700 + 900 * open_)) / 600) ** 2)
            v += formant * math.sin(TAU * h * ph) / h ** 0.3
        a = min(1.0, i / (0.04 * SR)) * min(1.0, (n - i) / (0.18 * SR))
        sfx[s0 + i] += 0.32 * a * v


def voice(t, m, dur=0.22, vol=0.2):
    """A sung-ish syllable for the chant: saw + vibrato with a soft formant."""
    tone(sfx, t, dur, mtof(m), "saw", vol, a=0.01, r=0.06, vib=0.012)
    tone(sfx, t, dur, mtof(m + 12), "sq25", vol * 0.35, a=0.01, r=0.06, vib=0.012)


def chord(buf, t, dur, notes, kind="saw", vol=0.08, a=0.02, r=0.3, decay=None):
    for m in notes:
        tone(buf, t, dur, mtof(m), kind, vol, a=a, r=r, decay=decay, vib=0.004)


# ---------- music ----------
BEAT = 0.5
MELODY = [
    [76, 76, 79, 76, 74, 72, 74, None],
    [76, 79, 81, 79, 76, 74, 72, None],
    [69, 72, 74, 72, 69, 67, 69, None],
    [67, 69, 72, 74, 76, 74, 79, None],
    [76, 76, 79, 76, 74, 72, 74, None],
    [81, 79, 76, 79, 81, 84, 81, None],
    [79, 76, 74, 76, 72, 74, 69, None],
    [67, 69, 72, 74, 72, None, None, None],
]
ROOTS = [48, 45, 41, 43]  # C Am F G


def groove(t0, t1, lead=True, lead_vol=0.075, mute=(), intense=False):
    bar = 0
    t = t0
    while t < t1 - 1e-6:
        root = ROOTS[bar % 4]
        mel = MELODY[bar % 8]
        for e in range(8):
            te = t + e * 0.25
            if te >= t1 or any(a <= te < b for a, b in mute):
                continue
            if e % 2 == 0:
                kick(te)
                if intense or e in (2, 6):
                    clap(te, 0.16 if intense else 0.2)
            else:
                hat(te)
            bass = [0, 0, 12, 0, 7, 0, 12, 7][e]
            tone(music, te, 0.22, mtof(root - 12 + bass), "sq25", 0.11, a=0.003, r=0.05)
            if lead and mel[e] is not None:
                hold = 0.24 if e + 1 < 8 and mel[e + 1] is not None else 0.45
                tone(music, te, hold, mtof(mel[e]), "sq", lead_vol, a=0.004, r=0.06, vib=0.006)
        t += 2.0
        bar += 1


def drama(t0, t1):
    chord(music, t0, t1 - t0, [57, 60, 64], "saw", 0.045, a=0.8, r=0.5)
    tone(music, t0, t1 - t0, mtof(33), "tri", 0.18, a=0.5, r=0.5)
    for i, t in enumerate((t0 + 0.3, t0 + 0.55, t0 + 0.8)):
        tone(sfx, t, 1.6 if i == 2 else 0.25, 70, "sine", 0.7, a=0.001, r=0.2, f1=50, decay=0.5 if i == 2 else 0.12)
        noise(sfx, t, 0.3, 0.3, decay=0.08, lp=0.15)
        chord(sfx, t, 1.6 if i == 2 else 0.22, [45, 52, 57], "saw", 0.07, a=0.002, r=0.1, decay=0.6)
    t = t0 + 1.5
    while t < t1 - 0.4:  # heartbeat
        kick(t, 0.35, sfx)
        kick(t + 0.22, 0.25, sfx)
        t += 1.0
    chord(sfx, t0 + 3.0, 0.9, [58, 59, 64, 65], "saw", 0.05, a=0.002, r=0.3, decay=0.5)  # betrayal sting


def lounge(t0, t1):
    pats = [[60, 64, 67, 71, 72, 71, 67, 64], [53, 57, 60, 64, 65, 64, 60, 57]]
    t, bar = t0, 0
    while t < t1 - 1e-6:
        for e, m in enumerate(pats[bar % 2]):
            tone(music, t + e * 0.25, 0.4, mtof(m + 12), "tri", 0.07, a=0.005, r=0.2, decay=0.3)
        chord(music, t, 2.0, [n + 0 for n in pats[bar % 2][:4]], "sine", 0.035, a=0.2, r=0.4)
        t += 2.0
        bar += 1


def fanfare(t):
    for d, notes, dur in ((0, [60, 64, 67], 0.15), (0.2, [60, 64, 67], 0.15), (0.4, [65, 69, 72], 0.15), (0.6, [67, 71, 74], 0.15), (0.8, [72, 76, 79, 84], 1.2)):
        chord(sfx, t + d, dur, notes, "saw", 0.06, a=0.005, r=0.1)
        chord(sfx, t + d, dur, [n - 12 for n in notes[:1]], "sq", 0.06, a=0.005, r=0.1)


def build():
    # S1 cold open
    tone(music, 0.0, 3.4, 55, "sine", 0.15, a=0.5, r=0.1)
    for i in range(7):
        noise(sfx, 0.0 + i * 0.5, 0.03, 0.18 if i % 2 == 0 else 0.12, decay=0.008, lp=0.9, hp=True)
    typing(0.6, 2.4)
    stamp(2.9, 0.4)
    noise(sfx, 3.25, 0.05, 0.4, decay=0.01, lp=0.9, hp=True)
    boom(3.4)
    siren(3.4, 6.9)
    for t in (4.0, 4.25, 4.5, 4.9):
        stamp(t, 0.5)
    pop(5.3)
    pop(5.6)
    boing(5.6)
    # S2 arrival
    gong(7.0)
    thunder(7.9)
    whoosh(8.05, 0.45, 0.35, down=True)
    boing(8.55)
    stamp(8.55, 0.35)
    sparkle(9.0, 6)
    fanfare(9.3)
    stamp(9.8, 0.5)
    pop(10.5)
    # S3 rescue
    groove(11.0, 29.0, mute=[(26.0, 26.5)])
    pop(12.1)
    whoosh(12.7)
    whoosh(13.0)
    tone(sfx, 14.1, 1.1, 300, "sq", 0.05, a=0.05, r=0.05, f1=1200)
    stamp(15.4)
    horn(15.45)
    for _ in range(25):
        noise(sfx, 15.4 + rng.uniform(0, 0.6), 0.03, 0.2, decay=0.01, lp=0.9, hp=True)
    pop(15.9)
    # S4 shopping channel
    pop(17.15)
    whoosh(17.3)
    whoosh(17.55)
    stamp(18.1)
    buzzer(18.1)
    whoosh(19.0, 0.45, 0.3)
    pop(19.6)
    pop(19.9)
    ding(20.6, 1318, 0.25)
    ding(20.75, 1760, 0.25)
    pop(21.2)
    # S5 replace and undo
    stamp(23.5)
    pop(24.5)
    sparkle(24.6, 8, 0.06)
    scratch(26.0)
    rewind(26.05, 26.5)
    stamp(26.3)
    pop(27.0)
    sparkle(27.05, 6, 0.07, 79, 0.1)
    # S6 drama
    drama(29.0, 36.0)
    stamp(34.6, 0.45)
    # S7 engines
    groove(36.0, 51.0, mute=[(37.2, 37.5)])
    for t in (36.15, 36.4, 36.65):
        whoosh(t, 0.3, 0.3)
    boom(37.2, 0.8)
    stamp(37.5)
    pop(38.3)
    # S8 AI
    pop(40.1)
    whoosh(40.2, 0.3, 0.2)
    bloop(40.6)
    typing(41.1, 41.7, 0.08, 0.12)
    bloop(41.7)
    whoosh(42.5, 0.3, 0.2)
    noise(sfx, 43.6, 0.04, 0.4, decay=0.01, lp=0.9, hp=True)
    buzzer(43.62, 0.3, 0.18)
    stamp(43.7)
    pop(44.0)
    # S9 transfer
    pop(45.05)
    for t in (45.3, 45.45, 45.6):
        whoosh(t, 0.25, 0.18)
    for t, m in ((45.6, 84), (46.2, 88), (46.8, 91)):
        ding(t, mtof(m), 0.28)
    for i in range(8):
        ding(47.6 + i * 0.05, 2093 if i % 2 else 1760, 0.16, 0.08)
    stamp(47.9)
    whoosh(48.3, 0.8, 0.3)
    # S9g glow
    sparkle(49.2, 8, 0.08, 88, 0.1)
    pop(49.35)
    # S10 chant
    groove(51.0, 57.0, lead=False, intense=True)
    lines = [
        ([67, 67, 64, 67], [69, 67, 64, 62]),
        ([67, 67, 64, 67], [69, 72, 69, 67]),
        ([67, 67, 64, 67], [72, 69, 74, 72]),
    ]
    for li, (a, b) in enumerate(lines):
        t0 = 51.0 + li * 2.0
        stamp(t0, 0.35)
        stamp(t0 + 1.0, 0.45)
        for i, m in enumerate(a + b):
            voice(t0 + i * 0.25, m, 0.45 if i == 7 else 0.22)
    # S11 testimonial
    lounge(57.0, 63.0)
    pop(57.1)
    pop(57.7)
    whoosh(58.1, 0.3, 0.2)
    pop(58.4)
    sparkle(58.45, 5, 0.06, 84, 0.1)
    typing(58.9, 60.4, 0.095, 0.1)
    ding(60.6, 1046, 0.2, 0.6)
    # S12 end card
    fanfare(63.05)
    stamp(63.4)
    groove(63.5, 68.0, lead_vol=0.06)
    pop(63.8)
    whoosh(64.2, 0.35, 0.2)
    pop(65.0)
    pop(66.5)
    meow(66.55)
    chord(sfx, 68.0, 2.0, [48, 60, 64, 67, 72], "saw", 0.06, a=0.005, r=1.2, decay=0.9)
    kick(68.0, 0.6, sfx)
    noise(sfx, 68.0, 1.6, 0.25, decay=0.5, lp=0.5, hp=True)


def write(path):
    out = []
    for k in range(N):
        t = k / SR
        fade = 1.0 if t < 69.0 else max(0.0, 70.0 - t)
        x = (music[k] * 0.8 + sfx[k]) * fade
        out.append(int(32767 * math.tanh(x * 1.1) * 0.92))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(struct.pack(f"<{N}h", *out))


build()
write(sys.argv[1] if len(sys.argv) > 1 else "promo.wav")
