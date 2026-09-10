# Panoptes unified workcell report

The [published website](https://admin-wekruit.github.io/panoptes-workcell-report/) includes the [report workspace](https://admin-wekruit.github.io/panoptes-workcell-report/reports.html): real report history, photo upload, object evidence, Agent corrections, and interactive scenes. `reports.html?run=<run_id>` opens a saved report. These pages stay on the website; the Modal backend supplies authenticated APIs and report assets. Private reports require workspace access, including their images, models and metrics. `report-artifact.html` displays those metrics on the same website.

The experiment gallery retains the public inspection snapshot from `user-bor1-02`, linked reconstruction from `lucida-replica-01`, and the Blender parameter fitting trial. It is separate from newly uploaded reports and their saved history.

Open `index.html` through an HTTP server for four interactive playgrounds (generated object scene, earlier observed internal surface GLB, complete Blender workcell with source ranges, and workcell objects and bounds) followed by the four linked views: photo masks, full 3D, CAD-style mesh projection, and interactive plan. `viewer.html` retains the independent scene editor; `metrics.html` contains all nine object comparison tables. The main views share reconstruction object IDs and coordinates. Original inventory/CAD records are linked only where same-photo masks prove correspondence (six records for three scene objects). Original findings have not been recomputed against new or edited geometry. Plan outlines are projected convex hulls, not measured CAD.

The [complete Blender playground](https://admin-wekruit.github.io/panoptes-workcell-report/viewer.html?scene=blender-ranges-scene.json) uses `blender-ranges-scene.json`: all 10 scene objects remain, with the two posts replaced by the existing fitted Blender cylinders. Each object's observed range and height/width/depth come from its matching **three-photo Pi3X** masks, point maps and cameras. This derived scene adds no inference or pose fitting and retains the original generated assets and comparison results. `blender/workcell.blend` is the Blender source; cylinder comparisons remain in `blender/post-comparisons.json`. The cylinders are explicit shape priors without footplates.

Object links open the source photograph with the selected mesh, bounding box and XYZ axes projected through its recorded camera. Photo mode locks camera navigation to retain alignment. The separate `components/scene.json` workcell playground uses the earlier **four-photo MapAnything** evidence, not the Pi3X/Blender coordinate system. It opens the full workcell in 3D from its source-camera viewpoint with object bounds visible. It contains two generated assets and 79 selectable, read-only source-frame observations; overlapping masks are retained, so these are not 79 distinct physical objects. The four camera contexts stay separate. Regions share actual observed triangles instead of duplicating meshes; one covered region retains its supported-point bounds without a separate surface. Three records with insufficient source geometry remain listed with reasons. Bounds describe observed extent, not safety or motion zones; axes use the native scene coordinates, not inferred object orientation. Full-photo intrinsics undo the recorded resize/crop affine; canonical camera fields and existing comparison metrics are preserved. Unseen surfaces remain absent from the observed context.

Source measurements describe visible supported points in the saved floor basis, not complete physical dimensions. Slope and principal-axis estimates appear only when their geometry checks pass. The Pi3X/Blender scene is uncalibrated; the older MapAnything scene's MoGe scale is estimated, not physically calibrated. These measurements are not interchangeable. Editing a generated model changes its displayed model dimensions, not its immutable source observation.

The original RecGen scene geometry is transported as independently verified gzip objects and rendered as each object arrives. Its download size is 38,586,136 bytes; all 71,788,320 original geometry bytes are preserved. The original GLB download remains separate.

The three-photo RecGen experiment is not a completed Lucida reproduction. Its geometry uses uncalibrated units. All input views participated in fitting; comparison scores are input-view consistency, not held-out reconstruction accuracy. RecGen code and weights are restricted to noncommercial use. The editable scenes do not supply joints, collision behavior or physical calibration.

Generated mesh data, source photographs, before/after measurements and diagnostic images retain their original run hashes; browser edits are local and can be exported as JSON.

## Website source and export

The report workspace source is `ehs-spatial/ehs_spatial/static/`. From the EHS checkout, export it into this repository with:

```sh
.venv/bin/python scripts/export_report_website.py /path/to/panoptes-workcell-pages \
  --api-origin https://wekruit-livekit-agents--panoptes-report-workspace-web.modal.run \
  --site-root https://admin-wekruit.github.io/panoptes-workcell-report/
```

This writes `reports.html`, `workspace-assets/`, and the shared `site-config.js`/`site-client.js` transport. It does not run models or rebuild frozen experiment assets. `build-blender-playground.py` assembles the existing cylinder trial; `build-blender-ranges.py` adds the same-source Pi3X measurements using the command in its module docstring.

## Loading regression check

Run `node check-viewer-client.cjs` for authenticated cross-origin model/photo loading, late-photo isolation, and all 10 Blender objects' source ranges, measurements and editable-model separation in Chromium and WebKit. Its Playwright import points to the installed local runtime.

From the EHS checkout, run `NODE_PATH=/path/to/node_modules SITE_CLIENT_BROWSERS=chromium,webkit node tests/check_site_client.cjs` for scoped credentials, private metric images/downloads, historical scene links, stale iframe cleanup, and deferring offscreen legacy geometry until visible. Run `NODE_PATH=/path/to/node_modules node tests/check_workspace_site.cjs` for the report/history/upload/Agent interface under the website path. Both use fixture APIs and make no provider calls.

Run `node check-unified-report.cjs /path/to/installed/playwright` for linked report interactions, original-record mappings, and mobile layout. Run `node check-viewer-bridge.cjs /path/to/installed/playwright` for embedded viewer message validation and partial loading.

Run `node check-mobile.cjs /path/to/installed/playwright` with its WebKit browser available. Use `MODEL_MBPS=10` to simulate a 10 Mbps asset link. This checks partial-load interaction, completion, corrupt data and graphics-context loss at phone viewport size.

Run `node check-viewer-target.cjs http://127.0.0.1:8892/` to check original-photo loading before model download, camera projection, photo picking, phone resizing, and the explicit free-3D mode in Chromium and WebKit.

Run `REGIONS_SCENE=components/scene.json node check-observed-regions.cjs http://127.0.0.1:8892/` for overlapping region selection, bounds-only evidence, read-only editing routes, frame isolation, original-photo and 3D interaction.

Run `python3 pack-model.py /path/to/immutable/run/result` to regenerate the lossless per-object assets; it verifies the concatenated object bytes exactly match the original binary.

From the parent workspace, run `panoptes-serving/.venv/bin/python panoptes-workcell-pages/build-unified-data.py` to rebuild the frozen report data from the existing local runs. This checks source hashes, mask correspondence, and the Blender floor transform; it performs no model inference.

Run `node check-playgrounds.cjs /path/to/installed/playwright` to verify all playgrounds load their real geometry and release the previous scene on switching. `observed/check-observed.cjs` checks the original surface viewer controls.
