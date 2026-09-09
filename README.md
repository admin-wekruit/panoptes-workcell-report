# Panoptes workcell experiment

Public report and editable static scene from run `lucida-replica-01`.

Open `index.html` through an HTTP server. `metrics.html` contains all nine object comparison tables. Full original geometry is transported as independently verified gzip objects and rendered as each object arrives. Download size is 38,586,136 bytes; all 71,788,320 original geometry bytes are preserved. The original GLB download remains separate.

This is a RecGen experiment using three photos, not a completed Lucida reproduction. Geometry uses uncalibrated units. All input views participated in fitting. RecGen code and weights are restricted to noncommercial use.

Generated mesh data, source photographs, before/after measurements and diagnostic images retain their original run hashes; browser edits are local and can be exported as JSON.

## Loading regression check

Run `node check-mobile.cjs /path/to/installed/playwright` with its WebKit browser available. Use `MODEL_MBPS=10` to simulate a 10 Mbps asset link. This checks partial-load interaction, completion, corrupt data and graphics-context loss at phone viewport size.

Run `python3 pack-model.py /path/to/immutable/run/result` to regenerate the lossless per-object assets; it verifies the concatenated object bytes exactly match the original binary.
