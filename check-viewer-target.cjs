#!/usr/bin/env node
// Run: node check-viewer-target.cjs [report URL]. No model calls or scene writes.
const assert=require('node:assert/strict');
const {webkit,chromium}=require('/Users/adam/.codex/skills/gstack/node_modules/playwright');
const base=(process.argv[2]||'http://127.0.0.1:8892/').replace(/\/?$/,'/'),target='object_ddfd00218e68ffd9e3e7f515';
async function boxSize(page){return page.locator('#selection-overlay').evaluate(svg=>{const lines=[...svg.querySelectorAll('[data-bbox-edge]')],x=lines.flatMap(l=>[+l.getAttribute('x1'),+l.getAttribute('x2')]),y=lines.flatMap(l=>[+l.getAttribute('y1'),+l.getAttribute('y2')]);return Math.max((Math.max(...x)-Math.min(...x))/svg.viewBox.baseVal.width,(Math.max(...y)-Math.min(...y))/svg.viewBox.baseVal.height);});}
async function check(engine){
 const browser=await({webkit,chromium}[engine]).launch(engine==='chromium'?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{});let release=()=>{};
 try{
  const page=await browser.newPage(engine==='webkit'?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.emulateMedia({reducedMotion:'reduce'});
  const scene=base+'viewer.html?scene=components/scene.json';
  await page.goto(scene);await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('场景已完整加载'),null,{timeout:60000});
  assert.equal(await page.locator('#camera-label').textContent(),'整体视角');assert.equal(await page.locator('#selection-overlay').getAttribute('data-object-id'),'');
  const original=await page.evaluate(()=>JSON.stringify(lucidaViewer.original));
  await page.evaluate(id=>lucidaViewer.selectObject(lucidaViewer.scene.objects.findIndex(o=>o.id===id)),target);const overviewSize=await boxSize(page);
  const gate=new Promise(resolve=>release=resolve);await page.route('**/object_6dd85942d104987a83c677d6.bin.gz',async route=>{await gate;await route.continue();});
  await page.goto(scene+'&object='+target);await page.waitForFunction(()=>document.getElementById('canvas').dataset.loadedObjects==='2',null,{timeout:60000});
  assert.equal(await page.locator('#selection-overlay').getAttribute('data-object-id'),'','URL focus waits for complete geometry');
  release();await page.waitForFunction(id=>document.getElementById('selection-overlay').dataset.objectId===id,target,{timeout:60000});await page.unroute('**/object_6dd85942d104987a83c677d6.bin.gz');
  assert.equal(await page.locator('#camera-label').textContent(),'对象聚焦');assert.equal(await page.locator('#selection-overlay [data-axis]').count(),3);assert.equal(await page.locator('[data-bbox-edge]').count(),12);
  const focusedSize=await boxSize(page);assert(focusedSize>.5&&focusedSize>overviewSize*5,'target must fill the view instead of remaining a tiny object beside the floor');
  assert.equal(await page.evaluate(()=>JSON.stringify(lucidaViewer.original)),original,'URL focus never modifies source geometry');
  assert.deepEqual(await page.evaluate(()=>lucidaViewer.scene.objects.map(o=>o.transform)),await page.evaluate(()=>lucidaViewer.original.objects.map(o=>o.transform)));
  await page.screenshot({path:`/tmp/panoptes-target-${engine}.png`});
  let meshRequests=0;page.on('request',r=>{if(r.url().includes('.bin.gz'))meshRequests++;});
  await page.goto(scene+'&object=object_ddfd');await page.waitForFunction(()=>document.getElementById('status').classList.contains('error'));
  assert.equal(await page.locator('#status').textContent(),'场景中没有此对象：object_ddfd');assert.equal(meshRequests,0,'invalid exact ID is rejected before downloading geometry');
  await page.selectOption('[data-language-select]','en');await page.waitForFunction(()=>document.getElementById('status').textContent==='Object not found in this scene: object_ddfd');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({engine,passed:true,initialSelectionAfterFullLoad:true,exactIdValidation:true,overviewSize,focusedSize,axes:3,geometryUnchanged:true}));
 }finally{release();await browser.close();}
}
(async()=>{for(const engine of(process.env.ENGINES||'webkit,chromium').split(','))await check(engine);})().catch(e=>{console.error(e);process.exitCode=1;});
