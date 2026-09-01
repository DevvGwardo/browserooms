"""Refresh only floor illumination from the baseboard-free scene checkpoints."""
import importlib.util
import json
from pathlib import Path
import bpy

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/continuous'
WORK = ROOT / 'assets/no-baseboards'
spec = importlib.util.spec_from_file_location('reference_export', ROOT / 'scripts/export_reference.py')
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)
exporter.OUT = OUT

for name in ['open-gallery', 'open-offset', 'open-columns']:
    bpy.ops.wm.open_mainfile(filepath=str(WORK / f'{name}.blend'))
    exporter.configure()
    bpy.context.scene.cycles.samples = 128
    floor = bpy.data.objects[f'{name} floor']
    image = exporter.image_target(floor, f'{name} clean carpet lighting', 1024)
    print(f'Refreshing floor lighting without baseboards: {name}', flush=True)
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'},
                        uv_layer='LightmapUV', margin=0)
    exporter.denoise_lightmap(image)
    exporter.save_image(image, f'{name}-floor-no-baseboards.hdr')

manifest = json.loads((OUT / 'modules.json').read_text())
for template in manifest['templates']:
    name = template['id']
    filename = f'{name}-floor-no-baseboards.hdr'
    manifest['materials'][f'{name}-floor']['lightmap'] = filename
    for atlas in template['radiance']:
        if atlas['family'] == 'floor':
            atlas['file'] = filename
manifest['palette']['floor'] = [1.15, 1.18, 0.68]
(WORK / 'carpet-lighting.json').write_text(json.dumps(manifest, indent=2) + '\n')
print('Prepared refreshed floor maps and carpet-lighting.json; source files unchanged.', flush=True)
