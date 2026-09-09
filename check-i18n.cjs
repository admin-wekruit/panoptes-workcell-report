#!/usr/bin/env node
// Run: node check-i18n.cjs [base URL]. Requires the installed Playwright browsers.
const assert=require('node:assert/strict');
const {webkit,chromium}=require('/Users/adam/.codex/skills/gstack/node_modules/playwright');
const base=(process.argv[2]||'http://127.0.0.1:8892/').replace(/\/?$/,'/');
const engines=(process.env.ENGINES||'webkit,chromium').split(',');
const text=async(page,selector)=>(await page.locator(selector).textContent()).trim();
async function lang(page,value){await page.locator('[data-language-select]').selectOption(value);await page.waitForFunction(value=>document.documentElement.lang===(value==='zh'?'zh-CN':'en'),value);}
async function hasText(page,selector,value){await page.waitForFunction(({selector,value})=>document.querySelector(selector)?.textContent.includes(value),{selector,value});}
async function noOverflow(page){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page overflows horizontally');}
async function check(engine){
 const browser=await ({webkit,chromium}[engine]).launch(engine==='chromium'?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{});
 let release=()=>{};
 try{
  const context=await browser.newContext(engine==='webkit'?{viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2}:{viewport:{width:1440,height:1000}});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push({url:page.url(),error:error.stack}));await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(base+'reports.html');await hasText(page,'#history-status','2 份已发布报告');
  assert.equal(await page.locator('[data-report-id]').count(),2,'both real report artifacts are listed');
  await page.waitForFunction(()=>[...document.querySelectorAll('.history-preview img')].every(img=>img.complete&&img.naturalWidth>0));
  await lang(page,'en');await hasText(page,'#history-status','2 published reports');await hasText(page,'.history-body h2','BOR1 · Unified workcell report');
  assert.equal(await page.locator('.history-runs code').first().textContent(),'user-bor1-02');
  await page.locator('[data-report-id="product-evidence-01"] [data-open-report]').click();
  await page.waitForFunction(()=>document.querySelector('canvas')?.dataset.loadedObjects==='3',null,{timeout:60000});await hasText(page,'#scene-title','Small-object reconstruction');
  assert(!await page.locator('#blender-report').isVisible());assert.match(await page.locator('#scene-report').getAttribute('href'),/components\/metrics\.html$/);
  await page.locator('#scene-report').click();await hasText(page,'h1','Same photos, same objects, same metrics');
  assert.equal(await page.locator('section').count(),2);const componentNumbers=await page.locator('tbody td').allTextContents();
  assert((await page.locator('main').textContent()).includes('source geometry estimates'));assert((await page.locator('main').textContent()).includes('not performance on an independent test set'));
  for(const img of await page.locator('section img').all())await img.evaluate(node=>node.scrollIntoView({block:'center',behavior:'instant'}));
  await page.waitForFunction(()=>[...document.querySelectorAll('section img')].every(img=>img.complete&&img.naturalWidth>0));
  await lang(page,'zh');await hasText(page,'h1','同一批照片');await lang(page,'en');assert.deepEqual(await page.locator('tbody td').allTextContents(),componentNumbers);await noOverflow(page);
  await page.goto(base+'reports.html');await hasText(page,'#history-status','2 published reports');
  const workspace='https://wekruit-livekit-agents--panoptes-report-workspace-web.modal.run/reports';
  await page.locator(`a.primary-link[href="${workspace}"]`).click();await page.waitForURL(workspace);await page.waitForSelector('a.report-card');await page.evaluate(()=>panoptesSession.ready);await noOverflow(page);
  await page.goto(base+'reports.html');await hasText(page,'#history-status','2 published reports');
  await page.locator('[data-report-id="bor1-workcell"] [data-open-report]').click();await page.waitForFunction(()=>window.panoptesReport);await hasText(page,'h1','See site evidence');
  await page.locator('a[href="reports.html"]').click();await hasText(page,'#history-status','2 published reports');
  await lang(page,'zh');await page.locator('[data-report-id="bor1-workcell"] [data-open-report]').click();await page.waitForFunction(()=>window.panoptesReport);
  assert.equal(await text(page,'h1'),'现场证据，与三维场景一起看。');
  const source=await page.evaluate(()=>JSON.stringify(panoptesReport.state.data));
  const evidence=await page.locator('#findings [data-i18n-ignore],#legacy-inventory [data-i18n-ignore]').allTextContents();
  await lang(page,'en');await hasText(page,'h1','See site evidence');await hasText(page,'#counts','10 scene objects / 37');
  assert.equal(await page.locator('a[href="reports.html"]').textContent(),'Report history');
  await page.evaluate(()=>{const raw=document.createElement('p');raw.id='original-user-text';raw.dataset.i18nIgnore='';raw.textContent='原图对照';document.body.append(raw);});
  assert.equal(await text(page,'#original-user-text'),'原图对照','user content must stay verbatim');
  await page.evaluate(()=>{const raw=document.createElement('p');raw.id='original-raw-evidence';raw.className='raw';raw.textContent='全选';document.body.append(raw);const hud=document.createElement('p');hud.id='legacy-hud-check';hud.textContent='测量点云 · 600,000 点\n已选 2 个';document.body.append(hud);});
  await hasText(page,'#legacy-hud-check','600,000 points');await hasText(page,'#legacy-hud-check','2 selected');assert.equal(await text(page,'#original-raw-evidence'),'全选');
  await page.locator('#workspace').scrollIntoViewIfNeeded();await page.locator('#model-viewer').scrollIntoViewIfNeeded();
  const child=await page.locator('#model-viewer').elementHandle().then(handle=>handle.contentFrame());
  await child.waitForFunction(()=>window.lucidaViewer&&document.getElementById('canvas').dataset.loadedObjects==='10',null,{timeout:60000});
  assert.equal(await child.locator('html').getAttribute('lang'),'en');
  await hasText(child,'#status','Scene fully loaded.');
  await page.evaluate(()=>panoptesReport.selectObject('robot'));await hasText(page,'#selected-name','Industrial robot');
  assert.equal(await child.locator('#selection-overlay [role=button]').count(),0,'frozen linked report does not edit 3D independently of its plans');
  await child.locator('#camera').selectOption('frame_0002');await hasText(child,'#camera-label','Photo 2 · Source-photo viewpoint');
  assert.equal(await page.locator('#photo-select').inputValue(),'frame_0002');
  await lang(child,'zh');await hasText(page,'#selected-name','工业机器人');
  assert.equal(await page.locator('#photo-select').inputValue(),'frame_0002');
  await lang(page,'en');await hasText(child,'#camera-label','Photo 2');
  assert.equal(await page.evaluate(()=>JSON.stringify(panoptesReport.state.data)),source,'language must not modify report data');
  assert.deepEqual(await page.locator('#findings [data-i18n-ignore],#legacy-inventory [data-i18n-ignore]').allTextContents(),evidence);
  await noOverflow(page);
  await page.reload();await page.waitForFunction(()=>window.panoptesReport);await hasText(page,'h1','See site evidence');
  await page.locator('[data-playground="observed"]').click();await page.locator('#explore-playground').click();
  const observed=await page.locator('#playground-frame').elementHandle().then(handle=>handle.contentFrame());
  await observed.waitForFunction(()=>document.querySelector('canvas')?.dataset.meshLoaded==='true',null,{timeout:60000});
  await hasText(observed,'#status','2 photos of the same state');
  await observed.locator('#wire').click();await hasText(observed,'#wire','Solid');
  await lang(observed,'zh');await hasText(page,'#playground-name','照片表面重建');await hasText(observed,'#wire','实体');
  await lang(page,'en');await hasText(observed,'#wire','Solid');await noOverflow(page);
  await page.goto(base+'metrics.html');await hasText(page,'h1','Same photos, same objects, same metrics');
  assert.equal((await page.locator('tbody tr:first-child td:first-child').first().textContent()).trim(),'frame_0001');
  await lang(page,'zh');await hasText(page,'h1','同一批照片，同一物体，同一指标');await lang(page,'en');await noOverflow(page);
  const gate=new Promise(resolve=>release=resolve);
  await page.route('**/cart.bin.gz',async route=>{await gate;await route.continue();});
  await page.goto(base+'viewer.html');
  await page.waitForFunction(()=>document.getElementById('canvas').dataset.loadedObjects==='9',null,{timeout:60000});
  await hasText(page,'#summary','Showing 9 / 10 objects');await hasText(page,'#status','Loading ');
  const original=await page.evaluate(()=>JSON.stringify(lucidaViewer.original));
  await page.evaluate(()=>lucidaViewer.selectObject(0));
  await page.locator('#position-0').fill('0.123');await page.locator('#position-0').dispatchEvent('change');await hasText(page,'#status','Object transform updated.');
  const edited=await page.evaluate(()=>JSON.stringify(lucidaViewer.scene.objects[0].transform));
  await lang(page,'zh');await hasText(page,'#status','对象变换已更新');await lang(page,'en');
  assert.equal(await page.evaluate(()=>JSON.stringify(lucidaViewer.scene.objects[0].transform)),edited,'switching language must retain edits');
  assert.equal(await page.evaluate(()=>JSON.stringify(lucidaViewer.original)),original,'source scene must remain immutable');
  await page.locator('#scale-0').fill('0');await page.locator('#scale-0').dispatchEvent('change');await hasText(page,'#status','scale must be greater than zero');
  release();await page.waitForFunction(()=>document.getElementById('canvas').dataset.loadedObjects==='10',null,{timeout:60000});await hasText(page,'#status','Scene fully loaded.');
  await page.locator('#reset-all').click();await page.unroute('**/cart.bin.gz');await noOverflow(page);
  await page.goto(base+'viewer.html?scene=blender-scene.json');
  await page.waitForFunction(()=>window.lucidaViewer);await hasText(page,'#scene-title','Parametric bollard trial');
  await page.evaluate(()=>lucidaViewer.selectObject(0));await hasText(page,'#metrics-title','Parametric trial comparison');await hasText(page,'#provenance','Parametric asset');
  assert.equal(await text(page,'#inspector-title'),'left front black bollard · 参数化圆柱','original object label remains verbatim');
  assert(!await page.locator('#glb').isVisible());await noOverflow(page);
  await page.evaluate(()=>{window.dispatchEvent(new MessageEvent('message',{origin:'https://untrusted.example',source:parent,data:{type:'panoptes:language',language:'zh'}}));});
  assert.equal(await page.locator('html').getAttribute('lang'),'en','foreign-origin message rejected');
  // API available to additional report surfaces and the Agent chat shell.
  assert.equal(await page.evaluate(()=>{panoptesI18n.add({'chat.test':{zh:'添加 {count} 个物体',en:'Add {count} objects'}});return panoptesI18n.t('chat.test',{count:2});}),'Add 2 objects');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({engine,passed:true,coverage:'2 history entries + live cloud workspace link + 5 report surfaces, component metrics, live iframe sync, persistence, dynamic controls and loading/errors, immutable evidence/edits, mobile overflow'}));
 }finally{release();await browser.close();}
}
(async()=>{for(const engine of engines)await check(engine);})().catch(error=>{console.error(error);process.exitCode=1;});
