/* Stage 9 regression suite: unit overlap + wall drag build.
 * Run with: node qa-stage9.js
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9351;
const USER_DIR = path.join(os.tmpdir(), `zrts-s9-${Date.now()}`);
const PAGE_URL = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}?debug=1`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TEST = String.raw`(() => {
  const g = window.__ZRTS__;
  const results = [];
  g.gameOver = 'qa';
  g.keys.clear();

  const check = (name, fn) => {
    try { fn(); results.push({ name, pass: true, detail: '' }); }
    catch (error) { results.push({ name, pass: false, detail: String(error && error.message || error) }); }
  };
  const ok = (value, message) => { if (!value) throw new Error(message); };
  const eq = (actual, expected, message) => {
    if (actual !== expected) throw new Error(message + ' (expected ' + expected + ', got ' + actual + ')');
  };

  // 搭建一个干净的前哨基地，并在开阔地放 8 名士兵
  const openField = [];
  for (let i = 0; i < 8; i++) {
    const isEngineer = i % 2 === 0;
    const unit = g.units[isEngineer ? 0 : Math.min(1, g.units.length - 1)];
    const clone = Object.assign(Object.create(Object.getPrototypeOf(unit)), unit);
    clone.id = 'tester-' + i;
    clone.name = '测试单位-' + i;
    clone.type = isEngineer ? 'engineer' : 'infantry';
    clone.team = 'player';
    clone.alive = true;
    clone.selected = false;
    clone.attackTarget = null;
    clone.attackCooldown = 0;
    clone.moveTarget = null;
    clone.isMoving = false;
    clone.weapon = isEngineer
      ? { damage: 4, range: 92, interval: 1.25 }
      : { damage: 12, range: 138, interval: 0.72 };
    clone.x = 300 + (i % 4) * 4;
    clone.y = 560 + Math.floor(i / 4) * 4;
    openField.push(clone);
  }
  g.units = openField;
  g.buildings = [];
  g.zombies = [];
  g.waveSpawnQueue = [];
  g.selectBuilding(null);

  check('8 soldiers never collapse into one stack', () => {
    for (let frame = 0; frame < 240; frame++) {
      g.separateGroup(g.units);
      for (const unit of g.units) unit.update(0.05, g);
    }
    let worst = Infinity;
    for (let i = 0; i < g.units.length; i++) {
      for (let j = i + 1; j < g.units.length; j++) {
        const d = Math.hypot(g.units[i].x - g.units[j].x, g.units[i].y - g.units[j].y);
        worst = Math.min(worst, d);
      }
    }
    ok(worst >= 18, 'closest pair distance ' + worst.toFixed(2) + ' is below the 18px spacing target');
  });

  check('units that are ordered into the same spot push apart', () => {
    for (const unit of g.units) unit.moveTo(640, 560);
    for (let frame = 0; frame < 160; frame++) {
      for (const unit of g.units) unit.update(0.05, g);
      g.separateGroup(g.units);
    }
    let worst = Infinity;
    for (let i = 0; i < g.units.length; i++) {
      for (let j = i + 1; j < g.units.length; j++) {
        const d = Math.hypot(g.units[i].x - g.units[j].x, g.units[i].y - g.units[j].y);
        worst = Math.min(worst, d);
      }
    }
    ok(worst >= 18, 'soldiers still overlapped after a group order (min distance ' + worst.toFixed(2) + ')');
  });

  check('separateGroup resolves a fully stacked group', () => {
    for (const unit of g.units) {
      unit.x = 900;
      unit.y = 560;
      unit.moveTarget = null;
    }
    for (let frame = 0; frame < 6; frame++) g.separateGroup(g.units);
    let worst = Infinity;
    for (let i = 0; i < g.units.length; i++) {
      for (let j = i + 1; j < g.units.length; j++) {
        const d = Math.hypot(g.units[i].x - g.units[j].x, g.units[i].y - g.units[j].y);
        worst = Math.min(worst, d);
      }
    }
    ok(worst > 8, 'stacked soldiers did not separate (min distance ' + worst.toFixed(2) + ')');
  });

  check('drag-building a wall lays multiple connected wall segments', () => {
    // 清空单位与旧建筑，在开阔地带测试纯拖拽行为
    g.units = [];
    g.buildings = [];
    g.buildMode = null;
    g.buildGhost = null;
    g.wallDrag = null;
    g.resources = { wood: 500, stone: 500, iron: 500 };
    g.resourceNodes = [];
    g.beginBuildMode('wall');
    ok(g.buildMode === 'wall', 'build mode did not enter wall');
    g.startWallDrag({ x: 700, y: 760 });
    g.updateWallDrag({ x: 860, y: 760 });
    ok(g.buildGhost && Array.isArray(g.buildGhost.tiles) && g.buildGhost.tiles.length >= 6,
      'ghost preview should show multiple tiles, got ' + (g.buildGhost && g.buildGhost.tiles && g.buildGhost.tiles.length));
    g.commitWallBuild();
    const walls = g.buildings.filter((b) => b.type === 'wall');
    eq(walls.length, 6, 'wall segments built by a 160px drag');
    ok(Math.abs(g.resources.wood - 428) < 0.001 && Math.abs(g.resources.stone - 452) < 0.001,
      'wall resources spent for six walls, wood=' + g.resources.wood + ' stone=' + g.resources.stone);
    ok(walls.every((wall) => wall.isConstructing), 'walls should start as construction sites');
  });

  check('wall drag ignores tiles that are blocked', () => {
    const before = g.buildings.filter((b) => b.type === 'wall').length;
    g.startWallDrag({ x: 700, y: 760 });
    g.updateWallDrag({ x: 790, y: 760 });
    const validTiles = g.buildGhost ? g.buildGhost.tiles.filter((tile) => tile.valid).length : 0;
    eq(validTiles, 0, 'tiles overlapping existing walls should be invalid');
    g.commitWallBuild();
    eq(g.buildings.filter((b) => b.type === 'wall').length, before, 'no wall should be built on occupied tiles');
  });

  return results;
})()`;

(async () => {
  if (!fs.existsSync(EDGE)) throw new Error('Edge not found');
  const browser = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${USER_DIR}`, '--no-first-run', '--disable-gpu', '--window-size=1400,1000', PAGE_URL
  ], { stdio: 'ignore' });

  let ws;
  try {
    let page = null;
    for (let i = 0; i < 75; i++) {
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
    await sleep(2200);
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

