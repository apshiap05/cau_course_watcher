const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
fs.mkdirSync('.preview', { recursive: true });
const base = 'file:///' + path.resolve('tests/panel-preview.html').replace(/\\/g,'/');
(async () => {
 const browser = await chromium.launch({channel:'chrome',headless:true,ignoreDefaultArgs:['--hide-scrollbars']});
 const errors = [];
 for (const variant of ['chrome','userscript']) {
  const page = await browser.newPage({viewport:{width:1440,height:1080}});
  page.on('pageerror',e=>errors.push(`${variant}: ${e.message}`));
  await page.addInitScript(() => { const raf=window.requestAnimationFrame; window.__frames=0; window.requestAnimationFrame=(fn)=>raf.call(window,(t)=>{window.__frames++;fn(t)}); });
  await page.goto(base + '?mode=multi&script='+variant);
  await page.waitForFunction(()=>document.body.dataset.glassMapReady==='true');
  await page.waitForTimeout(650);
  await page.screenshot({path:'.preview/liquid-glass-'+variant+'.png'});
  const panel = page.locator('#cau-course-watcher-panel');
  const verifyContentScroll = async () => {
    const geometry = await panel.evaluate(e => {
      const body = e.querySelector('.cau-cw-body');
      const header = e.querySelector('.cau-cw-header');
      const before = header.getBoundingClientRect();
      body.scrollTop = 200;
      const after = header.getBoundingClientRect();
      return {
        rootScroll: e.scrollHeight - e.clientHeight,
        bodyScroll: body.scrollHeight - body.clientHeight,
        scrollTop: body.scrollTop,
        headerTop: before.top - after.top,
        bodyTop: body.getBoundingClientRect().top,
        headerBottom: after.bottom,
        headerRight: after.right,
        panelRight: e.getBoundingClientRect().right,
      };
    });
    assert.ok(geometry.rootScroll <= 1, 'outer glass shell must not scroll');
    assert.ok(geometry.bodyScroll > 0 && geometry.scrollTop > 0, 'body must own vertical scrolling');
    assert.equal(geometry.headerTop, 0, 'header must stay fixed while body scrolls');
    assert.ok(geometry.bodyTop >= geometry.headerBottom - 1, 'scrollbar must begin below header');
    assert.ok(geometry.panelRight - geometry.headerRight <= 1.1, 'header must fill shell width');
    await page.locator('.cau-cw-body').evaluate(e => { e.scrollTop = 0; });
  };
  await verifyContentScroll();
  assert.equal(await panel.getAttribute('data-glass-optics'),'refraction');
  console.log(execFileSync(process.execPath,['tests/liquid-glass-render.test.cjs'],{input:await page.content(),encoding:'utf8'}).trim());
  for (const mode of ['multi','normal']) {
    if (mode==='normal') await page.locator('[data-mode="normal"]').click();
    // Fixture metadata is a startup snapshot; refresh it after an interactive mode change.
    if (mode==='normal') await page.goto(base+'?mode=normal&script='+variant);
    await page.waitForFunction(()=>document.body.dataset.cauPanelReady==='true');
    const result=execFileSync(process.execPath,['tests/panel-render.test.cjs',mode],{input:await page.content(),encoding:'utf8'});
    console.log(variant,result.trim());
  }
  await page.goto(base+'?mode=multi&script='+variant);
  await page.waitForFunction(()=>document.body.dataset.glassMapReady==='true');
  await page.waitForTimeout(650);
  const button=page.locator('#cau-cw-add-course');
  const box=await button.boundingBox();
  await page.mouse.move(box.x+box.width*.8,box.y+box.height*.6);
  await page.waitForTimeout(400);
  const glow=await panel.evaluate(e=>parseFloat(e.style.getPropertyValue('--glass-light')));
  assert.ok(glow>.9,'mouse glow should respond');
  assert.notEqual(await button.evaluate(e=>e.style.translate),'');
  await page.mouse.move(250,150);
  await page.waitForTimeout(1500);
  assert.equal(await button.evaluate(e=>e.style.translate),'');
  assert.ok(await panel.evaluate(e=>parseFloat(e.style.getPropertyValue('--glass-light')))<.01);
  const frames=await page.evaluate(()=>window.__frames);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>window.__frames),frames,'idle animation must stop');
  await button.click();
  assert.equal(await page.locator('.cau-cw-course-block').count(),3);
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.cau-cw-glass-ripple').count(),0);
  await page.locator('[data-remove-course="2"]').click();
  assert.equal(await page.locator('.cau-cw-course-block').count(),2);
  const surfaceBox=await panel.boundingBox();
  await page.mouse.move(surfaceBox.x+surfaceBox.width/2,surfaceBox.y+surfaceBox.height/2);
  await page.waitForTimeout(850);
  assert.ok(await panel.evaluate(e=>parseFloat(e.style.getPropertyValue('--glass-y'))<e.clientHeight),'glow must stay under pointer after scrolling');
  await page.mouse.move(700,300);
  await page.waitForTimeout(800);
  await page.screenshot({path:'.preview/liquid-glass-interaction-'+variant+'.png'});
  await page.locator('#cau-cw-collapse').click();
  assert.equal(await page.locator('.cau-cw-body').isVisible(),false);
  await page.locator('#cau-cw-collapse').click();
  assert.equal(await page.locator('.cau-cw-body').isVisible(),true);
  await page.goto(base+'?mode=multi&modal=1&script='+variant);
  await page.locator('.cau-cw-dialog').waitFor({state:'visible'});
  await page.waitForTimeout(650);
  assert.equal(await page.locator('.cau-cw-dialog').getAttribute('data-glass-optics'),'refraction');
  await page.screenshot({path:'.preview/liquid-glass-modal-'+variant+'.png'});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.mouse.move(1200,400);
  await page.waitForTimeout(200);
  assert.equal(await panel.evaluate(e=>e.style.getPropertyValue('--glass-light')),'0');
  assert.equal(await page.locator('.cau-cw-dialog').evaluate(e=>getComputedStyle(e).animationName),'none');
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
  await page.waitForTimeout(100);
  assert.equal(await panel.evaluate(e=>getComputedStyle(e).backdropFilter),'none');
  await cdp.send('Emulation.setEmulatedMedia',{features:[]});
  await page.waitForTimeout(100);
  assert.equal(await panel.getAttribute('data-glass-optics'),'refraction');
  // Exercise the non-Chromium fallback without reading or modifying any real website.
  const fallback=await browser.newPage({userAgent:'Mozilla/5.0 Firefox/130.0',viewport:{width:1280,height:900}});
  await fallback.goto(base+'?mode=normal&script='+variant);
  await fallback.waitForFunction(()=>document.body.dataset.glassReady==='true');
  assert.equal(await fallback.locator('#cau-course-watcher-panel').getAttribute('data-glass-optics'),'blur');
  await fallback.close();
  for (const width of [360,390,720,768]) {
    await page.setViewportSize({width,height:844});
    await page.goto(base+'?mode=normal&script='+variant);
    await page.waitForFunction(()=>document.body.dataset.glassMapReady==='true');
    await page.waitForTimeout(600);
    const dims=await panel.evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right}));
    assert.ok(dims.left>=0 && dims.right<=width && dims.scroll<=dims.width+1,JSON.stringify(dims));
    await verifyContentScroll();
    if(width===390) await page.screenshot({path:'.preview/liquid-glass-mobile-'+variant+'.png'});
    await page.evaluate(()=>{document.querySelector('#cau-course-watcher-modal').hidden=false});
    const dialogBox=await page.locator('.cau-cw-dialog').boundingBox();
    assert.ok(dialogBox.x>=0 && dialogBox.x+dialogBox.width<=width,'mobile dialog must fit viewport');
  }
  console.log(variant+': refraction, mouse, idle, ripple, add/remove, modal, reduced motion/transparency, fallback and 4 viewport sizes ok');
  await page.close();
 }
 const interaction=await browser.newPage();
 await interaction.goto('file:///'+path.resolve('tests/panel-interaction-preview.html').replace(/\\/g,'/'));
 await interaction.waitForFunction(()=>document.body.dataset.savedInterval==='12000');
 console.log(execFileSync(process.execPath,['tests/panel-interaction.test.cjs'],{input:await interaction.content(),encoding:'utf8'}).trim());
 const popup=await browser.newPage({viewport:{width:360,height:420}});
 popup.on('pageerror',e=>errors.push('popup: '+e.message));
 await popup.goto('file:///'+path.resolve('chrome-extension/popup.html').replace(/\\/g,'/'));
 await popup.waitForTimeout(500);
 assert.equal(await popup.locator('main').getAttribute('data-glass-ready'),'true');
 await popup.screenshot({path:'.preview/liquid-glass-popup.png'});
 assert.deepEqual(errors,[]);
 await browser.close();
 console.log('All offline browser checks passed; no page errors.');
})().catch(e=>{console.error(e);process.exit(1)});
