"""Apply copies of supplied assets to the editable reference room; preserve imports."""
import bpy
import math
from mathutils import Matrix, Vector

scene = bpy.context.scene
if scene.get('reference_assets_applied'):
    raise RuntimeError('Assets were already applied; edit the look-development copies directly.')
selected = list(bpy.context.selected_objects)
active = bpy.context.view_layer.objects.active

wall_source = bpy.data.objects['Wall'].active_material
floor_source = bpy.data.objects['Carpet'].active_material
wall = wall_source.copy()
wall.name = 'Lookdev - supplied wallpaper'
group_node = next(n for n in wall.node_tree.nodes if n.type == 'GROUP')
group_node.node_tree = group_node.node_tree.copy()
group_node.node_tree.name = 'Lookdev - wallpaper shading'
for name, value in {'Bumpy': 0.025, 'Holes': 0.012, 'Wallpaper Thickness': 0.04,
                    'Fading': 0.015, 'Saturation': 0.48, 'Value': 1.08,
                    'Dirt': 0.015, 'Roughness Variation': 0.3,
                    'Pattern Scale': 1.0, 'Noise Scale': 1.0}.items():
    group_node.inputs[name].default_value = value
tree = group_node.node_tree
for name in ['Vector Math', 'Vector Math.001']:
    tree.nodes[name].inputs[0].default_value = (1, 1, 1)
for n in tree.nodes:
    if n.type == 'BUMP':
        n.inputs['Distance'].default_value = 0.001 if n.name != 'Bump' else 0.0005

coordinates = bpy.data.objects.new('Lookdev material coordinates', None)
scene.collection.objects.link(coordinates)
coordinates.hide_render = True
coordinate_node = tree.nodes['Texture Coordinate.001']
coordinate_node.object = coordinates
mapping = tree.nodes['Mapping.001']
tree.links.new(coordinate_node.outputs['Object'], mapping.inputs['Vector'])
wall_bsdf = tree.nodes['Principled BSDF']
wall_bsdf.inputs['Specular IOR Level'].default_value = 0.25
roughness = tree.nodes.new('ShaderNodeMapRange')
roughness.inputs['To Min'].default_value = 0.72
roughness.inputs['To Max'].default_value = 0.94
old_roughness = wall_bsdf.inputs['Roughness'].links[0].from_socket
tree.links.new(old_roughness, roughness.inputs['Value'])
tree.links.new(roughness.outputs['Result'], wall_bsdf.inputs['Roughness'])
wall['physical_tile_m'] = 0.5
wall['source_asset'] = wall_source.name

carpet = floor_source.copy()
carpet.name = 'Lookdev - supplied carpet'
bsdf = carpet.node_tree.nodes['Principled BSDF']
color = carpet.node_tree.nodes.new('ShaderNodeHueSaturation')
color.inputs['Saturation'].default_value = 0.6
color.inputs['Value'].default_value = 1.15
carpet.node_tree.links.new(bsdf.inputs['Base Color'].links[0].from_socket, color.inputs['Color'])
carpet.node_tree.links.new(color.outputs['Color'], bsdf.inputs['Base Color'])
bsdf.inputs['Specular IOR Level'].default_value = 0.18
bsdf.inputs['Sheen Weight'].default_value = 0.22
bsdf.inputs['Sheen Roughness'].default_value = 0.8
carpet.node_tree.nodes['Normal Map'].inputs['Strength'].default_value = 0.38
carpet.node_tree.nodes['Normal Map'].uv_map = 'SurfaceUV'
carpet['physical_tile_m'] = 1.2
carpet['source_asset'] = floor_source.name


def surface_uv(obj, tile, floor=False):
    uv = obj.data.uv_layers.get('SurfaceUV') or obj.data.uv_layers.new(name='SurfaceUV')
    obj.data.uv_layers.active = uv
    uv.active_render = True
    for face in obj.data.polygons:
        normal = obj.matrix_world.to_3x3() @ face.normal
        for loop in face.loop_indices:
            p = obj.matrix_world @ obj.data.vertices[obj.data.loops[loop].vertex_index].co
            pair = (p.x, p.y) if floor or abs(normal.z) > 0.8 else (p.y if abs(normal.x) > abs(normal.y) else p.x, p.z)
            uv.data[loop].uv = (pair[0] / tile, pair[1] / tile)


