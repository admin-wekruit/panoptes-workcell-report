"""One real-data check: ../panoptes-serving/.venv/bin/python check-source-bridge.py."""
from copy import deepcopy
import gzip
import importlib.util
import json
from pathlib import Path
import sys

import cv2
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parent / 'panoptes-serving'
EHS = Path('/Users/adam/Desktop/Tesla/ehs-spatial')
SOURCE = EHS / 'runs/bor1-components-20260909'
TARGET = RESEARCH / 'outputs/candidate-evaluation/lucida-replica-01'
sys.path[:0] = [str(EHS), str(RESEARCH / 'scripts/research')]
from ehs_spatial.object_evidence import load_candidate_mask
from assemble_lucida_scene import native_view, observed_mesh, mesh_bytes, matrix

spec = importlib.util.spec_from_file_location('bridge', HERE / 'build-source-bridge.py')
bridge = importlib.util.module_from_spec(spec); spec.loader.exec_module(bridge)
read = bridge.read


def rejected(callback):
    try:
        callback()
    except ValueError:
        return
    raise AssertionError('Invalid source evidence was accepted')


def main():
    source = read(SOURCE / 'object-evidence.json'); manifest = read(TARGET / 'manifest.json')
    base = read(HERE / 'blender-ranges-scene.json'); old_data = read(HERE / 'unified-data.json')
    scene = read(HERE / 'workcell-scene.json'); data = read(HERE / 'workcell-data.json')
    audit = read(HERE / 'workcell-assets/bridge-audit.json')
    assert len(source['candidates']) == 131 and audit['mapped_candidates'] == 58
    assert len(audit['omitted_candidates']) == 73 and audit['target_frames_without_registry'] == ['frame_0002']
    assert len(scene['observed_regions']) == 58 and not scene['unavailable_regions']
    assert len(data['objects']) == 68 and scene['objects'][:10] == base['objects']
    assert audit['new_model_calls'] == 0
    mapped = {r['id'] for r in scene['observed_regions']}
    omitted = {r['id'] for r in audit['omitted_candidates']}
    assert not mapped & omitted and mapped | omitted == {c['id'] for c in source['candidates']}
    frames = {f['frame_id']: f for f in source['frames']}
    targets = {f['frame_id']: f for f in manifest['frames']}
    candidates = {c['id']: c for c in source['candidates']}
    regions = {r['id']: r for r in scene['observed_regions']}
    by_data = {o['id']: o for o in data['objects']}
    wrong_mask = deepcopy(candidates[next(iter(mapped))]); wrong_mask['mask']['ref']['sha256'] = '0'*64
    rejected(lambda: load_candidate_mask(SOURCE, wrong_mask))
    views, masks = {}, {}
    for sfid, mapping in audit['mapped_source_frames'].items():
        fid = mapping['target_frame_id']; frame = targets[fid]
        affine = bridge.verify_match(SOURCE, TARGET, frames[sfid], frame)
        assert np.allclose(affine, np.eye(3), rtol=0, atol=1e-10)
        wrong_sha = deepcopy(frame); wrong_sha['sha256'] = '0'*64
        rejected(lambda: bridge.verify_match(SOURCE, TARGET, frames[sfid], wrong_sha))
        wrong_affine = deepcopy(frame); wrong_affine['input_to_canonical_pixel_centres'][0][2] += 1
        rejected(lambda: bridge.verify_match(SOURCE, TARGET, frames[sfid], wrong_affine))
        paths = 'geometry/frames/' + fid + '/'
        views[fid] = native_view(TARGET, {'frame_id': fid, 'canonical_rgb_path': paths+'canonical.png',
            'pointmap_path': paths+'pts3d.npy', 'K_path': paths+'intrinsics.npy', 'c2w_path': paths+'camera_to_world.npy',
            'valid_path': paths+'valid_mask.npy', 'content_valid_path': paths+'content_valid_mask.npy', 'conf_path': paths+'conf.npy'})
    for record in audit['records']:
        oid, fid, sfid = [record[k] for k in ['id', 'target_frame_id', 'source_frame_id']]
        candidate = candidates[oid]; original = load_candidate_mask(SOURCE, candidate)
        mask, native = bridge.transfer_mask(original, candidate['mask']['resolution'], frames[sfid], targets[fid])
        masks[oid] = mask
        if candidate['mask']['resolution'] == 'canonical':
            assert native is None and np.array_equal(mask, original), 'Equivalent canonical grids shifted'
        region, obj = regions[oid], by_data[oid]
        assert np.array_equal(mask, np.asarray(Image.open(HERE / region['mask']['path'])).astype(bool))
        assert bridge.polygons(mask) == (region['photo_polygons'], region['mask']['bbox_xyxy'])
        assert obj['scene_object_id'] == oid and obj['inventory_indices'] == [] and obj['metrics'] is None
        assert obj['views'][0]['frame_id'] == fid and obj['views'][0]['polygons'] == region['photo_polygons']
        assert obj['source_record']['source_frame_id'] == sfid and region['reference_frame'] == fid
        points = views[fid]['points'][mask & views[fid]['valid']]
        assert len(points) == record['target_supported_points']
        assert np.allclose(points.min(0), region['bounds_native']['min'], rtol=0, atol=0)
        assert np.allclose(points.max(0), region['bounds_native']['max'], rtol=0, atol=0)
        measure = region['measurements']; axes = np.asarray(measure['basis']['axes_native'])
        assert measure['scale']['status'] == 'uncalibrated' and measure['scale']['m_per_native'] is None
        assert np.allclose(np.ptp(points @ axes.T, axis=0), [measure['dimensions_native'][k] for k in ['width', 'depth', 'height']], atol=1e-12)
        for polygon in region['photo_polygons']:
            p = np.asarray(polygon)
            assert len(p) >= 3 and np.isfinite(p).all() and (p >= 0).all() and (p < 518).all()
    evidence = read(TARGET / 'evidence/objects.json'); floor = read(TARGET / 'evidence/floor.json')
    records = {o['object_id']: o for o in evidence['objects']}
    records['observed_floor'] = {'views': floor['views']}
    for context in scene['objects'][10:]:
        assert context['supplemental'] and not context['selectable'] and not context['editable']
        fid = context['frame_ids'][0]; union = np.zeros((518, 518), bool); exclude = union.copy()
        for record in audit['records']:
            if record['target_frame_id'] == fid:
                union |= masks[record['id']]
        for obj in base['objects']:
            if fid not in obj['frame_ids']:
                continue
            for view in records[obj['id']]['views']:
                if view['frame_id'] == fid:
                    exclude |= np.load(TARGET / view['canonical_mask_path']).astype(bool)
        mesh, pixels = observed_mesh(dict(views[fid], mask=union & ~exclude), return_pixel_faces=True)
        raw, layout = mesh_bytes(mesh)
        assert raw == gzip.decompress((HERE / context['mesh']['asset']['path']).read_bytes())
        assert not exclude.ravel()[pixels].any(), 'Original-asset pixels leaked into supplementary surface'
        for region in scene['observed_regions']:
            if region['reference_frame'] != fid or region['faces'] is None:
                continue
            indices = np.frombuffer(gzip.decompress((HERE / region['faces']['asset']['path']).read_bytes()), '<u4')
            expected = np.flatnonzero(masks[region['id']].ravel()[pixels].all(1))
            assert np.array_equal(indices, expected), 'Triangle membership changed or partitioned overlaps'
    for old, new in zip(old_data['objects'], data['objects']):
        assert old['metrics'] == new['metrics'] and old['views'] == new['views']
        source_mesh = next(o for o in base['objects'] if o['id'] == new['id'])
        assert new['source'] == source_mesh['source']
        layout = source_mesh['mesh']
        raw = gzip.decompress((HERE / layout['asset']['path']).read_bytes())
        vertices = np.frombuffer(raw, '<f4', layout['vertex_count']*9, layout['byte_offset']).reshape(-1, 9)[:, :3]
        transform = np.asarray(data['plan']['native_to_floor']) @ matrix(source_mesh['transform'])
        points = vertices @ transform[:3, :3].T + transform[:3, 3]
        assert np.array_equal(cv2.convexHull(points[:, :2].astype(np.float32)).reshape(-1, 2), new['plan']['hull'])
        assert np.allclose([points[:, 2].min(), points[:, 2].max()], [new['plan']['z_min'], new['plan']['z_max']], atol=1e-12)
    for camera, original in zip(scene['cameras'], base['cameras']):
        assert all(camera[k] == original[k] for k in original)
        A = np.asarray(camera['input_to_canonical_pixel_centres'])
        assert np.allclose(A @ camera['original_K'], camera['K'], atol=1e-10)
        assert Image.open(HERE / camera['original_image']).size == (camera['original_width'], camera['original_height'])
    for path, expected in audit['original_mesh_sha256'].items():
        assert bridge.sha(HERE / path) == expected
    button = next(r for r in audit['records'] if r['id'] == 'object_f595a5e6891b7fbc1b28c5dc')
    assert button['target_supported_points'] == 401 and button['native_triangles'] == button['supplementary_triangles'] == 718
    assert regions[button['id']]['mask']['bbox_xyxy'] == [418, 284, 441, 309]
    # A non-identity canonical affine must move pixels; no universal identity shortcut.
    sf = {'width': 20, 'height': 16, 'canonical_width': 10, 'canonical_height': 8, 'content_rect_xyxy': [1, 1, 9, 7]}
    tf = {'width': 10, 'height': 8, 'canonical_shape_hw': [10, 12], 'content_rect_xyxy': [2, 2, 10, 8]}
    for f in [sf, tf]:
        A = bridge.resize_affine([f['width'], f['height']], [8, 6]); A[:2, 2] += f['content_rect_xyxy'][:2]
        f['input_to_canonical_pixel_centres'] = A.tolist()
    single = np.zeros((8, 10), bool); single[3, 4] = True
    moved, native = bridge.transfer_mask(single, 'canonical', sf, tf)
    assert native is None and moved.sum() == 1 and moved[4, 5]
    # This actual pixel contour has positive area before simplification, but zero afterward.
    tiny = np.array([[1, 0, 1, 0], [1, 1, 0, 0], [0, 0, 0, 0]], bool)
    rings, _ = cv2.findContours(tiny.astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    assert any(cv2.contourArea(r) > 0 and cv2.contourArea(cv2.approxPolyDP(r, .5, True)) == 0 for r in rings)
    assert bridge.polygons(tiny) == ([], [0, 0, 3, 2])
    assert bridge.polygons(np.zeros((3, 4), bool)) == ([], None)
    print(json.dumps({'status': 'passed', 'retained_source_observations': 58, 'unmapped_observations': 73,
        'source_sha_and_affine_rejection': True, 'button_native_and_supplementary_triangles': 718,
        'original_meshes_unchanged': 10, 'original_metrics_unchanged': True, 'model_calls': 0}))


if __name__ == '__main__':
    main()
