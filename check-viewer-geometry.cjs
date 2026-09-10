#!/usr/bin/env node
// Run: node check-viewer-geometry.cjs [report URL]. No geometry or scene files are modified.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webkit,chromium}=require('/Users/adam/.codex/skills/gstack/node_modules/playwright');
const html=fs.readFileSync(__dirname+'/viewer.html','utf8'),context={};
vm.createContext(context);vm.runInContext(html.slice(html.indexOf('const add='),html.indexOf('function localAsset('))+';globalThis.math={measureGeometry,cameraMatrix};',context);
const {measureGeometry,cameraMatrix}=context.math;
const close=(a,b,tolerance=1e-6)=>assert(Math.abs(a-b)<tolerance,`${a} != ${b}`);
const box=(x,y,z)=>({positions:new Float32Array(Array.from({length:8},(_,i)=>[(i&1?1:-1)*x/2,(i&2?1:-1)*y/2,(i&4?1:-1)*z/2]).flat())});
const object={transform:{position:[3,8,-5],rotation_deg:[0,0,45],scale:[1,1,1]}};
const diagonal=[Math.SQRT1_2,Math.SQRT1_2,0];
close(measureGeometry(object,box(2,1,4),diagonal).height,2);
object.transform.position=[-40,20,18];close(measureGeometry(object,box(2,1,4),diagonal).height,2);
object.transform.scale=[3,1,1];close(measureGeometry(object,box(2,1,4),diagonal).height,6);
const baked={transform:{position:[0,0,0],rotation_deg:[0,0,0],scale:[1,1,1]}},basis=[[0,1,0],[0,0,1],[1,0,0]];
close(measureGeometry(baked,box(4,2,2),[1,0,0],basis).axisAngles[2],0);
baked.transform.rotation_deg[2]=30;const turned=measureGeometry(baked,box(4,2,2),[1,0,0],basis);
close(turned.axisAngles[2],30);close(turned.height,4*Math.cos(Math.PI/6)+2*Math.sin(Math.PI/6));
const floorBasis=[[Math.SQRT1_2,-Math.SQRT1_2,0],[0,0,1],diagonal],sized=measureGeometry(object,box(2,1,4),diagonal,undefined,floorBasis);close(sized.dimensions.height,6);close(sized.dimensions.width,1);close(sized.dimensions.depth,4);
const camera={eye:[0,0,10],target:[0,0,0],up:[0,1,0],orthographic:true,orthoHeight:4},matrix=cameraMatrix(camera,2,2);
close(matrix[0],.25);close(matrix[5],.5);close(matrix[15],1); // Real orthographic projection, not a narrow perspective camera.
console.log('PASS: arbitrary floor normal, translation invariant height, nonuniform scale, baked cylinder reference axis, orthographic projection.');
const base=(process.argv[2]||'http://127.0.0.1:8892/').replace(/\/?$/,'/');
async function check(engine){const browser=await ({webkit,chromium}[engine]).launch(engine==='chromium'?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{});try{
 const mobile=engine==='webkit',page=await browser.newPage(mobile?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{viewport:{width:1440,height:900}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));await page.emulateMedia({reducedMotion:'reduce'});
 await page.goto(base+'viewer.html');await page.waitForFunction(()=>document.getElementById('canvas').dataset.loadedObjects==='10',null,{timeout:60000});
 const original=await page.evaluate(()=>JSON.stringify(lucidaViewer.original));
 for(let i=0;i<10;i++){await page.evaluate(i=>lucidaViewer.selectObject(i),i);assert.equal(await page.locator('[data-bbox-edge]').count(),12);assert.equal(await page.locator('#selection-overlay [data-axis]').count(),3);assert(Number(await page.locator('#selection-overlay').getAttribute('data-height'))>0);}
 await page.evaluate(()=>lucidaViewer.selectObject(0));
 const baseline=await page.evaluate(()=>({height:lucidaViewer.measurement(0).height,angle:lucidaViewer.measurement(0).axisAngles[2]}));
 for(const view of ['front','side','top']){await page.selectOption('#camera',view);assert.equal(await page.locator('#canvas').getAttribute('data-projection'),'orthographic');assert.equal(await page.locator('[data-bbox-edge]').count(),12);}
 await page.selectOption('#camera','front');
 const before=await page.evaluate(()=>({position:[...lucidaViewer.scene.objects[0].transform.position],directions:lucidaViewer.measurement(0).directions}));
 const handle=await page.locator('#selection-overlay').evaluate(svg=>{const line=svg.querySelector('[data-axis="2"] .axis-line'),r=svg.getBoundingClientRect();return {x:r.x+Number(line.getAttribute('x1')),y:r.y+Number(line.getAttribute('y1')),dx:Number(line.getAttribute('x2'))-Number(line.getAttribute('x1')),dy:Number(line.getAttribute('y2'))-Number(line.getAttribute('y1'))};});
 const norm=Math.hypot(handle.dx,handle.dy),start={x:handle.x+handle.dx*.7,y:handle.y+handle.dy*.7};assert(norm>8);
 await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x+handle.dx/norm*20,start.y+handle.dy/norm*20,{steps:4});await page.mouse.up();
 const after=await page.evaluate(()=>lucidaViewer.scene.objects[0].transform.position),delta=after.map((value,i)=>value-before.position[i]),axis=before.directions[2],length=Math.hypot(...delta);
 assert(length>.001,'axis handle must actually move the object');delta.forEach((value,i)=>close(value/length,axis[i],1e-5));close(await page.evaluate(()=>lucidaViewer.measurement(0).height),baseline.height);
 await page.locator('#selection-overlay [data-axis="1"]').focus();await page.keyboard.press('ArrowRight');assert.notDeepEqual(await page.evaluate(()=>lucidaViewer.scene.objects[0].transform.position),after);
 await page.locator('#rotation_deg-0').fill('148.55201655885335');await page.locator('#rotation_deg-0').dispatchEvent('change');assert(Math.abs(await page.evaluate(()=>lucidaViewer.measurement(0).axisAngles[2])-baseline.angle)>5);
 await page.locator('#scale-2').fill('1.2');await page.locator('#scale-2').dispatchEvent('change');assert(await page.evaluate(()=>lucidaViewer.measurement(0).height)>baseline.height);
 const expectedEdit=await page.evaluate(()=>({transform:structuredClone(lucidaViewer.scene.objects[0].transform),height:lucidaViewer.measurement(0).height,angle:lucidaViewer.measurement(0).axisAngles[2],metrics:JSON.stringify(lucidaViewer.original.objects[0].metrics),units:lucidaViewer.original.units}));
 const exportedDownload=page.waitForEvent('download');await page.locator('#download').click();const downloaded=await exportedDownload;assert.equal(await downloaded.failure(),null);const exportedBytes=fs.readFileSync(await downloaded.path()),exported=JSON.parse(exportedBytes);
 assert.deepEqual(exported.objects[0].transform,expectedEdit.transform);assert.equal(exported.units,expectedEdit.units);assert.equal(JSON.stringify(exported.objects[0].metrics),expectedEdit.metrics,'local edits do not fabricate re-evaluated metrics');
 await page.locator('#reset-object').click();close(await page.evaluate(()=>lucidaViewer.measurement(0).height),baseline.height);
 await page.locator('#import-file').setInputFiles({name:downloaded.suggestedFilename(),mimeType:'application/json',buffer:exportedBytes});await page.waitForFunction(()=>document.getElementById('status').textContent.includes('已恢复同 run'));
 assert.deepEqual(await page.evaluate(()=>lucidaViewer.scene.objects[0].transform),expectedEdit.transform);close(await page.evaluate(()=>lucidaViewer.measurement(0).height),expectedEdit.height);close(await page.evaluate(()=>lucidaViewer.measurement(0).axisAngles[2]),expectedEdit.angle);
 await page.locator('#reset-object').click();close(await page.evaluate(()=>lucidaViewer.measurement(0).height),baseline.height);close(await page.evaluate(()=>lucidaViewer.measurement(0).axisAngles[2]),baseline.angle);
 await page.selectOption('[data-language-select]','en');await page.waitForFunction(()=>document.getElementById('geometry-height').textContent.includes('Normal height'));assert((await page.locator('#geometry-note').textContent()).includes('Measured structural tilt is unknown'));
 assert.equal(await page.evaluate(()=>JSON.stringify(lucidaViewer.original)),original);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.locator('#reset-all').click();assert.equal(await page.locator('#selection-overlay [data-axis]').count(),0);assert(!await page.locator('#geometry-readout').isVisible());
 await page.goto(base+'viewer.html?scene=blender-scene.json');await page.waitForFunction(()=>window.lucidaViewer?.referenceFrames.size===2&&document.getElementById('canvas').dataset.loadedObjects==='10',null,{timeout:60000});await page.evaluate(()=>lucidaViewer.selectObject(0));
 close(await page.evaluate(()=>lucidaViewer.measurement(0).axisAngles[2]),0,1e-5);assert((await page.locator('#geometry-angle').textContent()).includes('Cylinder reference-axis angle'));
 await page.evaluate(()=>lucidaViewer.selectObject(9));assert((await page.locator('#geometry-note').textContent()).includes("upright axis"));assert((await page.locator('#geometry-note').textContent()).includes('unknown'));
 assert.deepEqual(errors,[]);console.log(JSON.stringify({engine,mobile,passed:true,objects:10,boxEdges:12,axes:3,axisDrag:true,orthographicViews:3,exportImportRestoresGeometry:true,fullGeometryPreserved:true}));
 }finally{await browser.close();}}
(async()=>{for(const engine of (process.env.ENGINES||'webkit,chromium').split(','))await check(engine);})().catch(error=>{console.error(error);process.exitCode=1;});
