// Run: node observed/check-observed.cjs [installed Playwright path] [report base URL]
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const pw=require(process.argv[2]||'playwright'),base=process.argv[3]||'http://127.0.0.1:8892/';
(async()=>{
 const checks=[];
 for(const engine of ['chromium','webkit']){
  const mobile=engine==='webkit',browser=await pw[engine].launch({headless:true,...(!mobile?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}: {})});
  try{
   const page=await browser.newPage(mobile?{viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2}:{viewport:{width:1440,height:1000}}),errors=[],failed=[];
   page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('/favicon.ico'))failed.push(r.url());});
   await page.goto(new URL('observed/',base).href,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>document.querySelector('canvas')?.dataset.meshLoaded==='true',null,{timeout:60000});
   assert.equal(await page.locator('canvas').getAttribute('data-triangles'),'359983');
   assert.equal(await page.locator('#views button').count(),2);
   assert.equal(await page.locator('a[href="../#playgrounds"]').count(),1);
   for(const label of ['照片 3','照片 4']){
    await page.getByRole('button',{name:label,exact:true}).click();
    await page.getByRole('button',{name:'原图对照',exact:true}).click();
    await page.waitForFunction(()=>{const p=document.querySelector('#photo');return !document.querySelector('#reference').hidden&&p.complete&&p.naturalWidth>0;});
    assert.equal(await page.locator('#compare').getAttribute('aria-pressed'),'true');
    await page.getByRole('button',{name:'原图对照',exact:true}).click();
   }
   await page.getByRole('button',{name:'整体视图',exact:true}).click();
   const canvas=page.locator('canvas'),before=await canvas.screenshot({path:path.join(__dirname,mobile?'mobile-preview.png':'preview.png')});
   await page.getByRole('button',{name:'线框',exact:true}).click();
   assert.equal(await page.locator('#wire').getAttribute('aria-pressed'),'true');
   assert(!before.equals(await canvas.screenshot()),'Wireframe must alter actual canvas pixels');
   await page.getByRole('button',{name:'实体',exact:true}).click();
   const box=await canvas.boundingBox();assert(box.width>150&&box.height>150,'Canvas must have usable dimensions');
   await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.55,{steps:8});await page.mouse.up();
   assert(!before.equals(await canvas.screenshot()),'Orbit must alter actual canvas pixels');
   if(!mobile){const rotated=await canvas.screenshot();await page.mouse.wheel(0,-160);assert(!rotated.equals(await canvas.screenshot()),'Zoom must alter actual canvas pixels');}
   assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
   checks.push({engine,mobile_emulation:mobile,triangles:359983,canvas_size:[box.width,box.height],camera_photo_comparison:true,wireframe:true,orbit:true,zoom:mobile?'not exercised: mobile WebKit wheel unsupported':true,page_errors:errors,failed_assets:failed});
  }finally{await browser.close();}
 }
 fs.writeFileSync(path.join(__dirname,'verification.json'),JSON.stringify(checks,null,2)+'\n');
 console.log(JSON.stringify(checks));
})().catch(e=>{console.error(e);process.exit(1);});
