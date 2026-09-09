"""Build the public, frozen report snapshot without inference or Blender.

Run with panoptes-serving/.venv/bin/python. Source files remain read-only.
"""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys

import cv2
import numpy as np
from PIL import Image
from scipy.spatial.transform import Rotation


def read(path):
    return json.loads(path.read_text())


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write(path, value):
    text = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    assert not any(word in text for word in ['/Users/', 'file://', 'gemini_cursor', 'api_key', 'access_token']), 'Private data in public snapshot'
    path.write_text(text)


def floor_transform(floor):
    """NumPy equivalent of Blender's shortest rotation from floor normal to +Z."""
    plane = np.asarray(floor['plane_native'], dtype=float)
    plane /= np.linalg.norm(plane[:3])
    normal, target = plane[:3], np.array([0., 0., 1.])
    cross = np.cross(normal, target)
    cosine = float(normal @ target)
    if cosine < -1 + 1e-12:
        rotation = np.diag([1., -1., -1.])
    else:
        x, y, z = cross
        skew = np.array([[0, -z, y], [z, 0, -x], [-y, x, 0]])
        rotation = np.eye(3) + skew + skew @ skew / (1 + cosine)
    transform = np.eye(4)
    transform[:3, :3] = rotation
    transform[:3, 3] = rotation @ (plane[3] * normal)
    assert np.allclose(rotation @ normal, target, atol=1e-8)
    assert np.allclose(rotation.T @ rotation, np.eye(3), atol=1e-8)
    return transform


def pose(parts):
    result = np.eye(4)
    result[:3, :3] = Rotation.from_euler('xyz', parts['rotation_deg'], degrees=True).as_matrix() @ np.diag(parts['scale'])
    result[:3, 3] = parts['position']
    return result


def contours(mask):
    assert mask.ndim == 2 and mask.dtype == bool and mask.any(), 'Empty or invalid canonical mask'
    # RETR_LIST retains inner rings; the report must use SVG fill-rule="evenodd".
    rings, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    polygons = []
    for ring in rings:
        polygon = cv2.approxPolyDP(ring, .5, True).reshape(-1, 2)
        if len(polygon) >= 3 and cv2.contourArea(polygon) > 0:
            polygons.append(polygon.tolist())
    assert polygons, 'No non-degenerate visible mask contour'
    yy, xx = np.nonzero(mask)
    return polygons, [int(xx.min()), int(yy.min()), int(xx.max()) + 1, int(yy.max()) + 1]


def metrics(comparison):
    def row(view):
        before, after = view['generated_initial'], view['generated_refined']
        return {'frame_id': view['frame_id'], 'before_iou': before['visible_iou'],
                'after_iou': after['visible_iou'], 'before_depth': before['relative_depth_p50'],
                'after_depth': after['relative_depth_p50'], 'before_boundary': before['boundary_error_image_height'],
                'after_boundary': after['boundary_error_image_height']}
    rows = [row(view) for view in comparison['views']] if comparison else []
    result = {}
    for key in ['before_iou', 'after_iou', 'before_depth', 'after_depth']:
        values = [r[key] for r in rows]
        # Do not silently omit a failed view with no depth overlap from its mean.
        result[key] = float(np.mean(values)) if values and all(v is not None for v in values) else None
    return dict(result, views=rows)