for obj in bpy.data.collections['Architecture'].objects:
    if obj.type != 'MESH':
        continue
    obj.data.materials.clear()
    obj.data.materials.append(wall)
    surface_uv(obj, 0.5)
for obj in bpy.data.collections['Floor'].objects:
    obj.data.materials.clear()
    obj.data.materials.append(carpet)
    surface_uv(obj, 1.2, True)

tile_source = bpy.data.materials['Acoustic tile - replace with supplied material']
tile = tile_source.copy()
tile.name = 'Lookdev - refined acoustic tile'
old = next(n for n in tile.node_tree.nodes if n.type == 'BSDF_DIFFUSE')
new = tile.node_tree.nodes.new('ShaderNodeBsdfPrincipled')
new.inputs['Roughness'].default_value = 0.91
new.inputs['IOR'].default_value = 1.4
new.inputs['Specular IOR Level'].default_value = 0.18
for source_name, target_name in [('Color', 'Base Color'), ('Normal', 'Normal')]:
    if old.inputs[source_name].is_linked:
        tile.node_tree.links.new(old.inputs[source_name].links[0].from_socket, new.inputs[target_name])
    elif source_name == 'Color':
        new.inputs[target_name].default_value = old.inputs[source_name].default_value
output = next(n for n in tile.node_tree.nodes if n.type == 'OUTPUT_MATERIAL')
tile.node_tree.links.new(new.outputs['BSDF'], output.inputs['Surface'])
for n in tile.node_tree.nodes:
    if n.type == 'BUMP':
        n.inputs['Strength'].default_value = 0.2
        n.inputs['Distance'].default_value = 0.0008
for obj in bpy.data.collections['Ceiling and lighting'].objects:
    for slot in obj.material_slots:
        if slot.material == tile_source:
            slot.material = tile

# Make a detached, simplified version. The user's Geometry Nodes tool remains untouched.
source_outlet = bpy.data.objects['Outlet']
bpy.context.view_layer.update()
evaluated = source_outlet.evaluated_get(bpy.context.evaluated_depsgraph_get())
mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=bpy.context.evaluated_depsgraph_get())
mesh.name = 'Lookdev outlet - optimized'
outlet = bpy.data.objects.new('Lookdev outlet 1', mesh)
bpy.data.collections['Trim and fixtures'].objects.link(outlet)
for index, material in enumerate(list(mesh.materials)):
    copied = material.copy()
    copied.name = 'Lookdev - ' + material.name
    mesh.materials[index] = copied
for obj in bpy.context.selected_objects:
    obj.select_set(False)
outlet.select_set(True)
bpy.context.view_layer.objects.active = outlet
modifier = outlet.modifiers.new('Web silhouette budget', 'DECIMATE')
modifier.ratio = 0.035
modifier.use_collapse_triangulate = True
bpy.ops.object.modifier_apply(modifier=modifier.name)
mesh = outlet.data
mesh.calc_loop_triangles()
outlet_triangles = len(mesh.loop_triangles)
for index, (location, normal) in enumerate([
    ((0.4, -2.911, 0.34), (0, -1, 0)),
    ((-5.3, -3.521, 0.32), (0, -1, 0)),
    ((5.639, 0.2, 0.34), (-1, 0, 0)),
]):
    obj = outlet if index == 0 else bpy.data.objects.new(f'Lookdev outlet {index + 1}', outlet.data)
    if index:
        bpy.data.collections['Trim and fixtures'].objects.link(obj)
    direction = Vector(normal)
    up = Vector((0, 0, 1))
    right = up.cross(direction)
    obj.rotation_euler = Matrix((right, up, direction)).transposed().to_euler()
    obj.location = location
    obj['source_asset'] = source_outlet.name

bpy.data.collections['Incoming Assets'].hide_render = True
for obj in bpy.context.selected_objects:
    obj.select_set(False)
for obj in selected:
    obj.select_set(True)
bpy.context.view_layer.objects.active = active
scene.cycles.samples = 192
scene.cycles.preview_samples = 48
scene.view_settings.exposure = 1.0
scene['reference_assets_applied'] = True
scene['outlet_triangles_each'] = outlet_triangles
bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)
result = {'wallMaterial': wall.name, 'floorMaterial': carpet.name, 'tileMaterial': tile.name,
          'outletTrianglesEach': outlet_triangles, 'outletsPlaced': 3, 'file': bpy.data.filepath}
