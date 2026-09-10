'use strict';
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=value=>Number.isFinite(value)?(value*100).toFixed(2)+'%':'—';
const shortNames={left_post:'左防撞柱',right_post:'右防撞柱',right_fence:'右围栏',robot:'工业机器人',left_fence:'左围栏',cart:'料车',guard:'黄黑护罩',left_light_curtain:'左光幕',right_light_curtain:'右光幕',observed_floor:'观测地面'};
const name=o=>shortNames[o.id]||o.label;
const state={data:null,selected:'left_post',frame:'frame_0003',viewerReady:false,legacyInv:null,zoom:1,pan:[0,0]};
const objects=()=>state.data.objects;
const current=()=>objects().find(o=>o.id===state.selected);
const send=message=>$('model-viewer').contentWindow.postMessage(message,location.origin);
const selectionMessage=()=>send({type:'panoptes:select',objectId:state.selected});
const cameraMessage=()=>send({type:'panoptes:camera',cameraId:state.frame});
function asset(path){const url=new URL(path,location.href);const base=new URL('.',location.href);if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname))throw Error('报告资源必须来自本站');return url.href;}
function finitePoint(p){return Array.isArray(p)&&p.length>=2&&p.slice(0,2).every(Number.isFinite);}
function validate(data){
  if(!Array.isArray(data.objects)||!data.objects.length||!Array.isArray(data.frames)||!data.frames.length)throw Error('报告缺少对象或照片数据');
  const ids=new Set();for(const o of data.objects){if(typeof o.id!=='string'||ids.has(o.id)||!o.plan?.hull?.length||!o.plan.hull.every(finitePoint))throw Error('场景对象或平面数据无效');ids.add(o.id);}
  for(const f of data.frames){asset(f.url);if(!(f.width>0&&f.height>0))throw Error('照片尺寸无效');}
  if(!data.legacy?.summary||!Array.isArray(data.legacy.inventory)||!Array.isArray(data.legacy.findings))throw Error('缺少原报告数据');
}
window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==$('model-viewer').contentWindow||!event.data||typeof event.data!=='object')return;
  if(event.data.type==='panoptes:ready'){state.viewerReady=true;if(state.data){selectionMessage();cameraMessage();}}
  if(event.data.type==='panoptes:selection'&&state.data){const id=event.data.objectId;if(id===null||objects().some(o=>o.id===id))select(id,true);}
  if(event.data.type==='panoptes:camera-selection'&&state.data&&state.data.frames.some(f=>f.id===event.data.cameraId)){state.frame=event.data.cameraId;renderPhoto();}
});

