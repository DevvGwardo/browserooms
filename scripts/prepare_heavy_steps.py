"""Make distant, muffled heavy steps from the existing supplied carpet recordings.

Run with: uv run --no-project --with numpy --with scipy scripts/prepare_heavy_steps.py
"""
import json
import subprocess
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'public/audio/footsteps'
OUT = ROOT / 'public/audio/heavy-steps'
RATE = 44100
OUT.mkdir(parents=True, exist_ok=True)

# Different recordings, pitch, weight, and diffusion avoid a repeated giant stomp.
variations = [
    (1, 0.64, 0.94, 65, 0.76, 0.032, -27.0),
    (3, 0.69, 0.91, 80, 0.91, 0.039, -27.7),
    (5, 0.61, 0.97, 60, 0.83, 0.043, -26.8),
    (7, 0.67, 0.90, 74, 1.02, 0.035, -27.4),
    (9, 0.63, 0.95, 69, 0.88, 0.041, -27.8),
    (11, 0.71, 0.92, 86, 0.72, 0.028, -26.9),
]

clips = []
for index, (source_index, pitch, tempo, body_hz, tail_seconds, attack, target_db) in enumerate(variations, 1):
    source = SOURCE / f'carpet-{source_index:02d}.wav'
    raw = subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(source), '-ac', '1', '-ar', str(RATE),
        '-af', f'asetrate={round(RATE * pitch)},aresample={RATE},atempo={tempo}',
        '-f', 'f32le', '-',
    ])
    pitched = np.frombuffer(raw, dtype='<f4').astype(np.float64)
    # Filtering the real foot texture keeps the low body irregular, not a sub hit.
    texture = sosfilt(butter(3, [48, 620 + index * 24], btype='bandpass', fs=RATE, output='sos'), pitched)
    body = sosfilt(butter(2, [max(55, body_hz - 13), min(100, body_hz + 17)],
                          btype='bandpass', fs=RATE, output='sos'), pitched)
    body *= np.sqrt(np.mean(texture ** 2)) / max(np.sqrt(np.mean(body ** 2)), 1e-10)
    dry = texture + 0.65 * body
    dry = np.tanh(dry / max(3.2 * np.sqrt(np.mean(dry ** 2)), 1e-10))
    fade_in, fade_out = round(attack * RATE), round(0.095 * RATE)
    dry[:fade_in] *= np.sin(np.linspace(0, np.pi / 2, fade_in)) ** 2
    dry[-fade_out:] *= np.cos(np.linspace(0, np.pi / 2, fade_out)) ** 2

    # Dense, dark diffusion rather than discrete slap echoes or ringing sub-bass.
    rng = np.random.default_rng(8462 + index)
    time = np.arange(round(tail_seconds * RATE)) / RATE
    impulse = sosfilt(butter(2, [120, 470 + index * 20], btype='bandpass', fs=RATE, output='sos'),
                      rng.standard_normal(len(time)))
    impulse *= np.exp(-6.9 * time / tail_seconds)
    rise = round(0.042 * RATE)
    impulse[:rise] *= np.sin(np.linspace(0, np.pi / 2, rise)) ** 2
    impulse[-round(0.080 * RATE):] *= np.linspace(1, 0, round(0.080 * RATE)) ** 2
    room = fftconvolve(dry, impulse)
    room *= 0.16 * np.sqrt(np.sum(dry ** 2)) / max(np.sqrt(np.sum(room ** 2)), 1e-10)
    delay = round((0.024 + index * 0.002) * RATE)
    audio = np.pad(room, (delay, 0))
    audio[:len(dry)] += dry
    audio = sosfilt(butter(2, 42, btype='highpass', fs=RATE, output='sos'), audio)
    # Round the remaining peaks instead of pushing the whole distant step louder.
    knee = 4 * np.sqrt(np.mean(audio ** 2))
    audio = knee * np.tanh(audio / max(knee, 1e-10))
    audio = sosfilt(butter(2, 720, btype='lowpass', fs=RATE, output='sos'), audio)
    audio[-round(0.10 * RATE):] *= np.linspace(1, 0, round(0.10 * RATE)) ** 2
    audio[0] = audio[-1] = 0
    rms = np.sqrt(np.mean(audio ** 2))
    audio *= min(10 ** (target_db / 20) / max(rms, 1e-10),
                 10 ** (-10 / 20) / max(np.abs(audio).max(), 1e-10))

    filename = f'heavy-{index:02d}.wav'
    pcm = np.rint(audio * 32767).astype(np.int16)
    wavfile.write(OUT / filename, RATE, pcm)
    decoded = pcm.astype(np.float64) / 32768
    clips.append({
        'file': filename,
        'duration': round(len(pcm) / RATE, 6),
        'source': f'../footsteps/{source.name}',
        'pitchRatio': pitch,
        'tempoRatio': tempo,
        'bodyHz': body_hz,
        'attackMs': round(attack * 1000),
        'roomTailSeconds': tail_seconds,
        'rmsDbFS': round(float(20 * np.log10(np.sqrt(np.mean(decoded ** 2)))), 2),
        'peakDbFS': round(float(20 * np.log10(np.abs(decoded).max())), 2),
    })

(OUT / 'manifest.json').write_text(json.dumps({'version': 1, 'clips': clips}, indent=2) + '\n')
print(json.dumps(clips, indent=2))
