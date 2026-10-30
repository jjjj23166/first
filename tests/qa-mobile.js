/* Stage 15: strategy systems — counters, economy decisions, wave pressure. */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = process.env.ZRTS_BROWSER || (process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : '/usr/bin/chromium');
const PORT = 9441;
const USER_DIR = path.join(os.tmpdir(), `zrts-strat-${Date.now()}`);
const PAGE_URL = (process.env.ZRTS_BASE_URL || 'http://127.0.0.1:8765') + '/game/index.html?debug=1&game=1&seed=31415926';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TEST = "(() => {\nconst g=window.__ZRTS__,r=[],ok=v=>{if(!v)throw Error('assertion failed')},check=(name,f)=>{try{f();r.push({name,pass:true})}catch(e){r.push({name,pass:false,detail:e.message})}};\nconst rect=()=>g.canvas.getBoundingClientRect();\nconst touch=(type,points)=>{const touches=points.map((p,i)=>new Touch({identifier:i,target:g.canvas,clientX:p[0],clientY:p[1]}));g.canvas.dispatchEvent(new TouchEvent(type,{touches:type==='touchend'?[]:touches,changedTouches:touches,bubbles:true,cancelable:true}));};\ncheck('mobile canvas fits viewport above toolbar',()=>{const b=rect(),bar=document.getElementById('tactical-orders').getBoundingClientRect();if(!(b.left>=0&&b.right<=innerWidth&&b.bottom<=bar.top))throw Error(JSON.stringify({b:b.toJSON(),bar:bar.toJSON(),w:innerWidth,h:innerHeight,padding:document.body.style.paddingBottom}))});\ncheck('touch drag pans camera',()=>{g.camera.x=500;g.camera.y=400;const b=rect();touch('touchstart',[[b.left+150,b.top+90]]);touch('touchmove',[[b.left+180,b.top+90]]);touch('touchend',[[b.left+180,b.top+90]]);ok(g.camera.x<500)});\ncheck('pinch increases zoom',()=>{const b=rect();g.camera.zoom=1;touch('touchstart',[[b.left+80,b.top+80],[b.left+140,b.top+80]]);touch('touchmove',[[b.left+60,b.top+80],[b.left+160,b.top+80]]);touch('touchend',[[b.left+60,b.top+80]]);ok(g.camera.zoom>1)});\ncheck('tap commits patrol from mobile button',()=>{g.clearSelection();g.units[0].selected=true;document.querySelector('[data-order=\"patrol\"]').click();const b=rect(),p=[b.left+b.width*.7,b.top+b.height*.6];touch('touchstart',[p]);touch('touchend',[p]);ok(g.units[0].tacticalOrder?.mode==='patrol'&&!g.tacticalMode)});\ncheck('touch cancel clears selection gesture',()=>{document.querySelector('[data-touch-box]').click();const b=rect();touch('touchstart',[[b.left+20,b.top+20]]);touch('touchcancel',[]);ok(!g.drag.active);document.querySelector('[data-touch-box]').click()});\ncheck('mobile rally button sets point without right mouse',()=>{g.clearSelection();g.selectBuilding(g.commandCenter);document.querySelector('[data-order=\"rally\"]').click();const b=rect(),p=[b.left+b.width*.6,b.top+b.height*.6];touch('touchstart',[p]);touch('touchend',[p]);ok(!!g.commandCenter.rallyPoint&&!g.tacticalMode)});\ncheck('touch group buttons save and recall',()=>{g.clearSelection();g.units[0].selected=true;const bar=document.getElementById('tactical-orders'),buttons=[...bar.querySelectorAll('button')];buttons.find(b=>b.textContent==='\u4fdd\u5b58\u961f').click();g.clearSelection();buttons.find(b=>b.textContent==='\u9009\u961f').click();ok(g.units[0].selected)});\nreturn r;\n})()";

(async () => {
  if (!fs.existsSync(EDGE)) throw new Error('Edge not found');
  const browser = spawn(EDGE, [...(process.env.ZRTS_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${USER_DIR}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1400,1000', PAGE_URL
  ], { stdio: 'ignore' });

  let ws;
  try {
    let page = null;
    for (let i = 0; i < 100; i++) {
      try {
        const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
        page = tabs.find((tab) => tab.type === 'page');
        if (page) break;
      } catch (error) { /* starting */ }
      await sleep(200);
    }
    if (!page) throw new Error('no page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    const pending = new Map();
    let serial = 0;
    await new Promise((resolve) => ws.addEventListener('open', resolve));
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = ++serial;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
    await send('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:1,mobile:true}); await send('Emulation.setTouchEmulationEnabled',{enabled:true}); await send('Runtime.enable');
    await sleep(2600);
    const evaluated = await send('Runtime.evaluate', { expression: TEST, returnByValue: true });
    if (evaluated.result.exceptionDetails) {
      throw new Error(evaluated.result.exceptionDetails.exception?.description || 'evaluate failed');
    }
    const results = evaluated.result.result.value;
    for (const result of results) {
      console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ' :: ' + result.detail : ''}`);
    }
    const shot=await send('Page.captureScreenshot',{format:'png'}); if(process.env.ZRTS_SCREENSHOT) fs.writeFileSync(process.env.ZRTS_SCREENSHOT,Buffer.from(shot.result.data,'base64'));
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (ws) ws.close();
    browser.kill();
    await sleep(300);
    try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  }
})().catch((error) => {
  console.error('QA error:', error.message);
  process.exitCode = 1;
});
