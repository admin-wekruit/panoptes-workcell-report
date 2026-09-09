// Run with the report server running: node check-unified-report.cjs [Playwright module] [URL]
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const playwright=require(process.argv[2]||'playwright'),url=process.argv[3]||'http://127.0.0.1:8892/';
const data=JSON.parse(fs.readFileSync(path.join(__dirname,'unified-data.json'))),ids=data.objects.map(o=>o.id);
const mappings={left_post:[15,21],right_post:[16,22],right_fence:[13,19]};
assert.deepEqual(Object.fromEntries(data.objects.filter(o=>o.inventory_indices.length).map(o=>[o.id,o.inventory_indices])),mappings,'preserve the six verified legacy correspondences');
async function run(engine){
  const browser=await playwright[engine].launch({headless:true,timeout:20000,...(engine==='chromium'?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}: {})});
  try{
    const mobile=engine==='webkit',page=await browser.newPage(mobile?{viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2}:{viewport:{width:1440,height:1000}}),errors=[],badResponses=[];
    await page.emulateMedia({reducedMotion:'reduce'});
    page.setDefaultTimeout(7000);
    page.on('pageerror',e=>errors.push(e.message));page.on('response',response=>{if(response.status()>=400&&!response.url().endsWith('/favicon.ico'))badResponses.push(response.status()+' '+response.url());});
    await page.addInitScript(()=>{window.integrationEvents=[];addEventListener('panoptes-selection',e=>integrationEvents.push(e.detail));});
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});
    await page.waitForFunction(()=>document.querySelectorAll('.object-chip').length===10,null,{timeout:20000});
    await page.locator('#workspace').scrollIntoViewIfNeeded();
    await page.locator('#model-viewer').scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.querySelector('#model-viewer')?.contentDocument?.querySelectorAll('.object-row').length===10,null,{timeout:20000});
    const child=page.frames().find(f=>f.url().includes('/viewer.html'));
    assert(child,'3D viewer iframe initialized');
    assert.equal(await page.locator('#legacy-inventory tbody tr').count(),37);assert.equal(await page.locator('#findings .finding').count(),9);
    async function selection(id){
      await page.waitForFunction(({id,index})=>{
        const selected=selector=>document.querySelector(selector)?.closest('[data-object-id]')?.dataset.objectId||null;
        const doc=document.querySelector('#model-viewer').contentDocument,rows=[...doc.querySelectorAll('.object-row')];
        return selected('.object-chip[aria-pressed="true"]')===id&&selected('#photo-view .selected')===id&&selected('#cad-view .selected')===id&&selected('#plan-view .selected')===id&&rows.findIndex(row=>row.classList.contains('active'))===index;
      },{id,index:id===null?-1:ids.indexOf(id)},{timeout:7000});
    }
    async function camera(frameId){
      await page.waitForFunction(id=>document.querySelector('#photo-select').value===id&&document.querySelector('#model-viewer').contentDocument.querySelector('#camera').value===id,frameId,{timeout:7000});
      const frame=data.frames.find(f=>f.id===frameId);assert.match(await page.locator('#photo-caption').textContent(),new RegExp(frame.label));
    }
    await page.locator('#photo-select').selectOption('frame_0003');await camera('frame_0003');
    // All ten objects must be selectable from each of the three SVG panels, with the fourth view following.
    for(const panel of ['photo-view','cad-view','plan-view'])for(const id of ids){
      await page.locator(`#${panel} [data-object-id="${id}"]`).press('Enter');await selection(id);
    }
    for(const frame of data.frames){await page.locator('#photo-select').selectOption(frame.id);await camera(frame.id);}
    for(const frame of data.frames){await child.locator('#camera').selectOption(frame.id);await camera(frame.id);}
    for(const choice of ['top','overview']){await child.locator('#camera').selectOption(choice);assert.equal(await page.locator('#photo-select').inputValue(),'frame_0003');}
    // Selecting an object absent from the current photo automatically switches both photo and 3D camera.
    for(const [frameId,id] of [['frame_0002','right_fence'],['frame_0001','left_fence'],['frame_0002','observed_floor']]){
      await page.locator('#photo-select').selectOption(frameId);await camera(frameId);
      await page.locator(`#cad-view [data-object-id="${id}"]`).press('Enter');await selection(id);await camera('frame_0003');
    }
    await page.locator('.inventory-details>summary').click();
    for(const [id,invs] of Object.entries(mappings))for(const inv of invs){
      await page.locator(`#legacy-cad [data-inv="${inv}"]`).press('Enter');await selection(id);
      assert.deepEqual(await page.locator('#legacy-inventory tr.active').evaluateAll(rows=>rows.map(row=>Number(row.dataset.inv)).sort((a,b)=>a-b)),invs);
      await page.getByRole('button',{name:'选择检测记录'+inv,exact:true}).click();await selection(id);
    }
    await page.locator('#legacy-cad [data-inv="0"]').press('Enter');await selection(null);
    assert.deepEqual(await page.locator('#legacy-cad .selected').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.inv))),[0]);
    await page.getByRole('button',{name:'选择检测记录15',exact:true}).click();await selection('left_post');
    await page.getByRole('button',{name:'选择检测记录5',exact:true}).click();await selection(null);
    assert.deepEqual(await page.locator('#legacy-inventory tr.active').evaluateAll(rows=>rows.map(row=>Number(row.dataset.inv))),[5]);
    assert.equal(await page.locator('#legacy-cad .selected').count(),0,'an unmapped inventory item must not retain a prior CAD highlight');
    assert.match(await page.locator('#legacy-cad-note').textContent(),/#5.*没有可靠/);
    await page.locator('#model-viewer').scrollIntoViewIfNeeded();
    await child.waitForFunction(()=>document.querySelector('canvas').dataset.loadedObjects==='10',null,{timeout:60000});
    await child.locator('#camera').selectOption('overview');
    const canvas=child.locator('canvas');await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();let picked=null;
    await page.evaluate(()=>integrationEvents=[]);
    for(const y of [.5,.35,.65,.2,.8]){for(const x of [.5,.35,.65,.2,.8]){
      await canvas.click({position:{x:box.width*x,y:box.height*y}});
      picked=await page.evaluate(()=>integrationEvents.find(e=>e.source==='3d'&&e.objectId)?.objectId||null);
      if(picked)break;
    }if(picked)break;}
    assert(ids.includes(picked),'a real 3D ray pick must reach the report');await selection(picked);
    const size=await page.evaluate(()=>({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth}));
    assert(size.scrollWidth<=size.width+1,'page has horizontal overflow: '+JSON.stringify(size));
    assert.deepEqual(errors,[],'uncaught browser errors');assert.deepEqual(badResponses,[],'missing public report assets');
    await page.locator('#workspace').screenshot({path:'/tmp/panoptes-unified-'+engine+'.png'});
    console.log(JSON.stringify({engine,mobile,objects:ids.length,svg_selection_paths:ids.length*3,legacy_inventory:37,findings:9,verified_legacy_ids:Object.values(mappings).flat(),real_3d_pick:picked,horizontal_overflow:size.scrollWidth-size.width,passed:true}));
  }finally{await browser.close();}
}
(async()=>{let failed=false;for(const engine of (process.env.ENGINES||'webkit,chromium').split(',')){try{await run(engine);}catch(error){failed=true;console.error(engine+': '+error.stack);}}if(failed)process.exitCode=1;})();
