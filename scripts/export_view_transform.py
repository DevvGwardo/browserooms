"""Export Blender's reference view as an HDR-log-input, display-sRGB 3D LUT."""
import json
from pathlib import Path
import numpy as np
import PyOpenColorIO as ocio

ROOT = Path(__file__).resolve().parents[1]
CONFIG = Path('/Applications/Blender.app/Contents/Resources/5.1/datafiles/colormanagement/config.ocio')
SIZE, LOG_MIN, LOG_MAX = 64, -12.0, 10.0
config = ocio.Config.CreateFromFile(str(CONFIG))
transform = ocio.GroupTransform([
    ocio.LookTransform(src='Linear Rec.709', dst='Linear Rec.709', looks='AgX - Medium High Contrast'),
    ocio.DisplayViewTransform(src='Linear Rec.709', display='sRGB', view='AgX'),
])
processor = config.getProcessor(transform).getDefaultCPUProcessor()

# OpenGL stores x (red) fastest, then y (green), then z (blue).
blue, green, red = np.meshgrid(np.arange(SIZE), np.arange(SIZE), np.arange(SIZE), indexing='ij')
linear = np.exp2(np.stack([red, green, blue], axis=-1) / (SIZE - 1) * (LOG_MAX - LOG_MIN) + LOG_MIN).astype(np.float32)
pixels = linear.reshape(-1, 3).copy()
processor.applyRGB(pixels)
rgba = np.ones((SIZE ** 3, 4), dtype=np.float16)
rgba[:, :3] = np.clip(pixels, 0, 1)
output = ROOT / 'public' / 'color'
output.mkdir(parents=True, exist_ok=True)
(output / 'agx-medium-high.bin').write_bytes(rgba.astype('<f2').tobytes())

# Check the shipped half-float LUT with the same trilinear sampling as the browser.
rng = np.random.default_rng(418)
samples = np.exp2(rng.uniform(-10, 6, (12000, 3))).astype(np.float32)
reference = samples.copy()
processor.applyRGB(reference)
coords = (np.log2(samples) - LOG_MIN) / (LOG_MAX - LOG_MIN) * (SIZE - 1)
lo = np.floor(coords).astype(int)
fraction = coords - lo
grid = rgba.reshape(SIZE, SIZE, SIZE, 4).astype(np.float32)
interpolated = np.zeros_like(reference)
for b in [0, 1]:
    for g in [0, 1]:
        for r in [0, 1]:
            weight = np.prod(np.where([r, g, b], fraction, 1 - fraction), axis=1)
            interpolated += grid[lo[:, 2] + b, lo[:, 1] + g, lo[:, 0] + r, :3] * weight[:, None]
error = np.abs(interpolated - np.clip(reference, 0, 1))
report = {
    'size': SIZE, 'logMin': LOG_MIN, 'logMax': LOG_MAX,
    'view': 'AgX', 'look': 'AgX - Medium High Contrast',
    'output': 'display sRGB; no further output transfer or tone mapping',
    'format': 'little-endian float16 RGBA, red axis fastest',
    'validationSamples': len(samples),
    'meanAbsoluteError': float(error.mean()),
    'p99AbsoluteError': float(np.quantile(error, 0.99)),
    'maxAbsoluteError': float(error.max()),
}
(output / 'view-transform.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
assert report['p99AbsoluteError'] < 0.015, 'LUT interpolation error exceeds tolerance'
