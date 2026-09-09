"""Export the two saved Blender trial cylinders; no fitting or inference.

From panoptes-public:
  .tools/blender-4.5.9/Blender.app/Contents/MacOS/Blender --background \
    --python panoptes-workcell-pages/build-blender-playground.py
"""

from copy import deepcopy
import gzip
import hashlib
import json
from pathlib import Path

import bpy
import numpy as np


ROOT = Path(__file__).resolve().parent
POSTS = {'left_post', 'right_post'}


def read(path):
    return json.loads(path.read_text())


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def pose(parts):
    x, y, z = np.radians(parts['rotation_deg'])
    cx, cy, cz, sx, sy, sz = np.cos(x), np.cos(y), np.cos(z), np.sin(x), np.sin(y), np.sin(z)
    rotation = np.array([[cz*cy, cz*sy*sx-sz*cx, cz*sy*cx+sz*sx],
                         [sz*cy, sz*sy*sx+cz*cx, sz*sy*cx-cz*sx], [-sy, cy*sx, cy*cx]])
    matrix = np.eye(4)
    matrix[:3, :3] = rotation @ np.diag(parts['scale'])
    matrix[:3, 3] = parts['position']
    return matrix


def world_points(vertices, matrix):
    return vertices @ matrix[:3, :3].T + matrix[:3, 3]


def decode(entry):
    spec, asset = entry['mesh'], entry['mesh']['asset']
    path = ROOT / asset['path']
    packed = path.read_bytes()
    raw = gzip.decompress(packed)
    assert len(packed) == asset['packed_bytes'] and len(raw) == asset['bytes']
    assert hashlib.sha256(raw).hexdigest() == asset['sha256']
    vertices = np.frombuffer(raw, '<f4', spec['vertex_count'] * 9, spec['byte_offset']).reshape(-1, 9)
    indices = np.frombuffer(raw, '<u4', spec['index_count'], spec['index_byte_offset'])
    assert spec['stride'] == 9 and spec['index_type'] == 'uint32'
    assert spec['byte_offset'] % 4 == spec['index_byte_offset'] % 4 == 0
    assert np.isfinite(vertices).all() and np.all((vertices[:, 6:] >= 0) & (vertices[:, 6:] <= 1))
    assert len(indices) % 3 == 0 and indices.max() < len(vertices)
    assert spec['bounds'] == {'min': vertices[:, :3].min(0).tolist(), 'max': vertices[:, :3].max(0).tolist()}
    return vertices, indices


