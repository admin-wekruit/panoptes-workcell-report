#!/usr/bin/env node
// Read-only browser QA: existing reports and invalid access-code submission only; never upload or invoke the Agent.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),vm=require('node:vm');
const {webkit,chromium}=require('/Users/adam/.codex/skills/gstack/node_modules/playwright');
const base=(process.argv[2]||'http://127.0.0.1:8792').replace(/\/$/,''),runId='user-bor1-02';
const hasText=(page,selector,value)=>page.waitForFunction(({selector,value})=>document.querySelector(selector)?.textContent.includes(value),{selector,value});
async function language(page,lang){await page.selectOption('#language',lang);await page.waitForFunction(lang=>document.documentElement.lang===(lang==='en'?'en':'zh-CN'),lang);}
async function snapshot(page){return page.evaluate(()=>({frame:document.getElementById('photo-frame').value,image:document.getElementById('source-photo').getAttribute('href'),viewBox:document.getElementById('correction-photo').getAttribute('viewBox'),selected:[...document.querySelectorAll('.candidate[aria-pressed="true"]')].map(node=>node.dataset.id),box:['x','y','width','height'].map(key=>document.getElementById('selection-box').getAttribute(key)),boxVisible:document.getElementById('selection-box').style.display!=='none'}));}
function checkPixelEdges(source){
 const selection=source.slice(source.indexOf('function selectCandidate('),source.indexOf('\nfunction renderCandidates('));assert(selection.startsWith('function selectCandidate('));
 // Known image-edge rectangles, independently transformed by resize and crop. A describes pixel centres.
 for(const sample of [
  {A:[[.25,0,-.375],[0,.5,-.25],[0,0,1]],canonical:[5,20,25,60],original:[20,40,100,120]},
  {A:[[.25,0,6.625],[0,.5,-11.25],[0,0,1]],canonical:[12,9,32,49],original:[20,40,100,120]}
 ]){let drawn;const context={selectedCandidateId:null,$:()=>({contentWindow:{postMessage(){}}}),renderPhoto(){},frame:()=>({input_to_canonical_pixel_centres:sample.A}),drawRect:bounds=>{drawn=Array.from(bounds);},text(){},t:()=>'',document:{querySelectorAll:()=>[]},location:{origin:'http://localhost'}};
  vm.runInNewContext(selection,context);context.selectCandidate({id:'known-rectangle',frame_id:'frame_0004',label:'known rectangle',mask:{resolution:'canonical',bbox:sample.canonical},inventory_indices:[]});assert.deepEqual(drawn,sample.original,'canonical bbox edges must invert resize/crop edge coordinates, not pixel centres');
 }
}
async function check(engine){
 const browser=await ({webkit,chromium}[engine]).launch(engine==='chromium'?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{});
 try{
  const mobile=engine==='webkit',options=mobile?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{viewport:{width:1440,height:1000}},context=await browser.newContext(options),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(15000);await page.emulateMedia({reducedMotion:'reduce'});page.on('pageerror',error=>errors.push(error.message));
  const script=await context.request.get(base+'/workspace-assets/workspace.js');assert.equal(script.status(),200);checkPixelEdges(await script.text());
  await page.goto(base+'/reports');await page.waitForSelector('a.report-card');const reportCount=await page.locator('a.report-card').count();
  await hasText(page,'#library h1','每个工位');await language(page,'en');await hasText(page,'#library h1','A living report');await language(page,'zh');
  const report=page.locator(`a.report-card[href="/reports/${runId}"]`);assert.equal(await report.count(),1);await report.click();await page.waitForURL(base+'/reports/'+runId);await page.waitForSelector('.candidate',{state:'attached'});
  const response=await context.request.get(base+'/api/reports/'+runId);assert.equal(response.status(),200);const data=await response.json();assert.equal(await page.locator('.candidate').count(),data.evidence.candidates.length);assert(data.has_report,'BOR1 should retain its original report');
  await page.waitForFunction(()=>document.getElementById('inspection-frame').getAttribute('src')?.startsWith('/report/user-bor1-02?'));
  await page.waitForFunction(()=>customElements.get('deep-chat')&&document.getElementById('report-chat').shadowRoot?.childElementCount>0&&typeof document.getElementById('report-chat').connect?.handler==='function');
  assert(await page.locator('#report-chat').evaluate(chat=>!!chat.shadowRoot.querySelector('[contenteditable],textarea,input')),'DeepChat must render an actual input');
  await page.locator('[data-tab="objects"]').click();await page.selectOption('#photo-frame','frame_0004');
  const frame=data.evidence.frames.find(frame=>frame.frame_id==='frame_0004');assert(frame,'original fourth frame is present');
  const candidate=data.evidence.candidates.find(candidate=>candidate.frame_id===frame.frame_id&&candidate.mask?.bbox?.length===4&&candidate.inventory_indices.length);assert(candidate,'fourth frame has a measured candidate with mask evidence');
  const loaded=await page.evaluate(url=>new Promise(resolve=>{const img=new Image();img.onload=()=>resolve([img.naturalWidth,img.naturalHeight]);img.onerror=()=>resolve(null);img.src=url;}),frame.url);assert.deepEqual(loaded,[frame.width,frame.height]);
  await page.locator(`.candidate[data-id="${candidate.id}"]`).click();const selected=await snapshot(page);assert.equal(selected.frame,'frame_0004');assert.equal(selected.image,frame.url);assert.deepEqual(selected.selected,[candidate.id]);assert(selected.boxVisible);
  let bbox=candidate.mask.bbox;if(candidate.mask.resolution==='canonical'){const A=frame.input_to_canonical_pixel_centres;assert(A);bbox=bbox.map((edge,i)=>(edge-(A[i%2][2]+.5-.5*A[i%2][i%2]))/A[i%2][i%2]);}
  [bbox[0],bbox[1],bbox[2]-bbox[0],bbox[3]-bbox[1]].forEach((value,index)=>assert(Math.abs(value-Number(selected.box[index]))<1e-7));
  await language(page,'en');await hasText(page,'#object-count','records');assert.deepEqual(await snapshot(page),selected,'English switch preserves candidate, source photo and bbox');
  assert((await page.locator('#report-chat').evaluate(chat=>chat.textInput.placeholder.text)).includes('Ask a question'));
  await language(page,'zh');await hasText(page,'#object-count','条记录');assert.deepEqual(await snapshot(page),selected,'Chinese switch preserves candidate, source photo and bbox');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'workspace horizontal overflow');
  await page.locator('#correction-photo').evaluate(node=>node.scrollIntoView({block:'center',behavior:'instant'}));await page.screenshot({path:`/tmp/panoptes-workspace-${engine}-objects.png`});
  await page.locator('a.back').click();await page.waitForSelector('a.report-card');assert.equal(await page.locator('a.report-card').count(),reportCount);assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
  const session=await context.request.get(base+'/api/session');assert.equal(session.status(),200);const sessionData=await session.json();
  const readOnly=await browser.newContext(options),access=await readOnly.newPage();access.setDefaultTimeout(15000);await access.emulateMedia({reducedMotion:'reduce'});access.on('pageerror',error=>errors.push(error.message));
  // A local server without access restrictions still exercises the real 401 POST. Only its UI session role is simulated.
  if(sessionData.can_write)await access.route('**/api/session',route=>route.request().method()==='GET'?route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({can_write:false,requires_access:true})}):route.continue());
  await access.goto(base+'/reports');await access.waitForFunction(()=>window.panoptesSession?.canWrite===false&&!document.getElementById('unlock-workspace').hidden);
  await language(access,'en');await access.locator('#unlock-workspace').click();await access.locator('#access-code').fill('panoptes-qa-invalid-'+crypto.randomUUID());
  const rejected=access.waitForResponse(response=>response.url()===base+'/api/session'&&response.request().method()==='POST');await access.locator('#access-submit').click();assert.equal((await rejected).status(),401);await hasText(access,'#access-status','Invalid access code');assert(await access.locator('#access-status').isVisible());assert(!await access.locator('#access-submit').isDisabled());
  await access.locator('#close-access').click();await language(access,'zh');await access.locator('#unlock-workspace').click();await hasText(access,'#access-status','访问码无效');assert.equal(await access.evaluate(()=>panoptesSession.canWrite),false);assert(!await access.locator('#upload-dialog').isVisible());
  assert.deepEqual(errors,[]);console.log(JSON.stringify({engine,mobile,passed:true,historyReports:reportCount,candidates:data.evidence.candidates.length,preservedFrame:'frame_0004',preservedSelection:candidate.id,deepChatInput:true,invalidCodeStatus:401,readOnlyRoleSimulated:!!sessionData.can_write}));
 }finally{await browser.close();}
}
(async()=>{for(const engine of (process.env.ENGINES||'webkit,chromium').split(','))await check(engine);})().catch(error=>{console.error(error);process.exitCode=1;});
