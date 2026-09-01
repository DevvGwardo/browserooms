"""Detect the supplied carpet impacts and produce lighter, level-matched one-shots."""
import json
import subprocess
import sys
from pathlib import Path
import numpy as np
from scipy.io import wavfile
from scipy.ndimage import uniform_filter1d
from scipy.signal import butter, find_peaks, lfilter, sosfilt, welch

SOURCE = Path(sys.argv[1]).expanduser()
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/audio/footsteps'
REPORT = ROOT / 'assets/footsteps'
OUT.mkdir(parents=True, exist_ok=True)
REPORT.mkdir(parents=True, exist_ok=True)
RATE = 44100
raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(SOURCE), '-ac', '1', '-ar', str(RATE), '-f', 'f32le', '-'])
audio = np.frombuffer(raw, dtype='<f4').astype(np.float64)
envelope = np.sqrt(np.maximum(0, uniform_filter1d(audio * audio, int(RATE * 0.012))))
peaks, _ = find_peaks(envelope, distance=int(RATE * 0.28), prominence=envelope.max() * 0.1, height=envelope.max() * 0.16)
assert len(peaks) >= 4, 'Not enough distinct impacts found to build a variation set'

filtered = sosfilt(butter(3, 160, fs=RATE, btype='highpass', output='sos'), audio)
# Broad low-mid cut reduces the remaining boxy body without sharpening the attack.
a = 10 ** (-3 / 40)
w = 2 * np.pi * 270 / RATE
alpha = np.sin(w) / (2 * 0.7)
b = np.array([1 + alpha * a, -2 * np.cos(w), 1 - alpha * a])
c = np.array([1 + alpha / a, -2 * np.cos(w), 1 - alpha / a])
filtered = lfilter(b / c[0], c / c[0], filtered)
filtered = sosfilt(butter(2, 6500, fs=RATE, btype='lowpass', output='sos'), filtered)

detector = 0.0
attack, release = np.exp(-1 / (RATE * 0.003)), np.exp(-1 / (RATE * 0.060))
threshold = 10 ** (-20 / 20)
compressed = np.empty_like(filtered)
for i, sample in enumerate(filtered):
    coefficient = attack if abs(sample) > detector else release
    detector = coefficient * detector + (1 - coefficient) * abs(sample)
    gain = (max(detector, threshold) / threshold) ** (1 / 2.2 - 1)
    compressed[i] = sample * gain

clips = []
preview = np.zeros_like(audio)
for index, peak in enumerate(peaks):
    left_limit = int((peaks[index - 1] + peak) / 2) if index else 0
    right_limit = int((peak + peaks[index + 1]) / 2) if index + 1 < len(peaks) else len(audio)
    onset = peak
    onset_threshold = max(float(np.percentile(envelope, 25)) * 3, envelope[peak] * 0.035)
    while onset > left_limit and envelope[onset] > onset_threshold:
        onset -= 1
    start = max(left_limit, onset - int(RATE * 0.012))
    end = min(right_limit, peak + int(RATE * 0.26))
    clip = compressed[start:end].copy()
    core = clip[max(0, peak - start - int(RATE * 0.025)):min(len(clip), peak - start + int(RATE * 0.11))]
    rms = np.sqrt(np.mean(core * core))
    clip *= 0.05 / max(rms, 1e-8)
    clip = 0.25 * np.tanh(clip / 0.25)
    fade_in, fade_out = int(RATE * 0.006), int(RATE * 0.025)
    clip[:fade_in] *= np.linspace(0, 1, fade_in)
    clip[-fade_out:] *= np.linspace(1, 0, fade_out)
    filename = f'carpet-{index + 1:02d}.wav'
    wavfile.write(OUT / filename, RATE, (np.clip(clip, -1, 1) * 32767).astype(np.int16))
    preview[start:end] += clip
    clips.append({'file': filename, 'sourcePeak': round(peak / RATE, 5),
                  'sourceStart': round(start / RATE, 5), 'sourceEnd': round(end / RATE, 5),
                  'duration': round(len(clip) / RATE, 5), 'peakOffset': round((peak - start) / RATE, 5),
                  'peakDbFS': round(20 * np.log10(max(np.max(np.abs(clip)), 1e-8)), 2),
                  'rmsDbFS': round(20 * np.log10(max(np.sqrt(np.mean(clip * clip)), 1e-8)), 2)})

def bass_fraction(signal):
    f, power = welch(signal, RATE, nperseg=8192)
    return float(power[f < 150].sum() / power.sum())

manifest = {'version': 1, 'sampleRate': RATE, 'clips': clips}
(OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
report = {'source': SOURCE.name, 'decodedDuration': len(audio) / RATE, 'impacts': len(peaks),
          'medianImpactInterval': float(np.median(np.diff(peaks)) / RATE),
          'processing': {'highpassHz': 160, 'highpassDbPerOctave': 18, 'lowMidHz': 270, 'lowMidCutDb': -3,
                         'lowpassHz': 6500, 'compressionRatio': 2.2, 'attackMs': 3, 'releaseMs': 60,
                         'peakCeilingDbFS': 20 * np.log10(0.25), 'limiter': 'smooth tanh', 'fadeInMs': 6, 'fadeOutMs': 25},
          'bassBelow150Fraction': {'before': bass_fraction(audio), 'after': bass_fraction(preview)},
          'clips': clips}
(REPORT / 'analysis.json').write_text(json.dumps(report, indent=2) + '\n')
wavfile.write(REPORT / 'processed-preview.wav', RATE, (np.clip(preview, -1, 1) * 32767).astype(np.int16))
print(json.dumps(report, indent=2))