function renderChips(){
  $('object-list').innerHTML=objects().map((o,i)=>`<button class="object-chip" data-object-id="${esc(o.id)}" aria-pressed="${o.id===state.selected}" aria-label="选择${esc(name(o))}"><span class="object-number">${String(i+1).padStart(2,'0')}</span>${esc(name(o))}</button>`).join('');
}
function renderPhoto(){
  const frame=state.data.frames.find(f=>f.id===state.frame);if(!frame)throw Error('未知照片视角');
  $('photo-select').value=frame.id;$('photo-view').setAttribute('viewBox',`0 0 ${frame.width} ${frame.height}`);
  const shapes=objects().flatMap(o=>{const view=o.views.find(v=>v.frame_id===frame.id);if(!view?.polygons?.length)return[];return[{o,view}];});
  // Paint larger masks first so smaller foreground objects remain pickable.
  shapes.sort((a,b)=>area(b.view.polygons[0])-area(a.view.polygons[0]));
  const paths=shapes.map(({o,view})=>`<path class="photo-hit${o.id===state.selected?' selected':''}" data-object-id="${esc(o.id)}" role="button" tabindex="0" aria-label="照片中的${esc(name(o))}" fill="#304a3a" fill-opacity=".03" stroke="#f6f4e7" stroke-opacity=".85" stroke-width=".7" fill-rule="evenodd" d="${view.polygons.map(poly=>'M'+poly.map(p=>p.join(',')).join('L')+'Z').join(' ')}"><title>${esc(name(o))}</title></path>`).join('');
  $('photo-view').innerHTML=`<image href="${esc(asset(frame.url))}" width="${frame.width}" height="${frame.height}"/>${paths}`;
  $('photo-caption').textContent=`${frame.label||frame.id} · ${shapes.length} 个对象有分割证据`;
}
function area(poly){let sum=0;for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length];sum+=a[0]*b[1]-b[0]*a[1];}return Math.abs(sum/2);}
function planProjection(){
  const cameras=state.data.plan?.cameras||[];
  const camera=cameras.find(c=>c.id==='frame_0003')||cameras[0];
  if(!camera||!finitePoint(camera.forward))throw Error('缺少平面相机方向');
  const length=Math.hypot(...camera.forward),forward=camera.forward.map(x=>x/length),right=[forward[1],-forward[0]];
  const rotate=p=>[p[0]*right[0]+p[1]*right[1],-(p[0]*forward[0]+p[1]*forward[1])];
  const points=objects().flatMap(o=>o.plan.hull.map(rotate));
  const objectWidth=Math.max(...points.map(p=>p[0]))-Math.min(...points.map(p=>p[0]));
  points.push(...cameras.map(c=>rotate(c.position)));
  const bounds={min:[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1]))],max:[Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))]};
  const w=bounds.max[0]-bounds.min[0],h=bounds.max[1]-bounds.min[1];if(!(w>0&&h>0))throw Error('平面范围为空');
  const scale=Math.min(450/w,290/h),center=[(bounds.max[0]+bounds.min[0])/2,(bounds.max[1]+bounds.min[1])/2];
  const project=p=>{const r=rotate(p);return[300+(r[0]-center[0])*scale,195+(r[1]-center[1])*scale];};
  return{project,scale,w:objectWidth,h,rotate};
}
function renderPlans(){
  const {project,scale,w,h}=planProjection();
  const sorted=[...objects()].sort((a,b)=>area(b.plan.hull)-area(a.plan.hull));
  const svgObjects=(cad)=>sorted.map(o=>{
    const points=o.plan.hull.map(project),number=objects().indexOf(o)+1,selected=o.id===state.selected;
    const center=project(o.plan.center),isFloor=o.id==='observed_floor';
    const fill=cad?(isFloor?'url(#cad-hatch)':selected?'#f3d4bc':'#fdfcf8'):(isFloor?'#e8eadf':selected?'#e5ad83':'#d0d9cc');
    const stroke=selected?'#bc571f':isFloor?'#b7beb0':'#55705e';
    return`<g data-object-id="${esc(o.id)}" role="button" tabindex="0" aria-label="${cad?'CAD':'平面'}中的${esc(name(o))}"><polygon class="plan-shape${selected?' selected':''}" points="${points.map(p=>p.join(',')).join(' ')}" fill="${fill}" fill-opacity="${isFloor?'.7':'.9'}" stroke="${stroke}" stroke-width="${selected?2.6:cad?1.25:1.1}" ${isFloor?'stroke-dasharray="5 4"':''}/>${!isFloor?`<circle cx="${center[0]}" cy="${center[1]}" r="10" fill="transparent"/><text class="cad-label" x="${center[0]}" y="${center[1]+4}" text-anchor="middle">${String(number).padStart(2,'0')}</text>`:''}<title>${esc(name(o))} · 模型相对单位</title></g>`;
  }).join('');
  const selected=current();
  const highlight=selected?`<g pointer-events="none"><polygon points="${selected.plan.hull.map(project).map(p=>p.join(',')).join(' ')}" fill="none" stroke="#bc571f" stroke-width="3"/>${selected.id!=='observed_floor'?`<circle cx="${project(selected.plan.center)[0]}" cy="${project(selected.plan.center)[1]}" r="12" fill="none" stroke="#bc571f" stroke-width="1"/>`:''}</g>`:'';
  const legend=`<text x="20" y="26" font-size="10" fill="#67736b">后侧 ↑ · 按照片 3 方向显示</text><text x="580" y="380" text-anchor="end" font-size="10" fill="#67736b">模型单位 · 非米</text>`;
  const dimensions=`<path d="M${300-w*scale/2},355H${300+w*scale/2} M${300-w*scale/2},350v10 M${300+w*scale/2},350v10" fill="none" stroke="#899582" stroke-width=".8"/><text x="300" y="372" text-anchor="middle" font-size="10" fill="#67736b">投影外包络宽 ${w.toFixed(3)}</text>`;
  $('cad-view').innerHTML=`<defs><pattern id="cad-hatch" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M-2,2L2,-2M0,8L8,0M6,10L10,6" stroke="#d6dcca" stroke-width=".5"/></pattern></defs>${legend}${svgObjects(true)}${highlight}${dimensions}`;
  const cameras=(state.data.plan.cameras||[]).map(c=>{const p=project(c.position);const q=project([c.position[0]+c.forward[0],c.position[1]+c.forward[1]]);const angle=Math.atan2(q[1]-p[1],q[0]-p[0])*180/Math.PI+90;return`<g transform="translate(${p}) rotate(${angle})"><path class="plan-camera" d="M0,-7L5,6L-5,6Z"/></g>`;}).join('');
  $('plan-view').innerHTML=`${legend}<g id="plan-content">${svgObjects(false)}${highlight}${cameras}</g>`;
  updatePan();
}
function updatePan(){$('plan-content')?.setAttribute('transform',`translate(${300+state.pan[0]},${195+state.pan[1]}) scale(${state.zoom}) translate(-300,-195)`);}
function renderSelected(){
  const o=current();$('selected-name').textContent=o?name(o):'未选择对象';
  $('selected-source').textContent=o?(o.source==='observed'?'照片观测表面':'独立生成资产'):'';
  $('selected-mapping').textContent=o?(o.inventory_indices.length?`已核对原检测记录：${o.inventory_indices.map(i=>'#'+i).join('、')}`:'与原检测 inventory 暂无可靠对应'):'';
  $('object-detail-name').textContent=o?name(o):'点击照片、3D 或平面中的对象';
  $('object-detail-copy').textContent=o?(o.source==='observed'?'地面仅保留照片观测到的表面；未补全不可见范围。':`${o.views.length} 个输入视图提供分割证据。网格的遮挡背面由模型生成，实际尺寸尚未标定。`):'四个视图共享同一个对象选择。';
  const m=o?.metrics;
  $('object-metrics').innerHTML=m&&Number.isFinite(m.after_iou)?`<div class="metric-readout"><small>轮廓 IoU · 摆放前 → 后</small><b>${pct(m.before_iou)} <em>→</em> ${pct(m.after_iou)}</b></div><div class="metric-readout"><small>相对深度误差 · 前 → 后</small><b>${pct(m.before_depth)} <em>→</em> ${pct(m.after_depth)}</b></div>`:'';
  const rows=(m?.views||[]).map(v=>`<tr><td>${esc(state.data.frames.find(f=>f.id===v.frame_id)?.label||v.frame_id)}</td><td>${pct(v.before_iou)} → ${pct(v.after_iou)}</td><td>${pct(v.before_depth)} → ${pct(v.after_depth)}</td><td>${pct(v.before_boundary)} → ${pct(v.after_boundary)}</td></tr>`).join('');
  $('object-view-metrics').innerHTML=rows?`<table><thead><tr><th>同一输入视图</th><th>轮廓 IoU ↑</th><th>相对深度误差 ↓</th><th>边界误差 / 图高 ↓</th></tr></thead><tbody>${rows}</tbody></table>`:'<p class="empty-note">该对象没有生成资产摆放前后对比。</p>';
}
function renderLegacyCad(){
  const cad=state.data.legacy.cad;if(!cad?.url){$('legacy-cad-note').textContent='原报告没有可用 CAD 文件。';return;}
  const selected=current(),invSet=new Set(selected?.inventory_indices||[]);if(state.legacyInv!==null)invSet.add(state.legacyInv);
  $('legacy-cad').setAttribute('viewBox',`0 0 ${cad.width} ${cad.height}`);
  $('legacy-cad').innerHTML=`<image href="${esc(asset(cad.url))}" width="${cad.width}" height="${cad.height}"/>`+(cad.regions||[]).map(r=>{const mapped=objects().find(o=>o.inventory_indices.includes(r.inv));return`<polygon class="legacy-cad-hit${mapped?' mapped':''}${invSet.has(r.inv)?' selected':''}" data-inv="${r.inv}" role="button" tabindex="0" aria-label="原CAD检测记录${r.inv}" points="${r.polygon.map(p=>p.join(',')).join(' ')}"><title>原检测 #${r.inv}${mapped?' · '+esc(name(mapped)):' · 暂无生成对象对应'}</title></polygon>`;}).join('');
  $('legacy-cad-note').textContent=state.legacyInv!==null&&!selected?`已选择原记录 #${state.legacyInv}，没有可靠的新场景对应；未在新 3D 中猜测高亮。`:selected?.inventory_indices.length?'橙色为同一照片分割已核对的原记录。原 CAD 保留原坐标，没有与新重建叠加。':'原 CAD 使用旧报告坐标。当前场景对象没有可靠对应时，不强行关联。';
  document.querySelectorAll('#legacy-inventory tr[data-inv]').forEach(row=>row.classList.toggle('active',invSet.has(Number(row.dataset.inv))));
}
function select(id,fromViewer=false){
  const previousFrame=state.frame;state.selected=id;state.legacyInv=null;const o=current();
  if(o?.views.length&&!o.views.some(v=>v.frame_id===state.frame))state.frame=o.views.some(v=>v.frame_id==='frame_0003')?'frame_0003':o.views[0].frame_id;
  renderChips();renderPhoto();renderPlans();renderSelected();renderLegacyCad();
  document.querySelectorAll('#reconstruction-table tr[data-object-id]').forEach(row=>row.classList.toggle('active',row.dataset.objectId===id));
  if(!fromViewer)selectionMessage();
  if(state.frame!==previousFrame)cameraMessage();
  window.dispatchEvent(new CustomEvent('panoptes-selection',{detail:{objectId:id,source:fromViewer?'3d':'report'}}));
}
function selectInventory(inv){
  const o=objects().find(o=>o.inventory_indices.includes(inv));
  select(o?.id||null);state.legacyInv=inv;renderLegacyCad();
}
function verdict(status){const cls=status==='FAIL'?'fail':status==='PASS'?'pass':'unknown';const label=status==='FAIL'?'未通过':status==='PASS'?'通过':status==='INSUFFICIENT_EVIDENCE'?'证据不足':status||'未提供';return`<span class="verdict ${cls}">${esc(label)}</span>`;}
function renderLegacy(){
  const {summary,findings,inventory}=state.data.legacy;
  const fails=findings.filter(f=>f.status==='FAIL').length,unknown=findings.filter(f=>f.status==='INSUFFICIENT_EVIDENCE').length;
  $('report-status').innerHTML=`<span class="status-pill"><i class="status-dot"></i><strong>原检测：${fails} 项未通过 · ${unknown} 项证据不足</strong></span><i class="divider"></i><span>${objects().length} 个场景对象 · ${state.data.frames.length} 张照片</span><i class="divider"></i><span>新重建尺度尚未标定</span>`;
  $('counts').textContent=`${objects().length} 个场景对象 / ${inventory.length} 条原检测记录`;
  $('legacy-summary').textContent=`${inventory.length} 条检测记录 · ${summary.label_count??'—'} 类标签 · ${(state.data.legacy.cad?.regions||[]).length} 个 CAD 投影。原尺度来源：${summary.scale_source||'未提供'}。这些是原 run 已保存的结果。`;
  $('review-status').textContent=summary.review_status==='not_recorded'?'没有审核记录':summary.review_status||'没有审核记录';
  $('findings').innerHTML=findings.map(f=>`<article class="finding"><div class="finding-top"><h4 data-i18n-ignore>${esc(f.title||f.id)}</h4>${verdict(f.status)}</div><p data-i18n-ignore>${esc(f.summary)}</p>${f.evidence||f.metrics?`<details><summary>查看保存的证据</summary>${f.evidence?.url?`<a href="${esc(asset(f.evidence.url))}">原始证据与限制记录 JSON ↗</a>`:''}<pre>${esc(JSON.stringify({evidence:f.evidence,metrics:f.metrics},null,2))}</pre></details>`:''}</article>`).join('');
  $('inventory-summary').textContent=`展开全部 ${inventory.length} 条原检测记录`;
  $('legacy-inventory').innerHTML=`<table><thead><tr><th>记录</th><th>原标签</th><th>来源视图</th><th>对应新场景</th></tr></thead><tbody>${inventory.map(i=>{const mapped=objects().find(o=>o.inventory_indices.includes(i.inv));return`<tr data-inv="${i.inv}"><td><button data-inv="${i.inv}" aria-label="选择检测记录${i.inv}">#${i.inv}</button></td><td data-i18n-ignore>${esc(i.label)}</td><td>${esc(i.frame_id||i.frame_ids?.join('、')||'—')}</td><td>${mapped?`<button data-object-id="${esc(mapped.id)}">${esc(name(mapped))} ↗</button>`:'暂无可靠对应'}</td></tr>`;}).join('')}</tbody></table>`;
}
function renderExperiments(){
  $('reconstruction-table').innerHTML=`<table><thead><tr><th>对象</th><th>同图轮廓 IoU 前 → 后 ↑</th><th>相对深度误差前 → 后 ↓</th><th>输入视图</th></tr></thead><tbody>${objects().filter(o=>Number.isFinite(o.metrics?.after_iou)).map(o=>`<tr data-object-id="${esc(o.id)}"><td><button data-object-id="${esc(o.id)}">${esc(name(o))}</button></td><td>${pct(o.metrics.before_iou)} → ${pct(o.metrics.after_iou)}</td><td>${pct(o.metrics.before_depth)} → ${pct(o.metrics.after_depth)}</td><td>${o.views.length}</td></tr>`).join('')}</tbody></table>`;
}
function bindInteractions(){
  document.addEventListener('click',event=>{
    const object=event.target.closest('[data-object-id]');if(object){select(object.dataset.objectId);return;}
    const record=event.target.closest('[data-inv]');if(record)selectInventory(Number(record.dataset.inv));
  });
  document.addEventListener('keydown',event=>{if(event.key!=='Enter'&&event.key!==' ')return;const target=event.target.closest('svg [data-object-id],svg [data-inv]');if(!target)return;event.preventDefault();if(target.dataset.objectId)select(target.dataset.objectId);else selectInventory(Number(target.dataset.inv));});
  $('photo-select').addEventListener('change',event=>{state.frame=event.target.value;renderPhoto();cameraMessage();});
  for(const [id,factor] of [['plan-plus',1.25],['plan-minus',.8]])$(id).onclick=()=>{state.zoom=Math.min(4,Math.max(.65,state.zoom*factor));updatePan();};
  $('plan-reset').onclick=()=>{state.zoom=1;state.pan=[0,0];updatePan();};
  const svg=$('plan-view');let drag=null;
  svg.addEventListener('wheel',event=>{event.preventDefault();state.zoom=Math.min(4,Math.max(.65,state.zoom*Math.exp(-event.deltaY*.001)));updatePan();},{passive:false});
  svg.addEventListener('pointerdown',event=>{if(event.target.closest('[data-object-id]')||event.button!==0)return;const inverse=svg.getScreenCTM().inverse(),p=new DOMPoint(event.clientX,event.clientY).matrixTransform(inverse);drag={x:p.x,y:p.y};svg.setPointerCapture(event.pointerId);svg.classList.add('dragging');});
  svg.addEventListener('pointermove',event=>{if(!drag)return;const p=new DOMPoint(event.clientX,event.clientY).matrixTransform(svg.getScreenCTM().inverse());state.pan[0]+=p.x-drag.x;state.pan[1]+=p.y-drag.y;drag={x:p.x,y:p.y};updatePan();});
  const end=()=>{drag=null;svg.classList.remove('dragging');};svg.addEventListener('pointerup',end);svg.addEventListener('pointercancel',end);
}
(async()=>{
  try{
    const response=await fetch('unified-data.json');if(!response.ok)throw Error('报告数据加载失败：'+response.status);const data=await response.json();validate(data);state.data=data;
    if(!objects().some(o=>o.id===state.selected))state.selected=objects()[0].id;
    if(!data.frames.some(f=>f.id===state.frame))state.frame=data.frames[0].id;
    $('photo-select').innerHTML=data.frames.map(f=>`<option value="${esc(f.id)}">${esc(f.label||f.id)}</option>`).join('');
    bindInteractions();renderLegacy();renderExperiments();select(state.selected);cameraMessage();
    window.panoptesReport={state,selectObject:select,selectInventory};
  }catch(error){$('report-status').classList.add('error-state');$('report-status').textContent='报告未完整加载：'+error.message;console.error(error);}
})();

