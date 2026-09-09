# Panoptes unified workcell report

Public inspection snapshot from `user-bor1-02`, linked reconstruction from `lucida-replica-01`, and the Blender parameter fitting trial.

Open `index.html` through an HTTP server for four interactive playgrounds (generated object scene, earlier observed internal surface GLB, actual Blender cylinder trial, and small-object reconstruction) followed by the four linked views: photo masks, full 3D, CAD-style mesh projection, and interactive plan. `viewer.html` retains the independent scene editor; `metrics.html` contains all nine object comparison tables. The main views share reconstruction object IDs and coordinates. Original inventory/CAD records are linked only where same-photo masks prove correspondence (six records for three scene objects). Original findings have not been recomputed against new or edited geometry. Plan outlines are projected convex hulls, not measured CAD.

Object links open the source photograph with the selected mesh, bounding box and XYZ axes projected through its recorded camera. Photo mode locks camera navigation to retain alignment. Free 3D is an explicit mode; small-object results include a read-only observed workcell surface from their native anchor frame, excluding the generated-object masks. Full-photo intrinsics undo the recorded resize/crop affine; canonical camera fields and existing comparison metrics are preserved. Unseen surfaces remain absent from the observed context.

Full original geometry is transported as independently verified gzip objects and rendered as each object arrives. Download size is 38,586,136 bytes; all 71,788,320 original geometry bytes are preserved. The original GLB download remains separate.

This is a RecGen experiment using three photos, not a completed Lucida reproduction. Geometry uses uncalibrated units. All input views participated in fitting. RecGen code and weights are restricted to noncommercial use.

Generated mesh data, source photographs, before/after measurements and diagnostic images retain their original run hashes; browser edits are local and can be exported as JSON.

## Loading regression check

Run `node check-unified-report.cjs /path/to/installed/playwright` for linked report interactions, original-record mappings, and mobile layout. Run `node check-viewer-bridge.cjs /path/to/installed/playwright` for embedded viewer message validation and partial loading.

Run `node check-mobile.cjs /path/to/installed/playwright` with its WebKit browser available. Use `MODEL_MBPS=10` to simulate a 10 Mbps asset link. This checks partial-load interaction, completion, corrupt data and graphics-context loss at phone viewport size.

Run `node check-viewer-target.cjs http://127.0.0.1:8892/` to check original-photo loading before model download, camera projection, photo picking, phone resizing, and the explicit free-3D mode in Chromium and WebKit.

Run `python3 pack-model.py /path/to/immutable/run/result` to regenerate the lossless per-object assets; it verifies the concatenated object bytes exactly match the original binary.

From the parent workspace, run `panoptes-serving/.venv/bin/python panoptes-workcell-pages/build-unified-data.py` to rebuild the frozen report data from the existing local runs. This checks source hashes, mask correspondence, and the Blender floor transform; it performs no model inference.

Run `node check-playgrounds.cjs /path/to/installed/playwright` to verify all playgrounds load their real geometry and release the previous scene on switching. `observed/check-observed.cjs` checks the original surface viewer controls.
