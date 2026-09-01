"""Extract curated fluorescent bursts without changing the original recording."""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.ndimage import uniform_filter1d

source = Path(sys.argv[1]).expanduser()
out = Path(__file__).resolve().parents[1] / 'public/audio/flicker'
rate = 44100
raw = subprocess.check_output([
    'ffmpeg', '-v', 'error', '-i', str(source), '-ac', '2', '-ar', str(rate),
    '-f', 'f32le', '-',
])
audio = np.frombuffer(raw, dtype='<f4').reshape(-1, 2).astype(np.float64)
envelope = np.sqrt(np.maximum(0, uniform_filter1d(
    np.mean(audio * audio, axis=1), int(rate * 0.01),
)))
threshold = max(float(np.percentile(envelope, 25)) * 3, 0.001)

# Quiet search windows measured in flicker.wav; keep clustered sputters together.
regions = [
    (0.23, 0.65), (0.80, 1.25), (1.68, 2.15), (2.47, 2.95),
    (4.54, 5.20), (5.87, 6.40), (6.88, 7.30), (7.74, 8.25),
    (9.52, 10.00), (10.95, 11.40), (12.75, 13.75), (14.04, 15.20),
]
if len(audio) < int(regions[-1][1] * rate):
    raise ValueError('Expected the original 17-second flicker.wav recording.')

out.mkdir(parents=True, exist_ok=True)
clips = []
for index, (left, right) in enumerate(regions):
    lower, upper = int(left * rate), int(right * rate)
    active = np.flatnonzero(envelope[lower:upper] > threshold)
    if len(active) < int(rate * 0.035):
        raise ValueError(f'No substantial burst in source region {left}-{right}.')
    start = max(lower, lower + int(active[0]) - int(rate * 0.012))
    end = min(upper, lower + int(active[-1]) + 1 + int(rate * 0.035))
    clip = audio[start:end].copy()

    # Level the audible core rather than boosting silence between crackles.
    core = clip[envelope[start:end] > threshold]
    rms = float(np.sqrt(np.mean(core * core)))
    clip *= min(0.04 / max(rms, 1e-8), 0.28 / max(np.abs(clip).max(), 1e-8))
    fade_in, fade_out = int(rate * 0.004), int(rate * 0.025)
    clip[:fade_in] *= np.linspace(0, 1, fade_in)[:, None]
    clip[-fade_out:] *= np.linspace(1, 0, fade_out)[:, None]
    filename = f'flicker-{index + 1:02d}.wav'
    wavfile.write(out / filename, rate, np.rint(clip * 32767).astype(np.int16))
    clips.append({
        'file': filename,
        'duration': round(len(clip) / rate, 6),
        'sourceStart': round(start / rate, 6),
        'sourceEnd': round(end / rate, 6),
    })

(out / 'manifest.json').write_text(json.dumps({'version': 1, 'clips': clips}, indent=2) + '\n')
print(json.dumps(clips, indent=2))