def legacy_snapshot(root, output, object_map):
    inventory_path = root / 'inventory/inventory.json'
    inventory = read(inventory_path)['objects']
    assessment, policies, scene = [read(root / name) for name in ['assessment.json', 'policies.json', 'scene.json']]
    cad_map_path, cad_image_path = root / 'inventory/floor_plan_map.json', root / 'inventory/floor_plan.png'
    cad_map = read(cad_map_path)
    assert cad_map['inventory_sha256'] == sha(inventory_path), 'Stale original CAD/inventory binding'
    assert cad_map['image_sha256'] == sha(cad_image_path), 'Stale original CAD image binding'
    assert Image.open(cad_image_path).size == (cad_map['width'], cad_map['height'])
    assets = output / 'report-assets'
    assets.mkdir(exist_ok=True)
    shutil.copyfile(cad_image_path, assets / 'legacy-floor-plan.png')
    shutil.copyfile(cad_map_path, assets / 'legacy-floor-plan-map.json')
    regions = [{'inv': o['inv'], 'polygon': o['polygon']} for o in cad_map['objects']]
    clipped = [o['inv'] for o in regions if any(not (0 <= x <= cad_map['width'] and 0 <= y <= cad_map['height']) for x, y in o['polygon'])]
    specs = {p['policy_id']: p for p in policies['specs']}
    findings, saved_policies = [], []
    fact_keys = ['fact_id', 'predicate', 'subject_id', 'object_id', 'value', 'unit', 'evidence_frame_ids']
    violation_keys = ['subject_id', 'object_id', 'measured', 'threshold', 'unit']
    for result in policies['results']:
        spec = specs[result['policy_id']]
        violations = [{k: v[k] for k in violation_keys} for v in result['violations']]
        pairs = {(v['subject_id'], v['object_id']) for v in violations}
        relevant = [f['fact_id'] for f in result['facts'] if (f['subject_id'], f['object_id']) in pairs]
        warnings = result.get('warnings', [])
        summary = (f"原报告保存 {len(violations)} 项违反记录、{len(warnings)} 项证据限制。" if violations
                   else '\n'.join(warnings) or '原报告保存的策略结果。')
        findings.append({'id': result['policy_id'], 'title': spec['source_text'], 'status': result['status'],
                         'summary': summary, 'evidence': {'frame_ids': result.get('evidence_frame_ids', []),
                         'fact_ids': relevant, 'url': 'report-assets/legacy-evidence.json'},
                         'metrics': {'predicate': spec['predicate'], 'threshold': spec['threshold'],
                                     'unit': spec['unit'], 'violation_count': len(violations), 'violations': violations}})
        saved_policies.append({'id': result['policy_id'], 'statement': spec['source_text'], 'status': result['status'],
                               'warnings': warnings, 'violations': violations,
                               'facts': [{k: f[k] for k in fact_keys} for f in result['facts']]})
    saved_assessment = {k: assessment[k] for k in ['status', 'fact_ids', 'evidence_frame_ids',
                        'approximate_distance_m', 'distance_error_budget_m', 'climb_review'] if k in assessment}
    evidence = {'source_run_id': root.name, 'notice': '历史原报告保存值；没有使用新三图重建重新裁决。',
                'assessment': saved_assessment, 'policies': saved_policies,
                'facts': [{k: f[k] for k in fact_keys} for f in scene['facts']],
                'entities': [{'id': e['entity_id'], 'label': e['label'], 'frame_ids': e['evidence_frame_ids']} for e in scene['entities']],
                'source_sha256': {name: sha(root / name) for name in ['assessment.json', 'policies.json', 'scene.json']}}
    write(assets / 'legacy-evidence.json', evidence)
    entries = []
    for inv, obj in enumerate(inventory):
        assert obj['inv'] == inv, 'Inventory array order changed'
        mapped = object_map.get(inv, [])
        entry = {'inv': inv, 'label': obj['label'], 'frame_id': obj['frame'],
                 'source': 'refinement' if obj.get('refine_slug') else 'detection',
                 'mapping_status': 'verified' if mapped else 'unmapped', 'mapped_object_ids': mapped,
                 'status': obj.get('status'), 'image_bbox': obj['image_bbox']}
        for key in ['score', 'height_m', 'size_m', 'camera_dist_m', 'orientation_deg', 'tilt_deg', 'outside_cell']:
            if key in obj:
                entry[key] = obj[key]
        entries.append(entry)
    review = read(root / 'review.json') if (root / 'review.json').exists() else None
    summary = {'status': assessment['status'], 'inventory_count': len(entries),
               'label_count': len({o['label'] for o in entries}), 'scale_source': scene['scale_source'],
               'scale_confidence': scene['scale_confidence'], 'review_status': review.get('status', 'recorded') if review else 'not_recorded'}
    legacy = {'source_run_id': root.name, 'summary': summary, 'findings': findings, 'inventory': entries,
              'evidence_url': 'report-assets/legacy-evidence.json',
              'cad': {'url': 'report-assets/legacy-floor-plan.png', 'width': cad_map['width'], 'height': cad_map['height'],
                      'regions': regions, 'map_url': 'report-assets/legacy-floor-plan-map.json',
                      'clip_to_image': True, 'clipped_inventory_indices': clipped}}
    scale = {'source': scene['scale_source'], 'factor': scene['scale_factor'], 'confidence': scene['scale_confidence'],
             'unit': 'm', 'description': '原报告模型估计尺度；不是新重建的物理标定。'}
    return legacy, scale


