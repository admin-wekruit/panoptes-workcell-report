"""Transfer SHA-bound same-capture masks into an existing native scene, without inference.

Use the adjacent panoptes-serving/.venv/bin/python. No source run or old asset is written.
Only manifest-declared full-image pixel-centre resampling is supported; unknown matches fail.
"""
import argparse
from collections import Counter
from copy import deepcopy
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys

import cv2
import numpy as np
from PIL import Image


def read(path):
    return json.loads(Path(path).read_text())


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write(path, record):
    text = json.dumps(record, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    assert not any(v in text for v in ['/Users/', '/private/', 'file://', 'access_token']), 'Private path in public data'
    Path(path).write_text(text)


def local(root, name):
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError('Source asset missing or outside declared root')
    return path


def verified(root, name, expected):
    path = local(root, name)
    if sha(path) != expected:
        raise ValueError('Source SHA mismatch: ' + name)
    return path


def resize_affine(old_wh, new_wh):
    scale = np.asarray(new_wh, float) / old_wh
    return np.array([[scale[0], 0, (scale[0]-1)/2], [0, scale[1], (scale[1]-1)/2], [0, 0, 1]])


def grid_affine(frame, original_wh, canonical_hw):
    rect = frame['content_rect_xyxy']
    h, w = canonical_hw
    if len(rect) != 4 or not all(type(v) is int for v in rect) or not 0 <= rect[0] < rect[2] <= w or not 0 <= rect[1] < rect[3] <= h:
        raise ValueError('Invalid content rectangle')
    expected = resize_affine(original_wh, [rect[2]-rect[0], rect[3]-rect[1]])
    expected[:2, 2] += rect[:2]
    actual = np.asarray(frame['input_to_canonical_pixel_centres'], float)
    if actual.shape != (3, 3) or not np.allclose(actual, expected, rtol=0, atol=1e-10):
        raise ValueError('Canonical affine disagrees with recorded pixel-centre resize and padding')
    return actual


def verify_match(source_root, target_root, source, target):
    match = target['existing_capture_match']
    if (match['frame_id'] != source['frame_id'] or match['sha256'] != source['source_sha256']
            or match.get('coordinate_relation') != 'full image bounds preserved; pixel-center resize'
            or match.get('manual_visual_confirmation') is not True
            or match['old_size'] != [source['width'], source['height']]
            or match['new_size'] != [target['width'], target['height']]):
        raise ValueError('Missing verified same-capture/full-image coordinate relation')
    source_image = verified(source_root, source['image_path'], source['source_sha256'])
    target_image = verified(target_root, target['input'], target['sha256'])
    if Image.open(source_image).size != tuple(match['old_size']) or Image.open(target_image).size != tuple(match['new_size']):
        raise ValueError('Decoded source image dimensions changed')
    verified(source_root, source['canonical_image_path'], source['canonical_sha256'])
    source_hw = [source['canonical_height'], source['canonical_width']]
    old = grid_affine(source, match['old_size'], source_hw)
    new = grid_affine(target, match['new_size'], target['canonical_shape_hw'])
    return new @ resize_affine(match['old_size'], match['new_size']) @ np.linalg.inv(old)


def transfer_mask(mask, resolution, source, target):
    """Keep a canonical mask canonical; original masks use the recorded two resize steps."""
    old_wh = [source['width'], source['height']]
    new_wh = [target['width'], target['height']]
    source_hw = [source['canonical_height'], source['canonical_width']]
    old = grid_affine(source, old_wh, source_hw)
    new = grid_affine(target, new_wh, target['canonical_shape_hw'])
    if resolution == 'original':
        if mask.shape != (old_wh[1], old_wh[0]):
            raise ValueError('Original mask grid mismatch')
        native = np.asarray(Image.fromarray(mask).resize(tuple(new_wh), Image.Resampling.NEAREST)).astype(bool)
        x0, y0, x1, y1 = target['content_rect_xyxy']
        canonical = np.zeros(target['canonical_shape_hw'], bool)
        canonical[y0:y1, x0:x1] = cv2.resize(native.astype(np.uint8), (x1-x0, y1-y0), interpolation=cv2.INTER_NEAREST_EXACT).astype(bool)
        return canonical, native
    if resolution != 'canonical' or mask.shape != tuple(source_hw):
        raise ValueError('Unknown source mask resolution')
    transform = new @ resize_affine(old_wh, new_wh) @ np.linalg.inv(old)
    yy, xx = np.indices(target['canonical_shape_hw'])
    xy = np.stack([xx, yy, np.ones_like(xx)], -1) @ np.linalg.inv(transform).T
    ix, iy = np.floor(xy[..., 0]+.5).astype(int), np.floor(xy[..., 1]+.5).astype(int)
    inside = (ix >= 0) & (iy >= 0) & (ix < mask.shape[1]) & (iy < mask.shape[0])
    canonical = np.zeros(target['canonical_shape_hw'], bool)
    canonical[inside] = mask[iy[inside], ix[inside]]
    return canonical, None


def polygons(mask):
    rings, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    approximated = [cv2.approxPolyDP(r, .5, True).reshape(-1, 2) for r in rings if cv2.contourArea(r) > 0]
    result = [p.tolist() for p in approximated if len(p) >= 3 and cv2.contourArea(p) > 0]
    y, x = np.nonzero(mask)
    return result, [int(x.min()), int(y.min()), int(x.max())+1, int(y.max())+1] if len(x) else None


def packed_asset(raw, path, output):
    packed = gzip.compress(raw, compresslevel=6, mtime=0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(packed)
    assert gzip.decompress(packed) == raw
    return {'path': path.relative_to(output).as_posix(), 'bytes': len(raw), 'packed_bytes': len(packed),
            'sha256': hashlib.sha256(raw).hexdigest()}


def build(source_root, target_root, scene_path, data_path, output, ehs_repo):
    source_root, target_root, scene_path, data_path, output, ehs_repo = [Path(p).resolve() for p in
        [source_root, target_root, scene_path, data_path, output, ehs_repo]]
    if output != scene_path.parent or scene_path.name == 'workcell-scene.json' or data_path.name == 'workcell-data.json':
        raise ValueError('Write a new sibling result with unchanged relative original assets')
    research = Path(__file__).resolve().parent.parent / 'panoptes-serving'
    sys.path[:0] = [str(ehs_repo), str(research / 'scripts/research')]
    from ehs_spatial.object_evidence import load_candidate_mask
    from ehs_spatial.measurements import measure_observed_points
    from assemble_lucida_scene import native_view, observed_mesh, mesh_bytes
    helper_spec = importlib.util.spec_from_file_location('unified_data_builder', Path(__file__).with_name('build-unified-data.py'))
    helper = importlib.util.module_from_spec(helper_spec); helper_spec.loader.exec_module(helper)

    registry = read(source_root / 'object-evidence.json')
    manifest, evidence, floor = [read(target_root / p) for p in ['manifest.json', 'evidence/objects.json', 'evidence/floor.json']]
    original, data = read(scene_path), deepcopy(read(data_path))
    assert original['source_run_id'] == manifest['experiment']
    source_binding = original['provenance']['observed_ranges']['source_sha256']
    for name in ['manifest.json', 'evidence/objects.json', 'evidence/floor.json']:
        verified(target_root, name, source_binding[name])
    assert manifest['geometry']['model'] == 'Pi3X' and manifest['geometry']['metric_scale_known'] is False
    assert evidence['coordinate_system'] == 'new joint Pi3X native OpenCV world'
    plane = np.asarray(floor['plane_native'], float)
    up = plane[:3] / np.linalg.norm(plane[:3])
    assert np.allclose(up, original['up'], atol=1e-6)
    to_floor = np.asarray(data['plan']['native_to_floor'], float)
    assert np.allclose(helper.floor_transform(floor), to_floor, atol=2e-7, rtol=0)
    assert {o['id'] for o in data['objects']} == {o['id'] for o in original['objects']}
    scene = deepcopy(original)
    assets = output / 'workcell-assets'; assets.mkdir(exist_ok=True)
    source_frames = {f['frame_id']: f for f in registry['frames']}
    target_frames = {f['frame_id']: f for f in manifest['frames']}
    geometry = {f['frame_id']: f['files'] for f in manifest['geometry']['frames']}
    mappings, views, exclusions, mesh_shas = {}, {}, {}, {}
    for obj in original['objects']:
        asset = obj['mesh']['asset']; path = local(output, asset['path'])
        raw = gzip.decompress(path.read_bytes())
        assert hashlib.sha256(raw).hexdigest() == asset['sha256'] and len(raw) == asset['bytes']
        mesh_shas[asset['path']] = sha(path)
        layout = obj['mesh']
        vertices = np.frombuffer(raw, '<f4', layout['vertex_count']*9, layout['byte_offset']).reshape(-1, 9)
        pose = to_floor @ helper.pose(obj['transform'])
        floor_points = vertices[:, :3] @ pose[:3, :3].T + pose[:3, 3]
        hull = cv2.convexHull(floor_points[:, :2].astype(np.float32)).reshape(-1, 2)
        moments = cv2.moments(hull)
        assert len(hull) >= 3 and moments['m00'] > 0
        entry = next(o for o in data['objects'] if o['id'] == obj['id'])
        entry['source'] = obj['source']
        entry['plan'] = {'hull': hull.tolist(), 'center': [moments['m10']/moments['m00'], moments['m01']/moments['m00']],
                         'z_min': float(floor_points[:, 2].min()), 'z_max': float(floor_points[:, 2].max())}
        if obj['source'] == 'parametric':
            entry['metrics_source'] = 'Frozen original RecGen experiment; not metrics for the current Blender cylinder'
    for camera in scene['cameras']:
        fid = camera['id']; frame = target_frames[fid]
        verified(target_root, frame['input'], frame['sha256'])
        for filename, expected in geometry[fid].items():
            verified(target_root, f'geometry/frames/{fid}/{filename}', expected)
        assert sha(local(output, camera['image'])) == frame['canonical_sha256']
        spec = dict(frame_id=fid, canonical_rgb_path=f'geometry/frames/{fid}/canonical.png',
            pointmap_path=f'geometry/frames/{fid}/pts3d.npy', K_path=f'geometry/frames/{fid}/intrinsics.npy',
            c2w_path=f'geometry/frames/{fid}/camera_to_world.npy', valid_path=f'geometry/frames/{fid}/valid_mask.npy',
            content_valid_path=f'geometry/frames/{fid}/content_valid_mask.npy', conf_path=f'geometry/frames/{fid}/conf.npy')
        view = native_view(target_root, spec); views[fid] = view
        assert np.allclose(view['K'], camera['K'], atol=1e-6, rtol=0)
        assert np.allclose(view['c2w'], camera['camera_to_world'], atol=1e-6, rtol=0)
        A = grid_affine(frame, [frame['width'], frame['height']], frame['canonical_shape_hw'])
        photo = assets / (fid + '-original' + Path(frame['input']).suffix.lower())
        shutil.copyfile(target_root / frame['input'], photo)
        camera.update(original_image=photo.relative_to(output).as_posix(), original_width=frame['width'],
            original_height=frame['height'], original_K=(np.linalg.inv(A) @ view['K']).tolist(),
            input_to_canonical_pixel_centres=A.tolist())
        assert np.allclose(A @ camera['original_K'], camera['K'], rtol=0, atol=1e-10)
        exclusions[fid] = np.zeros(view['valid'].shape, bool)
        match = frame.get('existing_capture_match')
        if match:
            source = source_frames[match['frame_id']]
            affine = verify_match(source_root, target_root, source, frame)
            if source['frame_id'] in mappings:
                raise ValueError('Ambiguous source capture mapping')
            mappings[source['frame_id']] = {'target_frame_id': fid, 'source_image_sha256': source['source_sha256'],
                'target_image_sha256': frame['sha256'], 'source_canonical_to_target_canonical': affine.tolist(),
                'original_to_original': resize_affine([source['width'], source['height']], [frame['width'], frame['height']]).tolist(),
                'method': match['coordinate_relation'], 'assumption': match['status']}

    records = {o['object_id']: o for o in evidence['objects']}
    floor_ids = {Path(v['canonical_mask_path']).parts[-3] for v in floor['views']}
    assert len(floor_ids) == 1
    records[next(iter(floor_ids))] = {'views': floor['views']}
    for obj in original['objects']:
        record = records[obj['id']]
        for spec in record['views']:
            fid = spec['frame_id']
            if fid not in obj['frame_ids']:
                continue
            path = verified(target_root, spec['canonical_mask_path'], spec['sha256']['canonical_mask.npy'])
            mask = np.load(path, allow_pickle=False).astype(bool)
            assert mask.shape == exclusions[fid].shape
            exclusions[fid] |= mask

    transferred, omitted = [], []
    for candidate in registry['candidates']:
        sfid = candidate.get('frame_id')
        if sfid not in mappings:
            omitted.append({'id': candidate['id'], 'source_frame_id': sfid,
                            'reason': 'No manifest-verified same-capture target frame'})
            continue
        fid = mappings[sfid]['target_frame_id']; frame = target_frames[fid]
        item = {'candidate': candidate, 'frame_id': fid, 'source_frame_id': sfid, 'mask': None, 'reason': None}
        if candidate['mask']['status'] == 'available':
            raw_mask = load_candidate_mask(source_root, candidate)
            canonical, native = transfer_mask(raw_mask, candidate['mask']['resolution'], source_frames[sfid], frame)
            item.update(mask=canonical, native=native)
        else:
            item['reason'] = candidate['mask'].get('reason') or 'Source mask unavailable'
        transferred.append(item)

    contexts = {}
    for sfid, mapping in mappings.items():
        fid = mapping['target_frame_id']; view = views[fid]
        union = np.zeros(view['valid'].shape, bool)
        for item in transferred:
            if item['frame_id'] == fid and item['mask'] is not None:
                union |= item['mask']
        keep = union & ~exclusions[fid]
        try:
            mesh, pixel_faces = observed_mesh(dict(view, mask=keep), return_pixel_faces=True)
        except ValueError as error:
            contexts[fid] = {'reason': str(error), 'pixel_faces': np.empty((0, 3), int)}
            continue
        context_id = 'supplemental_context_' + fid
        raw, layout = mesh_bytes(mesh)
        layout['bounds'] = {'min': mesh.vertices.min(0).tolist(), 'max': mesh.vertices.max(0).tolist()}
        layout['asset'] = packed_asset(raw, assets / (context_id + '.bin.gz'), output)
        scene['objects'].append({'id': context_id, 'label': '同源照片补充观测区域', 'source': 'observed',
            'role': 'context', 'supplemental': True, 'selectable': False, 'editable': False,
            'model': manifest['geometry']['model'], 'frame_ids': [fid],
            'transform': {'position': [0, 0, 0], 'rotation_deg': [0, 0, 0], 'scale': [1, 1, 1]}, 'mesh': layout,
            'provenance': {'method': 'Source-mask union minus exact existing asset evidence; native point-map triangulation',
                'target_frame_id': fid, 'supported_pixels': int((keep & view['valid']).sum()),
                'excluded_asset_pixels': int(exclusions[fid].sum()), 'metric_scale_known': False}})
        contexts[fid] = {'id': context_id, 'pixel_faces': pixel_faces}
        next(c for c in scene['cameras'] if c['id'] == fid)['context_id'] = context_id

    regions, unavailable, audit_records = [], [], []
    for obj in data['objects']:
        obj['scene_object_id'] = obj['id']
    for item in transferred:
        candidate, fid, sfid, mask = [item[k] for k in ['candidate', 'frame_id', 'source_frame_id', 'mask']]
        oid = candidate['id']; assert oid not in {o['id'] for o in original['objects']}
        source_record = {'source_run_id': registry['run_id'], 'candidate_id': oid, 'source_frame_id': sfid,
            'target_run_id': manifest['experiment'], 'target_frame_id': fid, 'source_mask': candidate['mask'],
            'source_refs': candidate['source_refs'], 'capture_mapping': mappings[sfid],
            'identity': 'One source-frame observation; labels and cross-view physical identities are not merged'}
        region = {'id': oid, 'label': candidate['label'], 'labels': candidate.get('labels', []),
            'reference_frame': fid, 'frame_ids': [fid], 'source': 'observed', 'source_inventory_indices': [],
            'editable': False, 'selectable': True, 'context_id': contexts[fid].get('id'),
            'source_bbox': {'bbox_xyxy': candidate['mask'].get('bbox'), 'resolution': candidate['mask'].get('resolution'),
                            'shape_hw': candidate['mask'].get('shape_hw')},
            'provenance': {'source_run_id': registry['run_id'], 'candidate_id': oid,
                'source_image_sha256': target_frames[fid]['sha256'], 'mask_sha256': candidate['mask'].get('sha256'),
                'physical_identity': source_record['identity'], 'metric_scale_known': False, 'source_record': source_record}}
        photo_polygons, bbox = polygons(mask) if mask is not None else ([], None)
        region.update(photo_polygons=photo_polygons, photo_width=views[fid]['valid'].shape[1], photo_height=views[fid]['valid'].shape[0])
        points = views[fid]['points'][mask & views[fid]['valid']] if mask is not None else np.empty((0, 3))
        region['measurements'] = measure_observed_points(points, {'floor_plane': plane.tolist(), 'scale_source': 'model_native'},
            mask_pixels=int(mask.sum()) if mask is not None else 0, source={'candidate_id': oid, 'frame_id': fid,
                'scene_sha256': sha(target_root / 'evidence/floor.json'), 'image_sha256': target_frames[fid]['sha256'],
                'mask_sha256': candidate['mask'].get('sha256'), 'pointmap_sha256': geometry[fid]['pts3d.npy']})
        region['provenance']['supported_points'] = len(points)
        plan, native_triangles, residual_triangles, reason = None, 0, 0, item['reason']
        if mask is not None:
            path = assets / (oid + '.mask.png'); Image.fromarray(mask.astype(np.uint8)*255).save(path)
            region['mask'] = {'path': path.relative_to(output).as_posix(), 'sha256': sha(path), 'pixels': int(mask.sum()),
                              'bbox_xyxy': bbox, 'shape_hw': list(mask.shape), 'resolution': 'canonical'}
            if item['native'] is not None:
                path = assets / (oid + '.original-mask.png'); Image.fromarray(item['native'].astype(np.uint8)*255).save(path)
                source_record['transferred_original_mask'] = {'path': path.relative_to(output).as_posix(), 'sha256': sha(path),
                    'shape_hw': list(item['native'].shape), 'note': 'Nearest-neighbour same-capture resize; not a new segmentation'}
        try:
            if reason:
                raise ValueError(reason)
            if len(points) < 8:
                raise ValueError('Fewer than eight valid target-native depth points')
            native_triangles = len(observed_mesh(dict(views[fid], mask=mask)).faces)
            if not contexts[fid].get('id'):
                raise ValueError('No supplementary surface for this frame: ' + contexts[fid]['reason'])
            region['bounds_native'] = {'min': points.min(0).tolist(), 'max': points.max(0).tolist()}
            heights = points @ up
            region['ground_extent_native'] = {'min': float(heights.min()), 'max': float(heights.max())}
            faces = np.flatnonzero(mask.ravel()[contexts[fid]['pixel_faces']].all(1)).astype('<u4')
            residual_triangles = len(faces)
            if len(faces):
                region.update(surface_status='observed', faces={'count': len(faces), 'encoding': 'uint32-triangle-indices',
                    'asset': packed_asset(faces.tobytes(), assets / (oid + '.faces.bin.gz'), output)})
            else:
                if not (mask & exclusions[fid]).any():
                    raise ValueError('No observed triangles remain in supplementary context')
                reason = 'Native connected surface is covered by existing asset masks; evidence bounds retained without inferred identity'
                region.update(faces=None, surface_status='covered_by_generated', reason=reason)
            floor_points = points @ to_floor[:3, :3].T + to_floor[:3, 3]
            hull = cv2.convexHull(floor_points[:, :2].astype(np.float32)).reshape(-1, 2)
            moments = cv2.moments(hull)
            if len(hull) >= 3 and moments['m00'] > 0:
                plan = {'hull': hull.tolist(), 'center': [moments['m10']/moments['m00'], moments['m01']/moments['m00']],
                        'z_min': float(floor_points[:, 2].min()), 'z_max': float(floor_points[:, 2].max())}
            regions.append(region)
        except ValueError as error:
            reason = str(error)
            region.update(selectable=False, status='unavailable', reason=reason)
            unavailable.append(region)
        ready = region.get('status') != 'unavailable'
        data['objects'].append({'id': oid, 'label': candidate['label'], 'source': 'observed', 'inventory_indices': [],
            'views': [{'frame_id': fid, 'polygons': photo_polygons, 'bbox': bbox, 'fill_rule': 'evenodd'}],
            'plan': plan, 'metrics': None, 'scene_object_id': oid if ready else None,
            'spatial': {'status': 'ready' if ready else 'unavailable', 'reason': reason},
            'generation': {'status': 'not_generated', 'reason': 'Observed target geometry only; no model generation requested'},
            'source_record': source_record})
        audit_records.append({'id': oid, 'source_frame_id': sfid, 'target_frame_id': fid,
            'source_resolution': candidate['mask'].get('resolution'), 'target_mask_pixels': int(mask.sum()) if mask is not None else 0,
            'target_supported_points': len(points), 'native_triangles': native_triangles,
            'supplementary_triangles': residual_triangles, 'status': 'ready' if ready else 'unavailable', 'reason': reason})

    scene['run_id'] = manifest['experiment'] + '-same-capture-workcell'
    scene['label'] = '完整工位 · 模型与同源观测范围'
    scene['description'] = '保留原完整模型；补充经照片 SHA 与像素映射验证的逐帧观测。相同标签不是相同实物，未完成背面，不推断不可见对象。'
    scene['observed_regions'], scene['unavailable_regions'] = regions, unavailable
    scene['observed_regions_summary'] = {'registry_candidates': len(transferred), 'generated_exact_candidates': 0,
        'observed_regions': len(regions), 'unavailable_regions': len(unavailable),
        'regions_with_surface': sum(r['faces'] is not None for r in regions),
        'regions_with_bounds_only': sum(r['faces'] is None for r in regions), 'contexts': len(contexts)}
    scene['provenance']['source_bridge'] = {'source_registry_sha256': sha(source_root / 'object-evidence.json'),
        'target_manifest_sha256': sha(target_root / 'manifest.json'), 'base_scene_sha256': sha(scene_path),
        'coordinate_system': evidence['coordinate_system'], 'registration': 'Identity in target Pi3X; source 3D never used',
        'audit': 'workcell-assets/bridge-audit.json', 'new_model_calls': 0}
    bound_points = [np.asarray([original['bounds']['min'], original['bounds']['max']])]
    bound_points += [np.asarray([r['bounds_native']['min'], r['bounds_native']['max']]) for r in regions]
    points = np.concatenate(bound_points)
    scene['bounds'] = {'min': points.min(0).tolist(), 'max': points.max(0).tolist()}
    data.update(scene_url='workcell-scene.json', reconstruction_run_id=scene['run_id'])
    plan_points = np.concatenate([np.asarray(o['plan']['hull']) for o in data['objects'] if o['plan']] +
                                [np.asarray([c['position'] for c in data['plan']['cameras']])])
    data['plan']['bounds'] = {'min': plan_points.min(0).tolist(), 'max': plan_points.max(0).tolist()}
    data['mapping_notes'] += ['补充条目仅是同次拍摄的独立实例观测；保留原候选 ID，不跨帧/按标签合并实物。旧库存索引未迁移。',
        '仅迁移 manifest 验证的同拍摄帧：' + '、'.join(s+'→'+m['target_frame_id'] for s,m in mappings.items()) +
        '；无匹配的目标帧没有完整实例清单，未映射来源详见覆盖审计。',
        '补充几何只来自本次 Pi3X 点图，不移用旧 MapAnything 的位姿、尺度或模型。来源原图 mask 经两次记录的最近邻缩放；canonical mask 不伪装为原图精度。',
        '补充平面轮廓为有效观测点的凸包，H/W/D 为可见范围，未标定为米；原生成模型指标完全未变。']
    audit = {'source_run_id': registry['run_id'], 'target_run_id': manifest['experiment'],
        'source_candidates': len(registry['candidates']), 'mapped_candidates': len(transferred),
        'ready': len(regions), 'unavailable': len(unavailable), 'omitted_candidates': omitted,
        'source_frame_counts': dict(Counter(c.get('frame_id') for c in registry['candidates'])),
        'mapped_source_frames': mappings, 'target_frames_without_registry': sorted(set(target_frames)-{m['target_frame_id'] for m in mappings.values()}),
        'records': audit_records, 'original_mesh_sha256': mesh_shas,
        'new_context_packed_bytes': sum(o['mesh']['asset']['packed_bytes'] for o in scene['objects'] if o.get('supplemental')),
        'new_model_calls': 0, 'source_sha256': scene['provenance']['source_bridge']}
    assert len(regions)+len(unavailable)+len(omitted) == len(registry['candidates'])
    assert len({o['id'] for o in data['objects']}) == len(data['objects'])
    assert scene['objects'][:len(original['objects'])] == original['objects']
    assert mesh_shas == {name: sha(output / name) for name in mesh_shas}
    write(assets / 'bridge-audit.json', audit)
    write(output / 'workcell-scene.json', scene)
    write(output / 'workcell-data.json', data)
    print(json.dumps({k: audit[k] for k in ['source_candidates', 'mapped_candidates', 'ready', 'unavailable', 'new_context_packed_bytes', 'new_model_calls']}), flush=True)
    return audit


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['source-run', 'target-run', 'scene', 'data', 'ehs-repo']:
        parser.add_argument('--'+name, type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    build(args.source_run, args.target_run, args.scene, args.data, args.output, args.ehs_repo)
