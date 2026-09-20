#!/usr/bin/env python3
"""Build the GM-numbered Fischer 808 kit. Requires numpy, scipy, soundfile.
Run from any directory; downloads selected samples into the system temp directory.
"""
import hashlib
import html
import io
import json
import math
from pathlib import Path
import tempfile
import urllib.request
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'presets/drums/tr808-gm'
COMMIT = '85fbecf1bec32553395625ea659e2a56dfd7c0e1'
REPO = 'https://github.com/tidalcycles/sounds-tr808-fischer'
BASE = f'https://raw.githubusercontent.com/tidalcycles/sounds-tr808-fischer/{COMMIT}/'
RATE = 22050
# GM note, name, source, maximum duration, fade duration (ms).
SPEC = '''35|Acoustic Bass Drum|bd8/BD5050.WAV|300|100
36|Bass Drum 1|bd8/BD5025.WAV|220|80
37|Side Stick|rs8/RS.WAV|120|40
38|Acoustic Snare|sd8/SD5050.WAV|220|80
39|Hand Clap|cp8/CP.WAV|240|100
40|Electric Snare|sd8/SD5075.WAV|240|90
41|Low Floor Tom|lt8/LT25.WAV|260|100
42|Closed Hi Hat|ch8/CH.WAV|100|40
43|High Floor Tom|lt8/LT75.WAV|240|90
45|Low Tom|mt8/MT25.WAV|220|80
46|Open Hi Hat|oh8/OH50.WAV|350|220
47|Low Mid Tom|mt8/MT75.WAV|200|80
48|Hi Mid Tom|ht8/HT25.WAV|180|70
49|Crash Cymbal 1|cy8/CY5050.WAV|600|450
50|High Tom|ht8/HT75.WAV|170|65
56|Cowbell|cb8/CB.WAV|220|100
57|Crash Cymbal 2|cy8/CY7550.WAV|600|450
62|Mute Hi Conga|hc8/HC50.WAV|100|65
63|Open Hi Conga|hc8/HC50.WAV|220|90
64|Low Conga|lc8/LC50.WAV|240|100
70|Maracas|ma8/MA.WAV|130|45
75|Claves|cl8/CL.WAV|100|35'''

def fetch(name):
    cache = Path(tempfile.gettempdir()) / 'mmlisp-tr808-source' / COMMIT / name
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(BASE + name, timeout=60) as response:
            cache.write_bytes(response.read())
    return cache.read_bytes()

def sha(data):
    return hashlib.sha256(data).hexdigest()

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    records = []
    for line in SPEC.splitlines():
        note, name, source, limit_ms, fade_ms = line.split('|')
        note, limit_ms, fade_ms = int(note), int(limit_ms), int(fade_ms)
        raw = fetch(source)
        x, source_rate = sf.read(io.BytesIO(raw), dtype='float64', always_2d=True)
        channels, source_frames = x.shape[1], len(x)
        mono = x.mean(axis=1)
        divisor = math.gcd(source_rate, RATE)
        y = resample_poly(mono, RATE // divisor, source_rate // divisor)
        # Preserve the original onset. Only limit the tail.
        frames = min(len(y), round(RATE * limit_ms / 1000))
        shortened = frames < len(y)
        y = y[:frames].copy()
        # Short originals get only a 2 ms terminal fade, not a full decay rewrite.
        fade_frames = min(frames, round(RATE * (fade_ms if shortened else 2) / 1000))
        y[-fade_frames:] *= .5 * (1 + np.cos(np.linspace(0, np.pi, fade_frames)))
        peak = float(np.max(np.abs(y)))
        gain = min(1.0, (32765 / 32768) / peak) if peak else 1.0
        y *= gain
        rng = np.random.default_rng(note)
        pcm = np.clip(np.rint(y * 32768 + rng.random(frames) - rng.random(frames)), -32768, 32767).astype(np.int16)
        pcm[-1] = 0
        filename = f'{note:03d}-' + name.lower().replace(' ', '-') + '.wav'
        sf.write(OUT / filename, pcm, RATE, subtype='PCM_16')
        records.append(dict(note=note, name=name, file=filename, source=source,
            source_url=BASE+source, source_sha256=sha(raw), source_rate=source_rate,
            source_channels=channels, source_seconds=source_frames/source_rate,
            duration_ms=frames/RATE*1000, limit_ms=limit_ms,
            fade_ms=fade_frames/RATE*1000, shortened=shortened, gain=gain,
            sha256=sha((OUT/filename).read_bytes())))
    missing = sorted(set(range(35, 82)) - {r['note'] for r in records})
    manifest = dict(repository=REPO, commit=COMMIT, license='CC0-1.0',
        rate=RATE, bits=16, channels=1, mode='one-shot; no loops',
        processing='Channel mean; polyphase resampling; tail-only half-cosine fade; TPDF dither. No onset trim, EQ, normalization or pitch shift. Gain reduction only to prevent clipping.',
        mapping_notes={'38':'808 snare assigned to the GM Acoustic Snare slot; not an acoustic recording.',
            '40':'Alternate snappy setting of the same 808 snare.',
            '62':'Shortened high conga, not a recorded mute articulation.',
            '57':'Alternate tone setting of the same 808 cymbal.'},
        missing_notes=missing, files=records)
    (OUT/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    (OUT/'LICENSE-CC0.txt').write_bytes(fetch('LICENSE'))
    page='''<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>808 GM drum kit</title><style>body{font:16px system-ui;max-width:800px;margin:32px auto;padding:0 16px}li{margin:20px 0}audio{display:block;width:100%;margin-top:8px}</style><h1>808 GM ドラムキット</h1><p>22音 / 22.05 kHz・16-bit mono。番号はGMのMIDIノート番号。長い余韻はフェード済み。</p><p><a href="README.md">対応表・出典</a></p><ol>'''
    for r in records:
        page+=f'<li value="{r["note"]}"><a href="{r["file"]}">{html.escape(r["name"])}</a> — {r["duration_ms"]:.0f} ms<audio controls preload="none" src="{r["file"]}"></audio></li>'
    page+='</ol><script>document.addEventListener("play",e=>document.querySelectorAll("audio").forEach(a=>{if(a!==e.target)a.pause()}),true)</script></html>'
    (OUT/'index.html').write_text(page)
    print(f'Built {len(records)} WAVs, {sum((OUT/r["file"]).stat().st_size for r in records)} bytes.')

if __name__ == '__main__':
    main()