def export_post(entry, obj, native_to_blender, parameter):
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=bpy.context.evaluated_depsgraph_get())
    try:
        mesh.calc_loop_triangles()
        assert len(mesh.loop_triangles) == 256
        blender_matrix = np.asarray(evaluated.matrix_world, dtype=float)
        native_matrix = np.linalg.inv(native_to_blender) @ blender_matrix
        assert np.allclose(native_matrix, parameter['native_object_to_world'], atol=1e-6, rtol=0)
        assert obj['radius_native'] == parameter['fitted_parameters']['radius_native']
        assert obj['height_native'] == parameter['fitted_parameters']['height_native']
        coordinates = np.asarray([v.co[:] for v in mesh.vertices], dtype=float)
        native = world_points(coordinates, native_matrix)
        center = native_matrix[:3, 3]
        # Bake evaluated rotation/scale, retain the cylinder center as the edit pivot.
        local = native - center
        normal_matrix = np.linalg.inv(native_matrix[:3, :3]).T
        colors = mesh.color_attributes.get('Cylinder display color')
        assert colors is not None and colors.domain == 'POINT'
        rows, expected, expected_normals = [], [], []
        for triangle in mesh.loop_triangles:
            for loop_index in triangle.loops:
                vertex_index = mesh.loops[loop_index].vertex_index
                normal = normal_matrix @ np.asarray(mesh.corner_normals[loop_index].vector, dtype=float)
                normal /= np.linalg.norm(normal)
                color = colors.data[vertex_index].color[:3]
                rows.append([*local[vertex_index], *normal, *color])
                expected.append(native[vertex_index])
                expected_normals.append(normal)
        # Split cap/side normals exactly, then share only identical complete vertices.
        vertices, inverse = np.unique(np.asarray(rows, dtype='<f4'), axis=0, return_inverse=True)
        indices = inverse.astype('<u4')
        raw = vertices.tobytes() + indices.tobytes()
        packed = gzip.compress(raw, mtime=0)
        path = ROOT / f'model-assets/blender-{entry["id"]}.bin.gz'
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(packed)
        entry['mesh'] = {'byte_offset': 0, 'vertex_count': len(vertices), 'stride': 9,
                         'index_byte_offset': vertices.nbytes, 'index_count': len(indices), 'index_type': 'uint32',
                         'bounds': {'min': vertices[:, :3].min(0).tolist(), 'max': vertices[:, :3].max(0).tolist()},
                         'asset': {'path': path.relative_to(ROOT).as_posix(), 'bytes': len(raw),
                                   'packed_bytes': len(packed), 'sha256': hashlib.sha256(raw).hexdigest()}}
        entry['transform'] = {'position': center.tolist(), 'rotation_deg': [0, 0, 0], 'scale': [1, 1, 1]}
        entry['label'] += ' · 参数化圆柱'
        entry['source'] = 'parametric'
        entry['model'] = 'Blender 4.5.9 · fitted 64-segment cylinder'
        entry['description'] = '冻结 Pi3X 观测点与多视图数值拟合；圆柱先验，无底板。统一深色用于展示，不是恢复的物理材质。'
        entry['metrics'] = {'comparison': 'blender/post-comparisons.json', 'candidate': 'ground-axis-cylinder-64',
                            'faces': len(indices) // 3, 'parameter_source': 'blender/post-parameters.json'}
        entry['metrics_report'] = 'metrics.html#blender'
        entry['parameters'] = parameter['fitted_parameters']
        restored, restored_indices = decode(entry)
        actual = world_points(restored[restored_indices, :3], pose(entry['transform']))
        error = float(np.max(np.abs(actual - expected)))
        assert error < 1e-7, 'Browser mesh differs from evaluated Blender triangle geometry'
        normal_error = float(np.max(np.abs(restored[restored_indices, 3:6] - expected_normals)))
        assert normal_error < 1e-7
        roundtrip = world_points(actual, native_to_blender)
        blender_expected = world_points(np.asarray(expected), native_to_blender)
        assert np.max(np.abs(roundtrip - blender_expected)) < 2e-7
        return {'object_id': entry['id'], 'triangles': len(indices) // 3, 'vertices': len(vertices),
                'packed_bytes': len(packed), 'max_evaluated_coordinate_error_native': error,
                'max_corner_normal_error': normal_error}
    finally:
        evaluated.to_mesh_clear()


def build():
    source_path, blend_path = ROOT / 'scene.json', ROOT / 'blender/workcell.blend'
    sources = [source_path, blend_path, ROOT / 'blender/post-parameters.json',
               ROOT / 'blender/post-comparisons.json', ROOT / 'blender/verification.json']
    hashes = {p.relative_to(ROOT).as_posix(): sha(p) for p in sources}
    assert hashes['blender/workcell.blend'] == read(ROOT / 'blender/verification.json')['blend_sha256']
    source = read(source_path)
    result = deepcopy(source)
    bpy.ops.wm.open_mainfile(filepath=str(blend_path))
    trial = bpy.data.scenes['02 · 参数化防撞柱试验']
    bpy.context.window.scene = trial
    bpy.context.view_layer.update()
    provenance = json.loads(bpy.data.texts['PARAMETERS.json'].as_string())
    parameters = json.loads(bpy.data.texts['POST_FIT_PARAMETERS.json'].as_string())
    assert parameters == read(ROOT / 'blender/post-parameters.json')
    assert json.loads(bpy.data.texts['POST_FIT_COMPARISONS.json'].as_string()) == read(ROOT / 'blender/post-comparisons.json')
    assert provenance['post_fit_parameters_sha256'] == hashes['blender/post-parameters.json']
    assert provenance['post_fit_comparisons_sha256'] == hashes['blender/post-comparisons.json']
    assert provenance['source_files_sha256']['result/scene.bin'] == source['source_binary']['sha256']
    assert provenance['source_cameras'] == source['cameras']
    native_to_blender = np.asarray(provenance['native_to_blender'], dtype=float)
    assert np.allclose(native_to_blender @ np.asarray(provenance['blender_to_native']), np.eye(4), atol=1e-10)
    records, lower, upper = [], [], []
    for entry, original, embedded in zip(result['objects'], source['objects'], provenance['source_objects'], strict=True):
        for key in ['id', 'transform', 'frame_ids', 'metrics']:
            assert original[key] == embedded[key]
        if entry['id'] in POSTS:
            obj, = [o for o in trial.objects if o.get('object_id') == entry['id']]
            parameter, = [p for p in parameters['objects'] if p['object_id'] == entry['id']]
            records.append(export_post(entry, obj, native_to_blender, parameter))
        else:
            assert entry == original, 'An original asset was changed'
        vertices, _ = decode(entry)
        points = world_points(vertices[:, :3], pose(entry['transform']))
        lower.append(points.min(0))
        upper.append(points.max(0))
    assert {r['object_id'] for r in records} == POSTS and len(result['objects']) == 10
    assert result['cameras'] == source['cameras']
    result['source_run_id'] = source['run_id']
    result['run_id'] = source['run_id'] + '-blender-posts'
    result['label'] = '参数化防撞柱试验'
    result['description'] = '实际 Blender 场景 02：只用拟合圆柱替换两根防撞柱，其余八个对象与原相机不变。此候选未替换原始生成场景；浏览器修改仅作用于本地编辑。'
    result['bounds'] = {'min': np.min(lower, axis=0).tolist(), 'max': np.max(upper, axis=0).tolist()}
    result['metrics_report'] = 'metrics.html'
    for key in ['glb', 'glb_asset', 'source_binary', 'binary']:
        result.pop(key, None)
    result['limitations'].append('Two fitted cylinders are explicit geometric priors with no footplates; their metrics are in blender/post-comparisons.json, not the RecGen table.')
    result['provenance'] = {'source_scene': 'scene.json', 'source_blend': 'blender/workcell.blend',
                            'blender_scene': trial.name, 'blender_version': bpy.app.version_string,
                            'source_sha256': hashes, 'native_to_blender': native_to_blender.tolist(),
                            'validation': records, 'reused_original_objects': 8,
                            'new_inference_calls': 0, 'new_fitting_calls': 0}
    text = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    assert '/Users/' not in text and 'file://' not in text
    assert hashes == {p.relative_to(ROOT).as_posix(): sha(p) for p in sources}, 'A source changed during export'
    output = ROOT / 'blender-scene.json'
    output.write_text(text)
    assert read(output) == result
    print(json.dumps({'status': 'passed', 'path': 'viewer.html?scene=blender-scene.json',
                      'scene_json_bytes': output.stat().st_size, 'new_mesh_packed_bytes': sum(r['packed_bytes'] for r in records),
                      'objects': records, 'reused_original_objects': 8}, ensure_ascii=False))


if __name__ == '__main__':
    build()
