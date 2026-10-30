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

const TEST = "(() => {\n const g=window.__ZRTS__,results=[],ok=v=>{if(!v)throw Error('assertion failed')},check=(name,f)=>{try{f();results.push({name,pass:true})}catch(e){results.push({name,pass:false,detail:e.message})}};\n g.zombies=[];g.resources.wood=900;g.resources.stone=900;g.resources.iron=900;\n const b=new g.commandCenter.constructor({id:'qa-barracks',type:'barracks',x:g.commandCenter.x+150,y:g.commandCenter.y,spec:g.__specs.barracks});g.buildings.push(b);g.clearSelection();g.selectBuilding(b);\n const recruits={};\n for(const type of ['sniper','medic','shield'])check('touch training creates '+type+' with correct cost/time/weapon',()=>{g.selectBuilding(b);g.updateHud();const spec=g.__reinforcements[type],before=g.resources.iron,count=g.units.length;const button=document.getElementById('train-'+type);ok(!button.disabled);button.click();ok(b.trainingType===type&&b.trainingRemaining===spec.time&&g.resources.iron===before-spec.cost);b.update(spec.time,g);const u=g.units.at(-1);ok(g.units.length===count+1&&u.type===type&&u.maxHp===spec.hp&&u.weapon.damage===spec.weapon.damage&&u.weapon.attackType===spec.weapon.attackType);recruits[type]=u});\n check('insufficient iron blocks new troop without queueing',()=>{g.selectBuilding(b);g.resources.iron=0;g.trainInfantry('sniper');ok(b.trainingRemaining===0);g.resources.iron=900});\n check('medic heals one nearby living ally, not itself',()=>{const m=recruits.medic,s=recruits.shield;m.x=s.x=500;m.y=s.y=500;s.hp=60;m.hp=50;g.updatePlayerCombat(1);ok(s.hp===66&&m.hp===50)});\n check('medic cannot heal outside 110 range',()=>{const m=recruits.medic,s=recruits.shield;s.x=m.x+150;const hp=s.hp;g.updatePlayerCombat(1);ok(s.hp===hp)});\n check('shield reduces damage by 40 percent',()=>{const u=recruits.shield;u.hp=180;g.damagePlayerUnit(u,50);ok(u.hp===150)});\n check('new units support patrol, rally and control groups',()=>{g.clearSelection();for(const u of Object.values(recruits))u.selected=true;g.handleControlGroup('4',true);g.clearSelection();g.handleControlGroup('4',false);ok(g.getSelectedUnits().length===3);g.issueTacticalOrder('patrol',{x:600,y:600});ok(Object.values(recruits).every(u=>u.tacticalOrder.mode==='patrol'))});\n const built={};\n for(const type of ['mortar','workshop'])check(type+' builds through placement and construction flow',()=>{g.resources.wood=900;g.resources.stone=900;g.resources.iron=900;let point=null;for(let x=100;x<850&&!point;x+=40)for(let y=650;y<1150;y+=40){const p={x,y};if(g.getBuildingPlacement(type,p).valid){point=p;break;}}ok(point);g.beginBuildMode(type);const before=g.buildings.length;g.tryPlaceBuilding(point);ok(g.buildings.length===before+1);const obj=g.buildings.at(-1);ok(obj.type===type&&obj.isConstructing&&obj.buildRemaining>0);obj.update(20,g);ok(obj.isWorking&&obj.hp===obj.maxHp);built[type]=obj;ok(g.resources.iron===900-g.__specs[type].cost.iron)});\n check('workshop repairs damaged building within radius, not self',()=>{const w=built.workshop,t=built.mortar;t.x=w.x+90;t.y=w.y;t.hp=100;w.hp=100;const hp=t.hp;w.update(1,g);ok(t.hp===hp+5&&w.hp===100)});\n check('workshop cannot repair beyond radius or while under construction',()=>{const w=built.workshop,t=built.mortar;t.x=w.x+200;t.hp=100;w.update(1,g);ok(t.hp===100);t.x=w.x+80;w.isConstructing=true;w.buildRemaining=4;w.update(1,g);ok(t.hp===100);w.isConstructing=false});\n check('mortar deals blast splash to clustered enemies',()=>{const m=built.mortar;const near={id:'qa-z1',alive:true,x:m.x+50,y:m.y,hp:1000,maxHp:1000,armor:'swift',radius:10},other={...near,id:'qa-z2',x:near.x+20};g.zombies=[near,other];const vis=g.isWorldVisible;g.isWorldVisible=()=>true;try{m.cooldown=0;m.update(.1,g);ok(near.lastHitType==='blast'&&other.lastHitType==='blast'&&near.hp<1000&&other.hp<1000&&m.cooldown===3.2)}finally{g.isWorldVisible=vis;g.zombies=[]}});\n check('new unit and building sprites render without errors',()=>{const ctx=g.canvas.getContext('2d');for(const obj of [...Object.values(recruits),...Object.values(built)])obj.draw(ctx,performance.now());});\n return results;\n})()\n";

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
