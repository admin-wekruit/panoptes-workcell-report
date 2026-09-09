// Decode one losslessly compressed, independently verified object at a time.
async function loadMesh(asset, base, onProgress) {
  if (!asset || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > 32 * 1024 * 1024 || !Number.isSafeInteger(asset.packed_bytes) || asset.packed_bytes <= 0 || asset.packed_bytes > 32 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw Error('无效对象文件记录');
  if (typeof DecompressionStream !== 'function') throw Error('此浏览器版本不支持模型解压，请更新浏览器后打开');
  const controller = new AbortController();
  let timer, packed = 0, decoded = 0;
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), 30000); };
  try {
    touch();
    const response = await fetch(localAsset(asset.path, base), {signal: controller.signal});
    if (!response.ok) throw Error('对象下载失败：HTTP ' + response.status);
    const measured = response.body.pipeThrough(new TransformStream({transform(chunk, stream) {
      touch(); packed += chunk.byteLength;
      if (packed > asset.packed_bytes) throw Error('对象压缩文件大小不匹配');
      onProgress(packed); stream.enqueue(chunk);
    }}));
    const reader = measured.pipeThrough(new DecompressionStream('gzip')).getReader();
    const result = new Uint8Array(asset.bytes);
    try {
      for (;;) {
        const {done, value} = await reader.read(); if (done) break;
        if (decoded + value.byteLength > result.length) throw Error('对象解压大小超出记录');
        result.set(value, decoded); decoded += value.byteLength;
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (packed !== asset.packed_bytes || decoded !== asset.bytes) throw Error('对象文件不完整');
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', result)), b => b.toString(16).padStart(2, '0')).join('');
    if (digest !== asset.sha256) throw Error('对象完整性校验失败');
    return result.buffer;
  } catch (error) {
    controller.abort();
    if (error.name === 'AbortError') throw Error('下载连续 30 秒没有进展，请检查网络后重新加载');
    throw error;
  } finally { clearTimeout(timer); }
}

// The original GLB is downloaded only on request, independently of scene rendering.
async function loadParts(asset, base) {
  if (!asset || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > 200 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Array.isArray(asset.parts) || !asset.parts.length || asset.parts.length > 20) throw Error('无效模型文件记录');
  const buffers = await Promise.all(asset.parts.map(async part => {
    if (!part || !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || part.bytes > 20 * 1024 * 1024) throw Error('无效模型分段');
    const response = await fetch(localAsset(part.path, base));
    if (!response.ok) throw Error('模型加载失败：' + response.status);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== part.bytes) throw Error('模型文件不完整，请刷新重试');
    return new Uint8Array(buffer);
  }));
  if (buffers.reduce((n, b) => n + b.length, 0) !== asset.bytes) throw Error('模型文件大小不匹配');
  const result = new Uint8Array(asset.bytes);
  let offset = 0;
  for (const buffer of buffers) { result.set(buffer, offset); offset += buffer.length; }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', result)), b => b.toString(16).padStart(2, '0')).join('');
  if (digest !== asset.sha256) throw Error('模型完整性校验失败');
  return result.buffer;
}
async function downloadGlb(asset, base, button) {
  button.disabled = true;
  button.textContent = '准备完整 GLB…';
  try {
    const bytes = await loadParts(asset, base);
    const url = URL.createObjectURL(new Blob([bytes], {type: 'model/gltf-binary'}));
    const link = document.createElement('a'); link.href = url; link.download = 'panoptes-workcell.glb'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { status(error.message, true); }
  finally { button.disabled = false; button.textContent = '下载原始 GLB'; }
}
