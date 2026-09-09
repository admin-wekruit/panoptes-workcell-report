// ponytail: fixed 20 MiB transport parts preserve every triangle; no streaming parser is needed for this one scene.
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
