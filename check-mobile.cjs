// Run: node check-mobile.cjs [installed playwright module path]
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {webkit}=require(process.argv[2]||'playwright');
const root=__dirname,mbps=Number(process.env.MODEL_MBPS)||0;
let corrupt=false;
let release,reportBlocked,blocked=false;const gate=new Promise(resolve=>release=resolve),blocking=new Promise(resolve=>reportBlocked=resolve);
const server=http.createServer(async(req,res)=>{
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\//,'')||'index.html';
  const file=path.resolve(root,name);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}
  // Both the old whole-scene loader and the new per-object loader face one stalled resource.
  if(name.endsWith('scene.bin.part4')||name.endsWith('/cart.bin.gz')){blocked=true;reportBlocked();await gate;}
  if(name==='scene.json'&&corrupt){const scene=JSON.parse(fs.readFileSync(file));scene.objects.find(o=>o.id==='cart').mesh.asset.sha256='0'.repeat(64);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(scene));return;}
  res.setHeader('Content-Type',name.endsWith('.js')?'application/javascript':name.endsWith('.html')?'text/html':name.endsWith('.json')?'application/json':'application/octet-stream');
  res.setHeader('Content-Length',fs.statSync(file).size);
  if(mbps&&!corrupt&&name.endsWith('.bin.gz')){for await(const chunk of fs.createReadStream(file,{highWaterMark:65536})){if(res.destroyed)break;res.write(chunk);await new Promise(resolve=>setTimeout(resolve,chunk.length*8/(mbps*1000)));}res.end();}
  else fs.createReadStream(file).pipe(res);
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await webkit.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const started=Date.now();await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>document.querySelectorAll('.object-row').length===10,null,{timeout:10000});
    // Draw calls count actual uploaded meshes, not a poster, spinner, or placeholder box.
    await page.waitForFunction(()=>Number(document.querySelector('canvas').dataset.loadedObjects)>0,null,{timeout:10000});
    const firstObjectMs=Date.now()-started;
    await page.getByRole('button',{name:'BOR1 00090 RB01 industrial robot 生成',exact:true}).click();
    const x=page.getByRole('spinbutton',{name:'位置（未标定尺度（非米）） X',exact:true});const before=await x.inputValue();
    await x.press('ArrowUp');assert.notEqual(await x.inputValue(),before);await page.getByRole('button',{name:'恢复此对象',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('canvas').dataset.loadedObjects==='9',null,{timeout:45000});
    let timer;try{await Promise.race([blocking,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('largest object request never started')),5000))]);}finally{clearTimeout(timer);}
    assert(blocked,'largest object request must still be pending');
    assert.match(await page.locator('#summary').textContent(),/9\s*\/\s*10/);
    await page.locator('#render-panel').screenshot({path:'/tmp/panoptes-mobile-progress.png'});
    release();await page.waitForFunction(()=>document.querySelector('canvas').dataset.loadedObjects==='10',null,{timeout:20000});
    await page.getByRole('combobox',{name:'视角',exact:true}).selectOption({label:'照片 3'});
    await page.getByRole('img',{name:'照片 3',exact:true}).waitFor({state:'visible',timeout:5000});
    assert.deepEqual(errors,[]);
    await page.locator('#render-panel').screenshot({path:'/tmp/panoptes-mobile-complete.png'});
    console.log(JSON.stringify({simulated_mbps:mbps||null,first_object_ms:firstObjectMs,complete_ms:Date.now()-started}));
    corrupt=true;await page.goto('http://127.0.0.1:'+server.address().port+'/?integrity-check=1');
    await page.waitForFunction(()=>document.querySelector('#status').classList.contains('error'),null,{timeout:15000});
    assert.equal(await page.locator('canvas').getAttribute('data-loaded-objects'),'9');
    assert.match(await page.locator('#summary').textContent(),/加载未完成/);
    assert.match(await page.locator('#status').textContent(),/完整性校验失败/);
    assert.equal(await page.getByRole('button',{name:'重新加载',exact:true}).isVisible(),true);
    // Lose the graphics context in the final animation frame, before completion resumes.
    corrupt=false;
    const lossPage=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    await lossPage.addInitScript(()=>{
      const raf=window.requestAnimationFrame;
      window.requestAnimationFrame=callback=>raf.call(window,time=>{
        const canvas=document.querySelector('canvas');
        if(canvas?.dataset.loadedObjects==='10'&&!window.injectedLoss){window.injectedLoss=true;canvas.getContext('webgl').getExtension('WEBGL_lose_context').loseContext();}
        callback(time);
      });
      new MutationObserver(()=>{if(window.injectedLoss&&document.querySelector('#status')?.textContent.includes('场景已完整加载'))window.falseComplete=true;}).observe(document,{subtree:true,childList:true,characterData:true});
    });
    await lossPage.goto('http://127.0.0.1:'+server.address().port);
    await lossPage.waitForFunction(()=>window.injectedLoss&&document.querySelector('#status').classList.contains('error'),null,{timeout:60000});
    assert.equal(await lossPage.evaluate(()=>!!window.falseComplete),false,'lost WebGL context must never report complete');
    assert.equal(await lossPage.getByRole('button',{name:'重新加载',exact:true}).isVisible(),true);
    console.log('PASS: mobile WebKit displays and edits full meshes while the last object is stalled, then completes all 10; corrupt last object stays visibly incomplete.');
  }finally{release();await browser.close();server.closeAllConnections();server.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;release();server.closeAllConnections();server.close();});
