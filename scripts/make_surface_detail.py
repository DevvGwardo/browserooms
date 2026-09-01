"""Original, tileable material detail; neutral 0.5 represents unit radiance."""
from pathlib import Path
import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parents[1] / 'public' / 'textures'
OUT.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(813)


def field(size, cells):
    # Resize a repeated neighbourhood and take its centre to preserve wrap filtering.
    coarse = rng.uniform(0, 1, (cells, cells)).astype(np.float32)
    repeated = Image.fromarray(np.tile(coarse, (3, 3)))
    resized = np.array(repeated.resize((size * 3, size * 3), Image.Resampling.BICUBIC))
    value = resized[size:size * 2, size:size * 2]
    return (value - value.mean()) / max(value.std(), 0.001)


size = 1024
y, x = np.mgrid[0:size, 0:size] / size
triangle = np.abs((x * 4) % 1 - 0.5)
phase = y * 8 + triangle * 1.3
chevron = np.maximum(np.sin(phase * np.pi * 2), 0) ** 7
weave = field(size, 340) * 0.012 + field(size, 96) * 0.008
paper = 0.5 - 0.085 * (chevron - chevron.mean()) + weave
Image.fromarray(np.uint8(np.clip(paper, 0, 1) * 255)).save(OUT / 'wallpaper-detail.png', optimize=True)

size = 2048
tufts = field(size, 620)
fibers = rng.normal(0, 1, (size, size)).astype(np.float32)
fibers = (fibers + np.roll(fibers, 1, axis=0) + np.roll(fibers, 2, axis=0)) / np.sqrt(3)
carpet = 0.5 + tufts * 0.068 + fibers * 0.022 + field(size, 150) * 0.024
Image.fromarray(np.uint8(np.clip(carpet, 0.12, 0.88) * 255)).save(OUT / 'carpet-detail.png', optimize=True)
print('Generated wallpaper detail (0.368 x 0.448 metres) and carpet detail (2 x 2 metres).')
