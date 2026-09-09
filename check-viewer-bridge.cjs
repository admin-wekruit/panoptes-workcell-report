// Run: node check-viewer-bridge.cjs [installed Playwright module path]
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {webkit}=require(process.argv[2]||'playwright');
const root=__dirname,scene=JSON.parse(fs.readFileSync(path.join(root,'scene.json')));
let releaseScene,releaseCart;
const sceneGate=new Promise(resolve=>releaseScene=resolve),cartGate=new Promise(resolve=>releaseCart=resolve);
const harness=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><iframe id="viewer" name="viewer" style="width:calc(100vw - 32px);max-width:800px;height:560px" src="viewer.html?embedded=1"></iframe><iframe name="sibling" srcdoc="<!doctype html><title>sibling</title>" hidden></iframe><script>window.events=[];addEventListener('message',e=>{if(e.origin===location.origin&&e.source===document.querySelector('#viewer').contentWindow)events.push(e.data)});document.querySelector('#viewer').onload=()=>window.frameLoaded=true;</script>`;
const server=http.createServer(async(req,res)=>{
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1);
  if(name==='harness.html'){res.setHeader('Content-Type','text/html');res.end(harness);return;}
  const file=path.resolve(root,name);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
  if(name==='scene.json')await sceneGate;
  if(name.endsWith('/cart.bin.gz'))await cartGate;
  res.setHeader('Content-Type',name.endsWith('.html')?'text/html':name.endsWith('.js')?'application/javascript':name.endsWith('.json')?'application/json':'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await webkit.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:'+server.address().port+'/harness.html');
    await page.waitForFunction(()=>window.frameLoaded);
    const frame=page.frame({name:'viewer'}),cameraId=scene.cameras[2].id;
    const send=message=>page.evaluate(m=>document.querySelector('#viewer').contentWindow.postMessage(m,location.origin),message);
    // Messages arrive while scene.json itself is still blocked, before IDs or controls exist.
    for(const m of [{type:'panoptes:select',objectId:'left_post'},{type:'panoptes:select',objectId:'robot'},{type:'panoptes:select',objectId:'foreign-object'},{type:'panoptes:camera',cameraId:'top'},{type:'panoptes:camera',cameraId},{type:'panoptes:camera',cameraId:'foreign-camera'}])await send(m);
    await frame.waitForFunction(()=>pendingMessages.length===6);
    releaseScene();
    await page.waitForFunction(()=>events.some(e=>e.type==='panoptes:ready'));
    assert.deepEqual(await page.evaluate(()=>events.find(e=>e.type==='panoptes:ready').objectIds),scene.objects.map(o=>o.id));
    const selected=()=>frame.locator('.object-row.active button').textContent();
    assert.match(await selected(),/BOR1 00090 RB01/);
    assert.equal(await frame.locator('#camera').inputValue(),cameraId);
    assert.equal(await page.evaluate(()=>events.filter(e=>e.type==='panoptes:selection'||e.type==='panoptes:camera-selection').length),0,'incoming selection or camera must not echo');
    assert.equal(await frame.locator('header').isVisible(),false);assert.equal(await frame.locator('aside').isVisible(),false);assert.equal(await frame.locator('#photo-panel').isVisible(),false);
    await send({type:'panoptes:select',objectId:null});await frame.waitForFunction(()=>!document.querySelector('.object-row.active'));
    await send({type:'panoptes:select',objectId:'robot'});await frame.waitForFunction(()=>document.querySelector('.object-row.active button')?.textContent.includes('BOR1'));
    await send({type:'panoptes:select',objectId:123});await send({type:'panoptes:select',objectId:'foreign-object'});
    await page.frame({name:'sibling'}).evaluate(()=>parent.document.querySelector('#viewer').contentWindow.postMessage({type:'panoptes:select',objectId:'left_post'},parent.location.origin));
    // Exercise the origin check independently of the source check.
    await frame.evaluate(()=>dispatchEvent(new MessageEvent('message',{source:parent,origin:'https://untrusted.invalid',data:{type:'panoptes:select',objectId:'left_post'}})));
    await frame.waitForFunction(()=>document.querySelector('canvas').dataset.loadedObjects==='9',null,{timeout:20000});
    assert.match(await selected(),/BOR1 00090 RB01/);assert.equal(await page.evaluate(()=>events.filter(e=>e.type==='panoptes:selection').length),0);
    await send({type:'panoptes:camera',cameraId:'overview'});
    await frame.waitForFunction(()=>document.querySelector('#camera').value==='overview');
    // Exercise the actual canvas picking handler while cart remains blocked.
    const canvas=frame.locator('canvas'),box=await canvas.boundingBox();let picked=null;
    for(const y of [.5,.35,.65,.2,.8]){for(const x of [.5,.35,.65,.2,.8]){
      await canvas.click({position:{x:box.width*x,y:box.height*y}});
      picked=await page.evaluate(()=>events.filter(e=>e.type==='panoptes:selection'&&e.objectId).at(-1)?.objectId||null);
      if(picked)break;
    }if(picked)break;}
    assert(scene.objects.some(o=>o.id===picked),'canvas picking must send an allowlisted object ID');
    releaseCart();await frame.waitForFunction(()=>document.querySelector('canvas').dataset.loadedObjects==='10',null,{timeout:20000});
    assert.equal(await page.evaluate(()=>events.filter(e=>e.type==='panoptes:ready').length),1,'ready must be sent once per initialization');
    await page.evaluate(()=>{events=[];document.querySelector('#viewer').src='viewer.html';});
    await page.waitForFunction(()=>events.some(e=>e.type==='panoptes:ready'));
    assert.equal(await frame.getByRole('link',{name:'← 总报告',exact:true}).getAttribute('href'),'index.html');
    await frame.getByRole('button',{name:'BOR1 00090 RB01 industrial robot 生成',exact:true}).click();
    await page.waitForFunction(()=>events.some(e=>e.type==='panoptes:selection'&&e.objectId==='robot'));
    await frame.getByRole('button',{name:'恢复原始场景',exact:true}).click();
    await page.waitForFunction(()=>events.some(e=>e.type==='panoptes:selection'&&e.objectId===null));
    await frame.getByRole('combobox',{name:'视角',exact:true}).selectOption(scene.cameras[1].id);
    await page.waitForFunction(id=>events.some(e=>e.type==='panoptes:camera-selection'&&e.cameraId===id),scene.cameras[1].id);
    assert.deepEqual(errors,[]);
    console.log('PASS: WebKit bridge queues early selection/camera, rejects unknown IDs/origin/source, suppresses inbound echo, sends real mesh picks and local UI selection, and preserves standalone editing.');
  }finally{releaseScene();releaseCart();await browser.close();server.closeAllConnections();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;releaseScene();releaseCart();server.closeAllConnections();server.close();});
