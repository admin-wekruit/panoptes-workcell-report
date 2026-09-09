// Run: node check-playgrounds.cjs [installed Playwright module] [running report URL]
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const browsers=require(process.argv[2]||'playwright'),url=process.argv[3]||'http://127.0.0.1:8892/';
const trial=JSON.parse(fs.readFileSync(path.join(__dirname,'blender-scene.json')));
const components=JSON.parse(fs.readFileSync(path.join(__dirname,'components/scene.json')));
async function check(engine){
  const browser=await browsers[engine].launch({headless:true,timeout:20000,...(engine==='chromium'?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}: {})});
  try{
    const mobile=engine==='webkit',page=await browser.newPage(mobile?{viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2}:{viewport:{width:1440,height:1000}}),errors=[],missing=[],dialogs=[];
    page.setDefaultTimeout(10000);await page.emulateMedia({reducedMotion:'reduce'});
    page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{dialogs.push(d.type());d.dismiss();});
    page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('/favicon.ico'))missing.push(r.status()+' '+r.url());});
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});
    await page.waitForFunction(()=>document.querySelectorAll('.object-chip').length===10);
    const completed=[];
    for(const id of ['generated','observed','blender','components']){
      await page.locator(`[data-playground="${id}"]`).click();
      assert.equal(await page.locator('#playground-frame').getAttribute('src'),null,'switching playgrounds must unload the previous viewer');
      await page.waitForFunction(()=>document.querySelector('#playground-frame').contentWindow.location.href==='about:blank');
      await page.waitForFunction(()=>{const image=document.querySelector('#playground-preview');return !image.hidden&&image.complete&&image.naturalWidth>0;});
      const preview=await page.locator('#playground-preview').getAttribute('src');
      await page.locator('#explore-playground').click();await page.locator('#playground-frame').evaluate(node=>node.scrollIntoView({block:'center',behavior:'instant'}));
      const frame=await(await page.$('#playground-frame')).contentFrame();
      assert.equal(await page.locator('#playground-preview').isVisible(),false);
      if(id==='observed'){
        await frame.waitForFunction(()=>document.querySelector('canvas')?.dataset.meshLoaded==='true',null,{timeout:60000});
        assert.equal(await frame.locator('canvas').getAttribute('data-triangles'),'359983');
        await frame.locator('#views button').first().click();await frame.locator('#compare').click();
        await frame.locator('#wire').click();
        assert.equal(await frame.locator('#status').evaluate(el=>el.classList.contains('error')),false);
        completed.push({id,preview,triangles:359983});
      }else{
        const objects=id==='components'?components.objects.length:10;
        await frame.waitForFunction(count=>Number(document.querySelector('canvas')?.dataset.loadedObjects)===count,objects,{timeout:60000});
        assert(await frame.locator('header a').evaluateAll(links=>links.length>0&&links.every(a=>a.target==='_top')),'header links must leave the playground iframe');
        assert.equal(await frame.locator('#blender-report').isVisible(),id!=='components','Blender link must describe this scene');
        assert.match(await frame.locator('#scene-report').getAttribute('href'),id==='components'?/components\/metrics\.html$/:/\/metrics\.html$/);
        if(id==='blender'){
          assert.equal(await frame.locator('#scene-title').textContent(),trial.label);
          assert.equal(await frame.locator('#scene-description').textContent(),trial.description);
          assert.equal(await frame.locator('#object-list .badge.parametric').count(),2);
          assert.equal(await frame.locator('#glb').isVisible(),false,'the Blender trial must not offer the original generated GLB');
          for(const index of [0,1]){
            await frame.locator('#object-list .object-row button').nth(index).click();
            assert.match(await frame.locator('#provenance').textContent(),/参数化资产.*Blender/);
            assert.match(await frame.locator('#metrics-caption').textContent(),/参数化圆柱/);
            assert.equal((await frame.locator('#metrics').textContent()).includes('generated_refined'),false,'parameterized posts must not inherit RecGen pose metrics');
            assert.match(await frame.locator('#metrics-link').getAttribute('href'),/metrics\.html#blender$/);
          }
        }else if(id==='components'){
          assert.equal(await frame.locator('#scene-title').textContent(),components.label);
          assert.equal(await frame.locator('#scene-description').textContent(),components.description);
          assert.equal(await frame.locator('#object-list .badge.generated').count(),2);
          assert.equal(await frame.locator('#object-list .badge.observed').count(),1);
          for(let i=0;i<objects;i++){await frame.locator('#object-list .object-row button').nth(i).click();assert.equal(await frame.locator('#selection-overlay').getAttribute('data-object-id'),components.objects[i].id);assert.equal(await frame.locator('[data-bbox-edge]').count(),12);assert.equal(await frame.locator('[data-axis]').count(),3);}
        }else{assert.equal(await frame.locator('#scene-title').textContent(),'工位 · 对象场景编辑');assert.equal(await frame.locator('#glb').isVisible(),true);}
        await frame.locator('#object-list .object-row button').nth(id==='components'?0:3).click();
        assert.match(await frame.locator('#metrics').textContent(),/generated_refined/,'generated objects preserve their measured comparison record');
        assert.match(await frame.locator('#metrics-link').getAttribute('href'),/metrics\.html$/);
        const x=frame.locator('#position-0'),before=await x.inputValue();await x.press('ArrowUp');assert.notEqual(await x.inputValue(),before);
        // Leave this transform dirty: switching or closing must tear down the framed editor, without a hidden cancelled navigation.
        completed.push({id,preview,objects,parametric:id==='blender'?2:0});
      }
    }
    await page.locator('#playground-close').click();
    await page.waitForFunction(()=>document.querySelector('#playground-frame').contentWindow.location.href==='about:blank');
    assert.equal(await page.locator('#playground-frame').getAttribute('src'),null);assert.equal(await page.locator('#explore-playground').isVisible(),true);
    const sizes=await page.evaluate(()=>[document.documentElement.scrollWidth,document.documentElement.clientWidth]);assert(sizes[0]<=sizes[1]+1,'gallery causes horizontal page overflow');
    assert.deepEqual(errors,[]);assert.deepEqual(missing,[]);assert.deepEqual(dialogs,[],'switching or closing an edited playground must not open a native dialog');
    console.log(JSON.stringify({engine,mobile,playgrounds:completed,unloads_dirty_edits_on_switch:true,dialogs:dialogs.length,passed:true}));
  }finally{await browser.close();}
}
(async()=>{let failed=false;for(const engine of (process.env.ENGINES||'webkit,chromium').split(',')){try{await check(engine);}catch(e){failed=true;console.error(engine+': '+e.stack);}}if(failed)process.exitCode=1;})();
