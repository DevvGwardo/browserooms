"""Prepare seamless lens-motion loops from the supplied lossless recordings."""
import json
import subprocess
import sys
from pathlib import Path
import numpy as np
from scipy.io import wavfile
from scipy.ndimage import uniform_filter1d
from scipy.signal import butter, sosfilt

folder = Path(sys.argv[1]).expanduser()
out = Path(__file__).resolve().parents[1] / 'public/audio/zoom'
out.mkdir(parents=True, exist_ok=True)
rate = 44100
clips = []
for index, source in enumerate(sorted(folder.glob('*.wav'))):
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(source), '-ac', '2', '-ar', str(rate), '-f', 'f32le', '-'])
    audio = np.frombuffer(raw, dtype='<f4').reshape(-1, 2).astype(np.float64)
    mono = audio.mean(axis=1)
    envelope = np.sqrt(np.maximum(0, uniform_filter1d(mono * mono, int(rate * 0.02))))
    active = np.flatnonzero(envelope > max(0.0005, envelope.max() * 0.08))
    if not len(active):
        continue
    start = max(active[0] + int(rate * 0.09), int(rate * 0.14))
    end = min(active[-1] - int(rate * 0.12), int(rate * 1.08))
    segment = sosfilt(butter(2, 60, fs=rate, btype='highpass', output='sos'), audio, axis=0)[start:end]
    overlap = min(int(rate * 0.08), len(segment) // 5)
    angle = np.linspace(0, np.pi / 2, overlap)[:, None]
    join = segment[-overlap:] * np.cos(angle) + segment[:overlap] * np.sin(angle)
    loop = np.concatenate([segment[overlap:-overlap], join])
    rms = np.sqrt(np.mean(loop * loop))
    loop *= min(0.035 / max(rms, 1e-8), 0.30 / max(np.abs(loop).max(), 1e-8))
    name = f'lens-{index + 1:02d}.wav'
    wavfile.write(out / name, rate, (np.clip(loop, -1, 1) * 32767).astype(np.int16))
    clips.append({'file': name, 'source': source.name, 'sourceStart': round(start / rate, 4),
                  'sourceEnd': round(end / rate, 4), 'duration': round(len(loop) / rate, 4),
                  'crossfadeMs': round(overlap / rate * 1000), 'rms': float(np.sqrt(np.mean(loop * loop)))})
if not clips:
    raise RuntimeError('No usable lens recordings found.')
(out / 'manifest.json').write_text(json.dumps({'version': 1, 'sampleRate': rate, 'clips': clips}, indent=2) + '\n')
print(json.dumps(clips, indent=2))
