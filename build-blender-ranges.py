"""Add immutable same-source observed ranges to an existing complete scene.

Run with the research environment (no Blender, fitting, or inference):
  ../panoptes-serving/.venv/bin/python build-blender-ranges.py \
    --scene blender-scene.json \
    --evidence ../panoptes-serving/outputs/candidate-evaluation/lucida-replica-01/evidence/objects.json \
    --ehs-repo /Users/adam/Desktop/Tesla/ehs-spatial \
    --output blender-ranges-scene.json
"""
import argparse
from copy import deepcopy
import gzip
import hashlib
import json
from pathlib import Path
import sys

import numpy as np


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def build(scene_path, evidence_path, output, ehs_repo):
    scene_path, evidence_path, output = map(lambda p: Path(p).resolve(), (scene_path, evidence_path, output))
    if output == scene_path or output.parent != scene_path.parent:
        raise ValueError('Write a new sibling scene so existing relative assets remain unchanged')
    root = evidence_path.parent.parent
    research = Path(__file__).resolve().parent.parent / 'panoptes-serving'
    sys.path[:0] = [str(Path(ehs_repo).resolve()), str(research / 'scripts/research')]
    from ehs_spatial.measurements import measure_observed_points
    from assemble_lucida_scene import native_view

    original, evidence, manifest = read(scene_path), read(evidence_path), read(root / 'manifest.json')
    assert original.get('source_run_id', original['run_id']) == manifest['experiment'], 'Different source run'
    assert evidence['coordinate_system'] == 'new joint Pi3X native OpenCV world', 'Unsupported evidence coordinate contract'
    assert manifest['geometry']['model'] == 'Pi3X' and manifest['geometry']['metric_scale_known'] is False
    floor_path = evidence_path.parent / 'floor.json'
    floor = read(floor_path)
    assert floor['coordinate_system'] == 'new joint Pi3X native world' and floor['metric_scale_known'] is False
    plane = np.asarray(floor['plane_native'], float)
    assert plane.shape == (4,) and np.isfinite(plane).all()
    assert np.allclose(plane[:3] / np.linalg.norm(plane[:3]), original['up'], atol=1e-6), 'Different floor basis'
    frames = {f['frame_id']: f for f in manifest['frames']}
    geometry = {f['frame_id']: f['files'] for f in manifest['geometry']['frames']}
    cameras = {c['id']: c for c in original['cameras']}
    for fid, camera in cameras.items():
        frame, paths = frames[fid], root / 'geometry/frames' / fid
        assert sha(root / frame['input']) == frame['sha256'], 'Source photograph changed'
        for filename, expected in geometry[fid].items():
            assert sha(paths / filename) == expected, f'Geometry changed: {fid}/{filename}'
        assert sha(scene_path.parent / camera['image']) == frame['canonical_sha256'], 'Photo-grid identity changed'
        assert np.allclose(camera['K'], np.load(paths / 'intrinsics.npy'), rtol=0, atol=1e-6)
        assert np.allclose(camera['camera_to_world'], np.load(paths / 'camera_to_world.npy'), rtol=0, atol=1e-6)

    records = {o['object_id']: o for o in evidence['objects']}
    assert len(records) == len(evidence['objects']), 'Duplicate evidence identity'
    # Floor identity comes from its exact stored mask path, never a guessed semantic label.
    floor_ids = {Path(v['canonical_mask_path']).parts[-3] for v in floor['views']}
    assert len(floor_ids) == 1
    floor_id = next(iter(floor_ids))
    assert floor_id not in records
    records[floor_id] = {'object_id': floor_id, 'views': floor['views']}
    result = deepcopy(original)
    source_shas = {'scene': sha(scene_path), 'evidence/objects.json': sha(evidence_path),
                   'evidence/floor.json': sha(floor_path), 'manifest.json': sha(root / 'manifest.json'),
                   'measurements.py': sha(Path(ehs_repo) / 'ehs_spatial/measurements.py')}
    assets_before = {}
    for obj in result['objects']:
        asset = obj['mesh']['asset']; path = scene_path.parent / asset['path']
        packed = path.read_bytes(); raw = gzip.decompress(packed)
        assert len(packed) == asset['packed_bytes'] and len(raw) == asset['bytes']
        assert hashlib.sha256(raw).hexdigest() == asset['sha256']
        assets_before[asset['path']] = sha(path)
        record = records.get(obj['id'])
        if record is None:
            obj['measurements'] = measure_observed_points(np.empty((0, 3)), {}, mask_pixels=0)
            obj['measurements']['reason'] = 'No exact same-source object evidence identity'
            continue
        fid = record.get('reference_frame') or obj.get('reference_frame') or obj['frame_ids'][0]
        assert fid in obj['frame_ids'] and fid in cameras
        matching = [v for v in record['views'] if v['frame_id'] == fid]
        assert len(matching) == 1, 'Missing or ambiguous exact-frame evidence'
        spec = matching[0]; mask_path = root / spec['canonical_mask_path']
        assert sha(mask_path) == spec['sha256']['canonical_mask.npy'], 'Source mask changed'
        view = native_view(root, spec)
        assert np.allclose(view['K'], cameras[fid]['K'], rtol=0, atol=1e-6)
        assert np.allclose(view['c2w'], cameras[fid]['camera_to_world'], rtol=0, atol=1e-6)
        mask = np.load(mask_path, allow_pickle=False).astype(bool)
        assert mask.shape == view['valid'].shape
        supported = mask & view['valid']
        points = view['points'][supported]
        measurement = measure_observed_points(points, {'floor_plane': plane.tolist(), 'scale_source': 'model_native'},
            mask_pixels=int(mask.sum()), source={'candidate_id': obj['id'], 'frame_id': fid,
                'scene_sha256': sha(floor_path), 'image_sha256': frames[fid]['sha256'],
                'mask_sha256': sha(mask_path), 'pointmap_sha256': sha(root / spec['pointmap_path'])})
        # Executable numerical check: stored evidence dimensions enclose exactly these native support points.
        if measurement['status'] == 'available':
            axes = np.asarray(measurement['basis']['axes_native'])
            extents = np.ptp(points @ axes.T, axis=0)
            assert np.allclose(extents, [measurement['dimensions_native'][k] for k in ['width', 'depth', 'height']], atol=1e-12)
        assert measurement['scale']['status'] == 'uncalibrated' and measurement['scale']['m_per_native'] is None
        obj['reference_frame'] = fid
        obj['measurements'] = measurement

    result['run_id'] = original['run_id'] + '-source-ranges'
    result['label'] = '完整工位 · Blender 参数化与来源空间范围'
    result['description'] = '保留完整场景及两个 Blender 参数化柱。蓝色虚线范围与 H/W/D 来自同坐标系、同物体来源照片的有效深度；仅代表可见表面。未标定为米，未合并旧四图重建。'
    result['floor_plane'] = plane.tolist()
    result['floor_reference'] = {'path': 'evidence/floor.json', 'sha256': sha(floor_path), 'coordinate_system': evidence['coordinate_system']}
    result['provenance']['observed_ranges'] = {'source_run_id': manifest['experiment'], 'source_sha256': source_shas,
        'method': 'Exact evidence object ID and reference frame; native point-map mask, valid/content, conf >= 0.1, positive camera depth',
        'registration': 'Identity: source camera matrices, canonical photographs and frozen geometry hashes verified; no fit',
        'asset_sha256': assets_before}
    assert result['cameras'] == original['cameras']
    assert len(result['objects']) == len(original['objects'])
    for before, after in zip(original['objects'], result['objects']):
        assert {k: v for k, v in after.items() if k not in {'measurements', 'reference_frame'}} == {k: v for k, v in before.items() if k not in {'measurements', 'reference_frame'}}
    assert assets_before == {name: sha(scene_path.parent / name) for name in assets_before}
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    print(json.dumps({'output': output.name, 'objects': len(result['objects']),
        'available_ranges': sum(o['measurements']['status'] == 'available' for o in result['objects']),
        'unchanged_meshes': len(assets_before), 'bytes': output.stat().st_size, 'sha256': sha(output)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['scene', 'evidence', 'output', 'ehs-repo']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    build(args.scene, args.evidence, args.output, args.ehs_repo)