// ponytail: one active playground; export JSON before switching to retain edits.
const playgrounds={
  generated:{name:'完整对象重建',url:'viewer.html',preview:'playground-generated.png',description:'Pi3X + RecGen · 9 个生成资产与 1 块观测地面。旋转场景，点选对象，再调整位置、旋转和缩放。'},
  observed:{name:'照片表面重建',url:'observed/',preview:'observed/preview.png',description:'workcell-reconstruction-01 · 较早的内部表面 GLB。切换原始照片机位、原图对照和线框；未拍到的区域保留为空。'},
  blender:{name:'参数化柱体试验',url:'viewer.html?scene=blender-scene.json',preview:'blender/parametric-frame_0003.png',description:'原生 Blender 试验的实际几何：仅两根防撞柱换为拟合圆柱，其余 8 个对象保持不变。网页可调整对象变换；半径与高度参数可在下载的 .blend 中修改。'},
  components:{name:'工位物体与范围',url:'viewer.html?scene=components/scene.json',preview:'components/preview.png',description:'查看各照片中的物体观测范围，在原图和 3D 中点选、查看包围框与三轴。两个按钮保留完整生成网格；其余区域来自分割和深度，尚未合并为跨视角实体。'}
};
let playgroundId='generated';
function closePlayground(){const previous=$('playground-frame'),frame=previous.cloneNode(false);frame.removeAttribute('src');frame.hidden=true;previous.replaceWith(frame);$('playground-preview').hidden=false;$('playground-launch').hidden=false;$('playground-close').hidden=true;$('playground-fullscreen').hidden=true;}
for(const button of document.querySelectorAll('[data-playground]'))button.addEventListener('click',()=>{
  closePlayground();playgroundId=button.dataset.playground;const item=playgrounds[playgroundId];
  document.querySelectorAll('[data-playground]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
  $('playground-name').textContent=item.name;$('playground-description').textContent=item.description;$('playground-preview').src=item.preview;$('playground-preview').alt=item.name+'的实际三维预览';$('playground-open').href=item.url;
});
$('explore-playground').onclick=()=>{const item=playgrounds[playgroundId],frame=$('playground-frame');frame.title=item.name+' · 可交互实验场';frame.src=item.url;frame.hidden=false;$('playground-preview').hidden=true;$('playground-launch').hidden=true;$('playground-close').hidden=false;$('playground-fullscreen').hidden=!document.fullscreenEnabled;};
$('playground-close').onclick=closePlayground;
$('playground-fullscreen').onclick=async()=>{try{await $('playground-stage').requestFullscreen();}catch{$('playground-description').textContent='当前浏览器未进入全屏，可使用“单独打开”继续操作。';}};
