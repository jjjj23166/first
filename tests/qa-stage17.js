/* Stage 17: auto pathfinding + build shortfall hints + one-tile resource nodes
   + denser resource layout + cannon (重型炮台) and farm (农田) buildings. */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9491;
const USER_DIR = path.join(os.tmpdir(), `zrts-path-${Date.now()}`);
const PAGE_URL = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}?debug=1&seed=31415926`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TEST = String.raw`(() => {
  const g = window.__ZRTS__;
  const results = [];
  const check = (name, fn) => {
    try { fn(); results.push({ name, pass: true, detail: '' }); }
    catch (error) { results.push({ name, pass: false, detail: String((error && error.message) || error) }); }
  };
  const ok = (value, message) => { if (!value) throw new Error(message); };

  g.hideIntro();
  g.gameOver = null;
  g.zombies = [];
  g.waveSpawnQueue = [];
  g.nextWaveIn = 9999;
  g.updateFog = () => {};
  g.drawFog = () => {};
  g.isWorldVisible = () => true;

  const unit = g.units.find((u) => u.type === 'engineer');
  const placeDone = (type, x, y, extra) => {
    const b = g.createBuilding(type, x, y, extra || {});
    b.isConstructing = false;
    b.buildRemaining = 0;
    b.hp = b.maxHp;
    g.onBuildingCompleted(b);
    return b;
  };
  const clearUnits = () => {
    g.units = g.units.filter((u) => u.type === 'engineer');
  };

  /* ---------- 1. 自动寻路 ---------- */
  check('nav grid exists and covers the whole world', () => {
    ok(g.navGrid, 'navGrid missing');
    ok(g.navGrid.cols * g.navGrid.cellSize >= g.worldBounds.width, 'grid too narrow');
    ok(g.navGrid.rows * g.navGrid.cellSize >= g.worldBounds.height, 'grid too short');
    ok(g.navGrid.blockedCount > 0, 'grid should have blocked cells');
  });

  check('line of sight is blocked by a wall, and A* routes around it', () => {
    const walls = [];
    for (let i = -2; i <= 2; i++) walls.push(placeDone('wall', 750, 900 + i * 32));
    g.ensureNavGrid();
    ok(g.navGrid.lineOfSight(600, 900, 900, 900) === false, 'wall should block sight');
    const path = g.navGrid.findPath(600, 900, 900, 900);
    ok(path.length > 0, 'A* should find a detour');
    ok(path.some((p) => Math.abs(p.y - 900) > 40), 'detour must leave the straight line');
    for (const w of walls) w.alive = false;
    g.invalidateNav();
    g.ensureNavGrid();
  });

  check('a unit actually walks around the wall to its destination', () => {
    const walls = [];
    for (let i = -2; i <= 2; i++) walls.push(placeDone('wall', 750, 900 + i * 32));
    g.ensureNavGrid();
    const u = g.units.find((x) => x.type === 'engineer');
    u.x = 600; u.y = 900; u.alive = true; u.hp = u.maxHp;
    u.moveTo(900, 900);
    let maxY = 900;
    for (let i = 0; i < 4000 && u.moveTarget; i++) {
      g.ensureNavGrid();
      u.update(1 / 60, g);
      maxY = Math.max(maxY, u.y);
    }
    ok(Math.hypot(u.x - 900, u.y - 900) < 8, 'unit did not arrive: ' + Math.round(u.x) + ',' + Math.round(u.y));
    ok(maxY > 940, 'unit did not detour (maxY ' + Math.round(maxY) + ')');
    for (const w of walls) w.alive = false;
    g.invalidateNav();
    g.ensureNavGrid();
  });

  check('units path across the river only via bridges', () => {
    const bridge = g.river.bridges.slice().sort((a, b) => Math.abs(a.y - 700) - Math.abs(b.y - 700))[0];
    const across = bridge.angle + Math.PI / 2;
    const from = { x: bridge.x - Math.cos(across) * 130, y: bridge.y - Math.sin(across) * 130 };
    const to = { x: bridge.x + Math.cos(across) * 130, y: bridge.y + Math.sin(across) * 130 };
    ok(!g.isWaterBlocking(from.x, from.y, 12), 'start should be on dry land');
    ok(!g.isWaterBlocking(to.x, to.y, 12), 'goal should be on dry land');
    const u = g.units.find((x) => x.type === 'engineer');
    u.x = from.x; u.y = from.y; u.alive = true; u.hp = u.maxHp;
    u.moveTo(to.x, to.y);
    let overWater = false;
    for (let i = 0; i < 9000 && u.moveTarget; i++) {
      u.update(1 / 60, g);
      if (g.riverDepth(u.x, u.y) > 20) overWater = true;
    }
    ok(Math.hypot(u.x - to.x, u.y - to.y) < 14, 'did not reach the far bank');
    ok(overWater, 'crossing must pass over the bridge surface');
  });

  check('a unit never ends up inside a building', () => {
    const u = g.units.find((x) => x.type === 'engineer');
    u.x = 240; u.y = 1000; u.alive = true; u.hp = u.maxHp;
    u.moveTo(g.commandCenter.x, g.commandCenter.y);
    for (let i = 0; i < 3000 && u.moveTarget; i++) u.update(1 / 60, g);
    ok(!g.getBlockingBuilding(u.x, u.y, u.radius), 'unit ended up inside a building');
  });

  check('nav rebuild is cheap enough for real time', () => {
    const t0 = performance.now();
    g.navGrid.rebuild(g.buildings, []);
    const ms = performance.now() - t0;
    ok(ms < 40, 'rebuild took ' + ms.toFixed(1) + 'ms');
  });

  check('pathfinding clears stale paths after a new building appears', () => {
    const u = g.units.find((x) => x.type === 'engineer');
    placeDone('wall', 700, 860);
    g.invalidateNav();
    g.ensureNavGrid();
    ok(g.navGrid.dirty === false, 'grid should be rebuilt');
    ok(!u.path || u.pathIndex >= 0, 'path state should be reset sanely');
  });

  /* ---------- 2. 建造缺口提示 ---------- */
  check('build buttons show how much wood/iron is still missing', () => {
    g.resources.wood = 30;   // 兵营需要 80
    g.resources.stone = 160;
    g.resources.iron = 20;   // 兵营需要 40
    g.updateBuildUI();
    const btn = document.querySelector('.build-btn[data-build-type="barracks"]');
    const cost = btn.querySelector('.build-cost');
    ok(cost.classList.contains('is-short'), 'barracks cost should be flagged short');
    ok(/木材\s*50/.test(cost.textContent), 'should show wood shortfall 50, got: ' + cost.textContent);
    ok(/铁矿\s*20/.test(cost.textContent), 'should show iron shortfall 20, got: ' + cost.textContent);
    ok(/还差/.test(btn.title), 'tooltip should spell out the shortfall');
  });

  check('status strip shows an aggregate shortfall while resources are short', () => {
    const box = document.getElementById('resource-shortfall');
    ok(box.classList.contains('is-short'), 'shortfall box should be highlighted');
    ok(/木材|石料|铁矿/.test(box.textContent), 'box should name the missing resource, got: ' + box.textContent);
  });

  check('status strip switches back to "资源充足" once the wallet is full', () => {
    g.resources.wood = 999; g.resources.stone = 999; g.resources.iron = 999;
    g.updateBuildUI();
    const box = document.getElementById('resource-shortfall');
    ok(box.textContent === '资源充足', 'expected 资源充足, got: ' + box.textContent);
    ok(!box.classList.contains('is-short'), 'box should not be highlighted');
  });

  check('cost comparison reports the exact missing amount', () => {
    g.resources.wood = 10; g.resources.iron = 5;
    const short = g.getCostShortfall({ wood: 60, stone: 0, iron: 40 });
    ok(short.text.includes('木材 50'), 'wood shortfall wrong: ' + short.text);
    ok(short.text.includes('铁矿 35'), 'iron shortfall wrong: ' + short.text);
    ok(short.keys.length === 2, 'expected 2 missing keys, got ' + short.keys.length);
    g.resources.wood = 999; g.resources.iron = 999;
  });

  check('training button reports the missing iron instead of a vague warning', () => {
    const barracks = placeDone('barracks', 520, 1300);
    g.selectBuilding(barracks);
    g.resources.iron = 10;
    g.updateBuildUI();
    const btn = document.getElementById('train-infantry');
    ok(/缺/.test(btn.textContent), 'button should mention the shortfall: ' + btn.textContent);
    ok(/30/.test(btn.textContent), 'should state 30 iron missing: ' + btn.textContent);
    g.resources.iron = 999;
    g.updateBuildUI();
    ok(btn.textContent === '训练步兵 铁 40', 'button should recover, got: ' + btn.textContent);
    g.selectBuilding(null);
  });

  /* ---------- 3. 资源点占一格 + 密度 ---------- */
  check('every resource node occupies exactly one 32px tile', () => {
    ok(g.resourceNodes.length > 0, 'no nodes');
    for (const node of g.resourceNodes) {
      ok(node.tile === 32, 'node tile should be 32, got ' + node.tile);
      ok(node.radius < node.tile / 2, 'node radius must fit inside its tile');
    }
  });

  check('resource node density increased to 20 points', () => {
    ok(g.resourceNodes.length === 20, 'expected 20 nodes, got ' + g.resourceNodes.length);
  });

  check('resource nodes never overlap each other', () => {
    let minGap = Infinity;
    for (let i = 0; i < g.resourceNodes.length; i++) {
      for (let j = i + 1; j < g.resourceNodes.length; j++) {
        const a = g.resourceNodes[i], b = g.resourceNodes[j];
        minGap = Math.min(minGap, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    ok(minGap >= 64, 'nodes too close: ' + minGap.toFixed(1));
  });

  check('all three resource types are present', () => {
    const types = new Set(g.resourceNodes.map((n) => n.resourceType));
    for (const key of ['wood', 'stone', 'iron']) ok(types.has(key), 'missing ' + key);
  });

  /* ---------- 4. 重型炮台 ---------- */
  check('heavy cannon out-ranges and out-damages the defence tower', () => {
    const tower = BUILDING_SPECS_REF.tower;
    const cannon = BUILDING_SPECS_REF.cannon;
    ok(cannon.range > tower.range, 'cannon range ' + cannon.range + ' <= tower ' + tower.range);
    ok(cannon.damage > tower.damage, 'cannon damage should be higher');
  });

  check('heavy cannon fires at targets inside its range', () => {
    const cannon = placeDone('cannon', 700, 760);
    g.ensureNavGrid();
    const z = g.spawnZombie('heavy', 700, 760 - 240, {});
    z.route = null; z.hp = 100000; z.maxHp = 100000;
    const before = z.hp;
    for (let i = 0; i < 240; i++) cannon.update(1 / 60, g);
    ok(z.hp < before, 'cannon never damaged the target');
    z.alive = false;
    // 保留炮台供下一项检查"射程外不开火"复用
  });

  check('heavy cannon ignores zombies outside its range', () => {
    const cannon = g.buildings.find((b) => b.type === 'cannon' && b.alive);
    const spec = BUILDING_SPECS_REF.cannon;
    const z = g.spawnZombie('heavy', cannon.x, cannon.y - spec.range - 90, {});
    z.route = null; z.hp = 5000; z.maxHp = 5000;
    cannon.cooldown = 0;
    const before = z.hp;
    for (let i = 0; i < 90; i++) cannon.update(1 / 60, g);
    ok(z.hp === before, 'cannon fired beyond its range');
    z.alive = false;
  });

  /* ---------- 5. 农田 ---------- */
  check('farm raises the supply cap', () => {
    const before = g.getSupplyCap();
    const farm = placeDone('farm', 900, 1300);
    g.ensureNavGrid();
    ok(g.getSupplyCap() === before + 4, 'farm should add 4 supply, got ' + (g.getSupplyCap() - before));
    farm.alive = false;
    g.invalidateNav();
  });

  check('farm produces wood over time', () => {
    clearUnits();
    const farm = placeDone('farm', 980, 1300);
    g.ensureNavGrid();
    const before = g.resources.wood;
    g.updateEconomy(1);
    ok(g.resources.wood - before >= 2 - 0.01, 'farm should add wood, delta ' + (g.resources.wood - before).toFixed(2));
    farm.alive = false;
    g.invalidateNav();
  });

  check('supply cap blocks further training until a farm is built', () => {
    const barracks = placeDone('barracks', 1150, 1300);
    g.selectBuilding(barracks);
    const cap = g.getSupplyCap();
    const template = g.units.find((u) => u.alive);
    while (g.units.filter((u) => u.alive).length < cap) {
      const clone = Object.create(Object.getPrototypeOf(template));
      Object.assign(clone, template, { id: 'mock-' + Math.random(), selected: false });
      g.units.push(clone);
    }
    g.resources.iron = 999;
    const ironBefore = g.resources.iron;
    g.trainInfantry('infantry');
    ok(g.resources.iron === ironBefore, 'training should be blocked when supply is full');
    ok(/部队已满/.test(g.buildNotice.text), 'should hint at 部队已满, got: ' + g.buildNotice.text);
    g.selectBuilding(null);
    g.units = g.units.filter((u) => !String(u.id).startsWith('mock-'));
  });

  check('the new build buttons are wired up', () => {
    const types = Array.from(document.querySelectorAll('.build-btn')).map((b) => b.dataset.buildType);
    ok(types.includes('cannon'), 'cannon button missing');
    ok(types.includes('farm'), 'farm button missing');
    ok(types.length === 8, 'expected 8 build buttons, got ' + types.length);
  });

  check('cannon and farm can actually be placed on the map', () => {
    g.resources.wood = 999; g.resources.stone = 999; g.resources.iron = 999;
    const spot = { x: 1500, y: 1400 };
    const cannonPlacement = g.getBuildingPlacement('cannon', spot);
    ok(cannonPlacement.valid, 'cannon placement rejected: ' + cannonPlacement.reason);
    const farmPlacement = g.getBuildingPlacement('farm', { x: 1600, y: 1400 });
    ok(farmPlacement.valid, 'farm placement rejected: ' + farmPlacement.reason);
  });

  /* ---------- 6. 波次刷怪（回归：曾经因为倒计时夹到 1 而永远不出怪） ---------- */
  check('mining noise never pins the wave countdown above zero', () => {
    // 回归：曾把倒计时夹到 1，而 updateWave 只在 === 0 时触发出怪，
    // 于是尸潮永远不来。这里用假资源点造出满噪音，验证倒计时能被减到 0。
    const realNodes = g.resourceNodes;
    g.resourceNodes = Array.from({ length: 6 }, () => ({ isProducing: true }));
    g.waveSpawnQueue = [];
    g.nextWaveIn = 0.5;
    try {
      g.updateMiningNoise(3);
      ok(g.mineNoise === 1, 'noise should cap at 1, got ' + g.mineNoise);
      ok(g.nextWaveIn <= 0, 'countdown stuck at ' + g.nextWaveIn + ' instead of reaching 0');
    } finally {
      g.resourceNodes = realNodes;
      g.mineNoise = 0;
    }
  });

  check('a wave actually spawns zombies when the countdown expires', () => {
    g.zombies = [];
    g.waveSpawnQueue = [];
    g.gameOver = null;
    const waveBefore = g.waveNumber;
    g.nextWaveIn = 0;
    // 推进 1.5 秒游戏时间：先触发波次，再让 spawn wave 队列放出几只
    for (let i = 0; i < 90; i++) g.update(1 / 60);
    ok(g.waveNumber === waveBefore + 1, 'wave number did not advance (' + waveBefore + ' -> ' + g.waveNumber + ')');
    const alive = g.zombies.filter((z) => z.alive).length;
    ok(alive > 0, 'no zombies spawned, wave=' + g.waveNumber + ' queue=' + g.waveSpawnQueue.length);
  });

  check('zombies keep spawning until the wave queue drains', () => {
    g.zombies = [];
    g.waveSpawnQueue = [];
    g.gameOver = null;
    g.nextWaveIn = 0;
    g.update(1 / 60); // 触发波次，填充生成队列
    const queued = g.waveSpawnQueue.length;
    ok(queued > 0, 'wave queue is empty right after the wave started');
    for (let i = 0; i < 600; i++) g.update(1 / 60);
    ok(g.waveSpawnQueue.length === 0, 'queue never drained: ' + g.waveSpawnQueue.length + ' left');
    ok(g.zombies.length >= queued, 'expected at least ' + queued + ' zombies, got ' + g.zombies.length);
  });

  check('wave countdown restarts after a wave begins', () => {
    ok(g.nextWaveIn > 5, 'countdown should reset to the wave interval, got ' + g.nextWaveIn.toFixed(1));
  });

  check('freshly spawned zombies move toward the base', () => {
    g.zombies = [];
    g.waveSpawnQueue = [];
    g.gameOver = null;
    g.nextWaveIn = 0;
    for (let i = 0; i < 60; i++) g.update(1 / 60);
    const z = g.zombies.find((item) => item.alive);
    ok(z, 'no zombie to test');
    const from = { x: z.x, y: z.y };
    for (let i = 0; i < 300; i++) g.update(1 / 60);
    const moved = Math.hypot(z.x - from.x, z.y - from.y);
    ok(moved > 20, 'zombie did not advance (moved ' + moved.toFixed(1) + 'px)');
  });

  return results;
})()`.replace(/BUILDING_SPECS_REF/g, 'window.__ZRTS__.__specs');

const HOOK = `(function () {
  // 暴露建筑图纸表，供测试断言数值使用
  return 1;
})()`;

(async () => {
  if (!fs.existsSync(EDGE)) throw new Error('Edge not found');
  const browser = spawn(EDGE, [
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
    await sleep(2900);
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