def build(root, legacy_root, output):
    # Reuse the existing read-only mask decoder; importing it makes no provider calls.
    sys.path.insert(0, str(legacy_root.parents[1]))
    from ehs_spatial.providers.sam3 import decode_coco_rle
    scene_path, binary_path = root / 'result/scene.json', root / 'result/scene.bin'
    scene, floor, evidence = [read(root / name) for name in ['result/scene.json', 'evidence/floor.json', 'evidence/objects.json']]
    manifest = read(root / 'blender-01/parameters.json')
    for name in ['result/scene.json', 'result/scene.bin', 'evidence/floor.json', 'evidence/objects.json']:
        assert sha(root / name) == manifest['source_files_sha256'][name], f'Frozen Blender source changed: {name}'
    transform = np.asarray(manifest['native_to_blender'], float)
    assert np.allclose(transform, floor_transform(floor), atol=2e-7, rtol=0), 'Floor convention differs from native Blender export'
    binary = binary_path.read_bytes()
    evidence = {o['object_id']: o for o in evidence['objects']}
    evidence['observed_floor'] = {'views': floor['views'], 'source_inventory_indices': []}
    old_inventory = read(legacy_root / 'inventory/inventory.json')['objects']
    frames = []
    for camera in scene['cameras']:
        url = f"images/{camera['id']}.png"
        source = root / f"geometry/frames/{camera['id']}/canonical.png"
        assert sha(output / url) == sha(source), 'Public photograph is not the canonical source'
        assert Image.open(source).size == (camera['width'], camera['height'])
        frames.append({'id': camera['id'], 'label': camera.get('label', camera['id']), 'url': url,
                       'width': camera['width'], 'height': camera['height']})
    objects, object_map, plane_points = [], {}, []
    for entry in scene['objects']:
        object_id, spec = entry['id'], entry['mesh']
        assert spec['stride'] == 9 and spec['index_type'] == 'uint32'
        assert spec['byte_offset'] % 4 == 0 and spec['index_byte_offset'] % 4 == 0
        vertices = np.frombuffer(binary, '<f4', spec['vertex_count'] * 9, spec['byte_offset']).reshape(-1, 9)
        indices = np.frombuffer(binary, '<u4', spec['index_count'], spec['index_byte_offset'])
        assert np.isfinite(vertices).all() and len(indices) % 3 == 0 and indices.max() < len(vertices)
        comparison = read(root / 'result' / entry['metrics']['comparison']) if entry['source'] == 'generated' else None
        native = np.asarray(comparison['final_object_to_world'], float) if comparison else np.eye(4)
        assert np.allclose(native, pose(entry['transform']), atol=1e-4, rtol=0), 'Source scene pose differs from scored pose'
        world_to_floor = transform @ native
        # Use every actual vertex, never object bounds or a repaired legacy fence hull.
        points = vertices[:, :3] @ world_to_floor[:3, :3].T + world_to_floor[:3, 3]
        hull = cv2.convexHull(points[:, :2].astype(np.float32)).reshape(-1, 2)
        moments = cv2.moments(hull)
        assert len(hull) >= 3 and moments['m00'] > 0
        center = [moments['m10'] / moments['m00'], moments['m01'] / moments['m00']]
        plane_points.extend(hull.tolist())
        views, verified = [], set()
        for view in evidence[object_id]['views']:
            if view['frame_id'] not in entry['frame_ids']:
                continue  # The observed floor mesh is sourced only from frame_0003.
            mask_path = root / view['canonical_mask_path']
            mask = np.load(mask_path, allow_pickle=False).astype(bool)
            camera = next(c for c in scene['cameras'] if c['id'] == view['frame_id'])
            assert mask.shape == (camera['height'], camera['width'])
            assert sha(mask_path) == view['sha256']['canonical_mask.npy'], 'Evidence mask changed'
            polygons, bbox = contours(mask)
            views.append({'frame_id': view['frame_id'], 'polygons': polygons, 'bbox': bbox, 'fill_rule': 'evenodd'})
            provenance = view['provenance']
            if 'source_inv' in provenance:
                inv = provenance['source_inv']
                old = old_inventory[inv]
                assert old['frame'] == provenance['source_frame'] and old['instance'] == provenance['source_instance']
                old_path = legacy_root / 'inventory/sam' / Path(provenance['source_path']).name
                assert sha(old_path) == provenance['source_sha256']
                old_mask = decode_coco_rle(read(old_path)['rle'][provenance['source_instance']], height=mask.shape[0], width=mask.shape[1]).astype(bool)
                assert np.array_equal(mask, old_mask), 'Legacy identity requires exact same-capture mask evidence'
                verified.add(inv)
        assert {v['frame_id'] for v in views} == set(entry['frame_ids'])
        assert verified == set(entry.get('source_inventory_indices', [])), 'Unproven legacy object mapping'
        for inv in verified:
            object_map.setdefault(inv, []).append(object_id)
        objects.append({'id': object_id, 'label': entry['label'], 'source': entry['source'],
                        'inventory_indices': sorted(verified), 'views': views,
                        'plan': {'hull': hull.astype(float).round(7).tolist(), 'center': np.round(center, 7).tolist(),
                                 'z_min': float(points[:, 2].min()), 'z_max': float(points[:, 2].max())},
                        'metrics': metrics(comparison)})
    cameras = []
    for camera in scene['cameras']:
        c2w = transform @ np.asarray(camera['camera_to_world'], float)
        forward = c2w[:2, 2]
        assert np.linalg.norm(forward) > 1e-8
        cameras.append({'id': camera['id'], 'position': c2w[:2, 3].tolist(),
                        'forward': (forward / np.linalg.norm(forward)).tolist()})
        plane_points.append(c2w[:2, 3].tolist())
    legacy, scale = legacy_snapshot(legacy_root, output, object_map)
    plane_points = np.asarray(plane_points)
    data = {'source_run_id': legacy_root.name, 'reconstruction_run_id': scene['run_id'], 'frames': frames, 'objects': objects,
            'plan': {'bounds': {'min': plane_points.min(0).tolist(), 'max': plane_points.max(0).tolist()},
                     'cameras': cameras, 'native_to_floor': transform.tolist(), 'unit': 'native relative units'},
            'legacy': legacy, 'scale': {'reconstruction': 'uncalibrated', 'legacy': scale},
            'mapping_notes': [
                '新照片、3D、CAD 投影和交互平面按相同 scene object id 联动。新俯视轮廓是全部实际网格顶点的凸包，孔洞和悬挑会被凸包覆盖，不代表地面接触面。',
                '只有 left_post→inv15/21、right_post→inv16/22、right_fence→inv13/19 经同次拍摄的 canonical mask 逐像素一致验证。其它旧库存没有对应生成对象。',
                '新 frame_0001 对应旧 frame_0003，新 frame_0003 对应旧 frame_0004；两个 run 的 frame id 命名空间不同。旧 frame_0001/2 不是这次相同机器人状态的照片。',
                '历史 assessment 和九条策略结果直接来自 user-bor1-02；未在新三图几何上重新运行。旧库存无逐条 policy status，不能从整体 FAIL 推给每个对象。',
                '旧 CAD 原始 map 的 inv8 有两个点超出图片左边界；坐标原样保留，显示时按图片边界裁切。',
                '新几何与旧 CAD 使用独立坐标和尺度；旧 moge_anchor 置信度不是实测准确率。新几何不标米，native_to_floor 只有刚体变换。',
                'mask polygon 为零基像素中心轮廓，最大简化偏移 0.5 像素；含内外环并按 evenodd 填充。bbox 使用右/下边界不包含的像素区间。',
                '指标为全部输入视图拟合结果；before_depth/after_depth 是各视图重叠区域相对深度中位误差的等权均值，不是毫米精度或留出测试。',
                'observed_floor 网格来自 frame_0003，只有该帧参与此对象照片联动；地面拟合本身还使用了 frame_0001 的观测点。'],
            'source_sha256': {'reconstruction_scene': sha(scene_path), 'reconstruction_binary': sha(binary_path),
                              'reconstruction_evidence': sha(root / 'evidence/objects.json'), 'legacy_inventory': sha(legacy_root / 'inventory/inventory.json')}}
    check(data, scene, output)
    write(output / 'unified-data.json', data)
    check(read(output / 'unified-data.json'), scene, output)
    print(f"PASS: {len(objects)} objects, {len(frames)} photos, {sum(len(o['views']) for o in objects)} mask views; "
          f"{len(legacy['inventory'])} legacy inventory entries, {len(legacy['cad']['regions'])} CAD regions, {len(legacy['findings'])} saved policies; "
          f"{len(object_map)} exact legacy mappings.")
    print(output / 'unified-data.json')


