"""Create an editable look-development scene without changing the live module kit."""
import importlib.util
import math
from pathlib import Path
import bpy

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'assets/reference-room.blend'
if OUTPUT.exists():
    raise RuntimeError('Working file already exists; refusing to overwrite user edits.')
spec = importlib.util.spec_from_file_location('module_builder', ROOT / 'scripts/bake_modules.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
source = builder.source
builder.build('gallery')

# Keep the standard outer shell and four connectors; replace only generated interior pieces.
old_interiors = (
    'Near wallpaper return', 'First offset partition', 'Inner gallery wall',
    'Gallery crosswall', 'Rear offset return', 'Left gallery wing', 'Left rear wing',
    'Foreground column', 'Gallery column A', 'Gallery column B', 'Left room column',
)
for family in ('walls', 'details'):
    for obj in list(source.GROUPS[family]):
        if obj.name.startswith(old_interiors):
            source.GROUPS[family].remove(obj)
            bpy.data.objects.remove(obj, do_unlink=True)

paper = source.GROUPS['walls'][0].data.materials[0]
paper.name = 'Wallpaper - replace with supplied material'
paper.node_tree.nodes.clear()
out = source.node(paper, 'ShaderNodeOutputMaterial')
surface = source.node(paper, 'ShaderNodeBsdfPrincipled', **{
    'Base Color': source.rgb('ccc8b0'), 'Roughness': 0.84, 'IOR': 1.45,
})
source.wire(paper, surface.outputs[0], out.inputs['Surface'])
position = source.node(paper, 'ShaderNodeNewGeometry').outputs['Position']
wave = source.node(paper, 'ShaderNodeTexWave', Scale=90.0, Distortion=1.3)
wave.bands_direction = 'X'
source.wire(paper, position, wave.inputs['Vector'])
aging = source.noise(paper, position, 1.2, 3)
fac = source.math_node(paper, 'ADD', source.math_node(paper, 'MULTIPLY', wave.outputs['Fac'], 0.055),
                       source.math_node(paper, 'MULTIPLY', aging, 0.36))
color = source.ramp(paper, fac, [(0, 'd0cbb2'), (1, 'bdb79c')])
source.wire(paper, color, surface.inputs['Base Color'])
bump = source.node(paper, 'ShaderNodeBump', Strength=0.22, Distance=0.0004)
source.wire(paper, source.noise(paper, position, 230, 2), bump.inputs['Height'])
source.wire(paper, bump.outputs['Normal'], surface.inputs['Normal'])

carpet = source.GROUPS['floor'][0].data.materials[0]
carpet.name = 'Carpet - replace with supplied material'
ceiling = source.GROUPS['ceiling'][0].data.materials[0]
ceiling.name = 'Acoustic tile - replace with supplied material'
trim = source.GROUPS['details'][0].data.materials[0]

for name, x, z, width, depth, height in [
    ('Reference central partition', 0.5, 0.2, 3.8, 5.4, 3.0),
    ('Reference left half wall', -5.8, 3.4, 5.6, 0.22, 1.14),
    ('Reference right gallery wing', 5.8, -1.0, 0.3, 6.4, 3.0),
    ('Reference right rear return', 7.5, -4.0, 3.6, 0.28, 3.0),
    ('Reference far offset wall', -1.8, -7.4, 7.5, 0.28, 3.0),
    ('Reference left room column', -8.7, -3.5, 0.65, 0.65, 3.0),
    ('Reference far room column', 8.1, -9.2, 0.7, 0.7, 3.0),
]:
    source.wall_box(name, x, -z, width, depth, paper, trim, height=height)
source.cube('Half wall timber cap', (-5.8, -3.4, 1.155), (5.66, 0.29, 0.055), trim, 'details', 0.006)

# Bright left room and back pockets; leave the central mass and right approach shaded.
main_ceiling = source.GROUPS['ceiling'][0]
lit = 0
for face in main_ceiling.data.polygons:
    if face.material_index != 2:
        continue
    p = main_ceiling.matrix_world @ face.center
    x, z = p.x, -p.y
    if x < -2.0 or (x > 4.0 and z < -4.0) or (-2.0 <= x <= 4.0 and z < -6.0):
        lit += 1
    else:
        face.material_index = 3

scene = bpy.context.scene
source.configure()
scene.cycles.samples = 128
scene.cycles.diffuse_bounces = 8
scene.cycles.glossy_bounces = 4
scene.cycles.max_bounces = 12
scene.cycles.preview_samples = 32
scene.view_settings.look = 'AgX - Medium High Contrast'
scene.view_settings.exposure = 0.8
scene.camera.data.lens = 21.0
source.camera_from_view({'position': [-4.2, 1.65, 10.0], 'yaw': -0.38, 'pitch': -0.025})

for label, family in [('Architecture', 'walls'), ('Floor', 'floor'), ('Ceiling and lighting', 'ceiling'), ('Trim and fixtures', 'details')]:
    collection = bpy.data.collections.new(label)
    scene.collection.children.link(collection)
    for obj in source.GROUPS[family]:
        for previous in list(obj.users_collection):
            previous.objects.unlink(obj)
        collection.objects.link(obj)
incoming = bpy.data.collections.new('Incoming Assets')
scene.collection.children.link(incoming)
for obj in bpy.context.view_layer.objects:
    obj.select_set(False)
bpy.context.view_layer.objects.active = None
bpy.context.view_layer.active_layer_collection = bpy.context.view_layer.layer_collection.children['Incoming Assets']
scene['reference_intent'] = 'Broad openings, a foreground partition, half walls, restrained vertical wallpaper and pools of fluorescent light.'
scene['asset_requests'] = 'Wallpaper, low-pile carpet and acoustic ceiling tile PBR materials. Import assets into Incoming Assets.'
scene['working_copy'] = 'Editable look-development scene. Live browser assets are unchanged.'
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type == 'VIEW_3D':
            area.spaces.active.region_3d.view_perspective = 'CAMERA'
            area.spaces.active.region_3d.view_camera_zoom = 0
            area.spaces.active.overlay.show_overlays = False
            area.spaces.active.shading.type = 'RENDERED'
scene.render.filepath = str(ROOT / 'assets/reference-room-preview.png')
bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT))
print(f'Saved editable reference room: {OUTPUT}; {lit} powered main-room panels', flush=True)
