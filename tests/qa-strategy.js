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

const TEST = "(() => {\n const g=window.__ZRTS__,results=[];const ok=v=>{if(!v)throw Error('assertion failed')};const check=(name,fn)=>{try{fn();results.push({name,pass:true})}catch(e){results.push({name,pass:false,detail:e.message})}};\n g.zombies=[];g.clearSelection();const u=g.units[0];u.selected=true;\n check('touch strategy panel opens and applies guard stance',()=>{[...document.querySelectorAll('#tactical-orders button')].find(b=>b.textContent==='\u6218\u7565').click();ok(!document.getElementById('strategy-panel').hidden);document.getElementById('stance-choice').value='guard';document.getElementById('apply-stance').click();ok(u.stance==='guard')});\n check('guard reduces incoming damage by 25 percent',()=>{u.hp=u.maxHp;g.damagePlayerUnit(u,20);ok(u.hp===u.maxHp-15)});\n check('assault increases incoming damage by 25 percent',()=>{g.setSelectedStance('assault');u.hp=u.maxHp;g.damagePlayerUnit(u,20);ok(u.hp===u.maxHp-25)});\n const enemy=()=>({id:'strategy-test',alive:true,hp:1000,maxHp:1000,x:u.x,y:u.y,radius:10,armor:'flesh'});\n check('assault increases outgoing direct damage',()=>{const z=enemy();g.damageZombie(z,20,u,'bullet');ok(z.hp===975)});\n check('guard reduces outgoing direct damage',()=>{u.stance='guard';const z=enemy();g.damageZombie(z,20,u,'bullet');ok(z.hp===984)});\n check('balanced restores standard damage',()=>{u.stance='balanced';const z=enemy();g.damageZombie(z,20,u,'bullet');ok(z.hp===980)});\n const visible=g.isWorldVisible;g.isWorldVisible=()=>true;\n const near={...enemy(),x:10,y:0,type:'normal'},armor={...enemy(),x:50,y:0,type:'heavy',armor:'armor'},fast={...enemy(),x:30,y:0,type:'fast'},weak={...enemy(),x:40,y:0,hp:10};g.zombies=[near,armor,fast,weak];\n check('nearest remains default tower targeting',()=>ok(g.findPriorityTarget(0,0,100,'nearest')===near));\n check('armor priority selects heavy enemy',()=>ok(g.findPriorityTarget(0,0,100,'armor')===armor));\n check('fast priority selects fast enemy',()=>ok(g.findPriorityTarget(0,0,100,'fast')===fast));\n check('weak priority selects lowest health fraction',()=>ok(g.findPriorityTarget(0,0,100,'weak')===weak));\n check('priority cannot target out of range or hidden enemy',()=>{armor.x=200;ok(g.findPriorityTarget(0,0,100,'armor')!==armor);armor.x=50;g.isWorldVisible=x=>x!==50;ok(g.findPriorityTarget(0,0,100,'armor')!==armor)});g.isWorldVisible=visible;g.zombies=[];\n const b=g.commandCenter;g.clearSelection();g.selectBuilding(b);b.hp=b.maxHp*.5;g.resources.wood=500;g.resources.iron=500;g.repairCooldown=0;\n check('repair heals 30 percent and consumes exact resources',()=>{ok(g.emergencyRepair());ok(Math.abs(b.hp-b.maxHp*.8)<.01&&g.resources.wood===440&&g.resources.iron===460&&g.repairCooldown===45)});\n check('shared cooldown blocks repeated repair without spending',()=>{ok(!g.emergencyRepair());ok(g.resources.wood===440&&g.resources.iron===460)});\n check('cooldown advances with simulation time',()=>{g.update(1);ok(g.repairCooldown===44)});\n check('full health repair does not spend or start cooldown',()=>{g.repairCooldown=0;b.hp=b.maxHp;ok(!g.emergencyRepair());ok(g.resources.wood===440&&g.repairCooldown===0)});\n check('missing resources prevents repair',()=>{b.hp=b.maxHp*.5;g.resources.iron=0;ok(!g.emergencyRepair());ok(b.hp===b.maxHp*.5&&g.resources.wood===440)});\n check('priority setter rejects noncombat buildings',()=>{g.setSelectedPriority('armor');ok(!b.targetPriority)});\n check('tower fires at configured armor priority',()=>{const tower=new b.constructor({id:'qa-tower',type:'tower',x:0,y:0,spec:g.__specs.tower});const a={...enemy(),x:40,y:0,type:'heavy',armor:'armor'},n={...enemy(),x:20,y:0,type:'normal'};g.zombies=[n,a];g.isWorldVisible=()=>true;g.selectBuilding(tower);g.setSelectedPriority('armor');const hit=g.damageZombie;let actual=null;g.damageZombie=(target)=>{actual=target;return {dealt:0,killed:false}};try{tower.update(.1,g);ok(actual===a)}finally{g.damageZombie=hit;g.isWorldVisible=visible;g.zombies=[]}});\n check('repair clamps at max health',()=>{g.selectBuilding(b);b.hp=b.maxHp*.9;g.resources.wood=100;g.resources.iron=100;g.repairCooldown=0;ok(g.emergencyRepair());ok(b.hp===b.maxHp)});\n return results;\n})()\n";

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
