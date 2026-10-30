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

const TEST = "(() => {\n const g=window.__ZRTS__, results=[];\n const check=(name,fn)=>{try{fn();results.push({name,pass:true})}catch(e){results.push({name,pass:false,detail:e.message})}};\n const ok=(v)=>{if(!v)throw Error('assertion failed')};\n g.zombies=[];g.clearSelection();const u=g.units[0];u.selected=true;\n const key=(code,ctrlKey=false)=>window.dispatchEvent(new KeyboardEvent('keydown',{code,ctrlKey,bubbles:true}));\n check('Ctrl+1 saves and 1 recalls selected living members',()=>{key('Digit1',true);u.selected=false;key('Digit1');ok(u.selected&&g.controlGroups[1].includes(u.id))});\n check('dead members are ignored on recall',()=>{const alive=u.alive;u.alive=false;g.handleControlGroup('1',false);u.alive=alive;ok(g.getSelectedUnits().includes(u))});\n check('P arms patrol and Escape cancels without clearing selection',()=>{key('KeyP');ok(g.tacticalMode==='patrol');key('Escape');ok(g.tacticalMode===null&&u.selected)});\n const end={x:u.x+80,y:u.y};\n check('patrol keeps both endpoints',()=>{g.issueTacticalOrder('patrol',end);ok(u.tacticalOrder.mode==='patrol'&&u.tacticalOrder.start.x===u.x)});\n check('patrol reverses at destination and loops at origin',()=>{const o=u.tacticalOrder;u.x=o.end.x;u.y=o.end.y;g.updateTacticalOrder(u);ok(o.returning);u.x=o.start.x;u.y=o.start.y;g.updateTacticalOrder(u);ok(!o.returning)});\n check('attack move stops for enemy and resumes after enemy leaves',()=>{g.issueTacticalOrder('attackMove',{x:u.x+120,y:u.y});const find=g.findNearestZombie;g.findNearestZombie=()=>({alive:true});try{g.updateTacticalOrder(u);ok(!u.moveTarget&&!!u.tacticalOrder)}finally{g.findNearestZombie=find}g.updateTacticalOrder(u);ok(!!u.moveTarget)});\n check('attack move completes at destination',()=>{u.x=u.tacticalOrder.end.x;u.y=u.tacticalOrder.end.y;g.updateTacticalOrder(u);ok(!u.tacticalOrder)});\n check('ordinary move replaces patrol',()=>{g.issueTacticalOrder('patrol',end);g.issueMoveOrder(end,[u]);ok(!u.tacticalOrder&&!!u.moveTarget)});\n check('H clears tactical, attack, movement and path state',()=>{g.issueTacticalOrder('patrol',end);key('KeyH');ok(!u.tacticalOrder&&!u.attackTarget&&!u.moveTarget&&!u.path&&!u.isMoving)});\n check('input typing does not trigger P',()=>{const input=document.getElementById('login-name');input.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyP',bubbles:true}));ok(!g.tacticalMode)});\n check('toolbar F button arms attack move',()=>{document.querySelector('[data-order=\"attackMove\"]').click();ok(g.tacticalMode==='attackMove');g.setTacticalMode(null)});\n check('command rally sends newly trained engineer to destination',()=>{g.commandCenter.rallyPoint={x:g.commandCenter.x+120,y:g.commandCenter.y+100};const before=g.units.length;g.spawnEngineerFromCommandCenter(g.commandCenter);ok(g.units.length===before+1);const recruit=g.units.at(-1);ok(recruit.moveTarget.x===g.commandCenter.rallyPoint.x)});\n check('rally marker renders without error',()=>{g.selectBuilding(g.commandCenter);g.drawMovementOrders(g.canvas.getContext('2d'),performance.now())});\n check('right click on map sets selected command center rally',()=>{g.clearSelection();g.selectBuilding(g.commandCenter);const rect=g.canvas.getBoundingClientRect();g.canvas.dispatchEvent(new MouseEvent('contextmenu',{clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,bubbles:true,cancelable:true}));ok(!!g.commandCenter.rallyPoint)});\n check('left click commits armed patrol and consumes targeting mode',()=>{g.clearSelection();u.selected=true;key('KeyP');const rect=g.canvas.getBoundingClientRect();g.canvas.dispatchEvent(new MouseEvent('mousedown',{button:0,clientX:rect.left+rect.width*.6,clientY:rect.top+rect.height*.6,bubbles:true,cancelable:true}));ok(u.tacticalOrder?.mode==='patrol'&&!g.tacticalMode)});\n check('new troops inherit barracks rally',()=>{const mock={x:g.commandCenter.x,y:g.commandCenter.y,width:60,trainingType:'infantry',rallyPoint:{x:200,y:200}};g.spawnInfantryFromBarracks(mock);ok(g.units.at(-1).moveTarget.x===200)});\n return results;\n})()\n";

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
    await send('Runtime.enable');
    await sleep(2600);
    const evaluated = await send('Runtime.evaluate', { expression: TEST, returnByValue: true });
    if (evaluated.result.exceptionDetails) {
      throw new Error(evaluated.result.exceptionDetails.exception?.description || 'evaluate failed');
    }
    const results = evaluated.result.result.value;
    for (const result of results) {
      console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ' :: ' + result.detail : ''}`);
    }
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