def check(data, scene, output):
    assert [o['id'] for o in data['objects']] == [o['id'] for o in scene['objects']]
    ids = {o['id'] for o in data['objects']}
    frames = {f['id']: f for f in data['frames']}
    for obj in data['objects']:
        for polygon in [obj['plan']['hull']] + [p for v in obj['views'] for p in v['polygons']]:
            points = np.asarray(polygon)
            assert points.ndim == 2 and points.shape[1] == 2 and len(points) >= 3 and np.isfinite(points).all()
        for view in obj['views']:
            frame = frames[view['frame_id']]
            assert 0 <= view['bbox'][0] < view['bbox'][2] <= frame['width']
            assert 0 <= view['bbox'][1] < view['bbox'][3] <= frame['height']
            assert all(0 <= x < frame['width'] and 0 <= y < frame['height'] for ring in view['polygons'] for x, y in ring)
        assert {v['frame_id'] for v in obj['metrics']['views']} <= {v['frame_id'] for v in obj['views']}
    legacy = data['legacy']
    for item in legacy['inventory']:
        assert set(item['mapped_object_ids']) <= ids
        for object_id in item['mapped_object_ids']:
            assert item['inv'] in next(o for o in data['objects'] if o['id'] == object_id)['inventory_indices']
    cad = legacy['cad']
    assert Image.open(output / cad['url']).size == (cad['width'], cad['height'])
    copied = read(output / cad['map_url'])
    assert copied['image_sha256'] == sha(output / cad['url'])
    assert len(cad['regions']) == len(copied['objects'])
    for region, original in zip(cad['regions'], copied['objects']):
        assert region == {'inv': original['inv'], 'polygon': original['polygon']}
        assert 0 <= region['inv'] < len(legacy['inventory'])
        points = np.asarray(region['polygon'])
        assert points.shape[1] == 2 and len(points) >= 3 and np.isfinite(points).all()
        assert points[:, 0].max() > 0 and points[:, 0].min() < cad['width']
        assert points[:, 1].max() > 0 and points[:, 1].min() < cad['height']
    assert cad['clip_to_image'] and cad['clipped_inventory_indices'] == [o['inv'] for o in cad['regions']
        if any(not (0 <= x <= cad['width'] and 0 <= y <= cad['height']) for x, y in o['polygon'])]


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1] / 'panoptes-serving/outputs/candidate-evaluation/lucida-replica-01')
    parser.add_argument('--legacy-root', type=Path, default=Path('/Users/adam/Desktop/Tesla/ehs-spatial/runs/user-bor1-02'))
    args = parser.parse_args()
    build(args.root.resolve(), args.legacy_root.resolve(), Path(__file__).resolve().parent)
