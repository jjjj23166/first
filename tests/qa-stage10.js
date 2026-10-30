/* Stage 10 regression suite: three resources, factory gating and construction time.
 * Run with: node qa-stage10.js
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9361;
const USER_DIR = path.join(os.tmpdir(), `zrts-s10-${Date.now()}`);
const PAGE_URL = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}?debug=1`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TEST = String.raw`(() => {
  const g = window.__ZRTS__;
  const results = [];
  g.gameOver = 'qa';
  g.keys.clear();
  g.wavesPaused = true;
  g.zombies = [];
  g.waveSpawnQueue = [];
  g.nextWaveIn = 9999;

  const check = (name, fn) => {
    try { fn(); results.push({ name, pass: true, detail: '' }); }
    catch (error) { results.push({ name, pass: false, detail: String(error && error.message || error) }); }
  };
  const ok = (value, message) => { if (!value) throw new Error(message); };
  const eq = (actual, expected, message) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(message + ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')');
    }
  };
  const reset = () => {
    g.buildings = g.buildings.filter((b) => b.type === 'command');
    g.selectBuilding(null);
    g.buildMode = null;
    g.buildGhost = null;
    g.wallDrag = null;
    g.resources = { wood: 500, stone: 500, iron: 500 };
    for (const node of g.resourceNodes) {
      node.destroyed = false;
      node.hp = node.maxHp;
      node.factory = null;
      node.state = 'neutral';
      node.progress = 0;
    }
    // 沙盒区域：围墙拖拽测试需要一块没有静态设施的空地
    g.units = [];
    // 建筑被清空后必须让导航网格失效，否则寻路还会把已拆除的工厂当成障碍，
    // 后续的放置校验会误判为"位置被占用"而把工厂放到别处。
    g.invalidateNav();
    g.ensureNavGrid();
  };

  check('three independent resource pools replace metal', () => {
    ok(g.resources && typeof g.resources.wood === 'number', 'wood pool missing');
    ok(g.resources && typeof g.resources.stone === 'number', 'stone pool missing');
    ok(g.resources && typeof g.resources.iron === 'number', 'iron pool missing');
    eq(g.metal, undefined, 'legacy metal field should be gone');
  });

  check('resource nodes carry one of three resource types', () => {
    const types = new Set(g.resourceNodes.map((node) => node.resourceType));
    for (const type of types) ok(['wood', 'stone', 'iron'].includes(type), 'unknown resource type ' + type);
    ok(types.size >= 2, 'resource layout should mix resource types');
  });

  check('factory cannot be placed away from its resource node', () => {
    reset();
    const node = g.resourceNodes.find((n) => n.resourceType === 'wood');
    ok(node, 'no wood node');
    const far = { x: node.x + 400, y: node.y + 300 };
    const result = g.getBuildingPlacement('lumber', far);
    ok(!result.valid, 'lumber factory was allowed far from the wood node');
  });

  check('factory placed beside the matching node starts production', () => {
    reset();
    const node = g.resourceNodes.find((n) => n.resourceType === 'wood');
    const otherWood = g.resourceNodes.filter((n) => n !== node && n.resourceType === 'wood');
    // 工厂直接盖在资源点上：点在资源点附近会自动吸附到正中心
    const near = { x: node.x + 20, y: node.y };
    const placement = g.getBuildingPlacement('lumber', near);
    ok(placement.valid, 'lumber factory placement rejected: ' + placement.reason);
    ok(Math.abs(placement.x - placement.resourceNode.x) < 0.01 &&
       Math.abs(placement.y - placement.resourceNode.y) < 0.01,
      'factory should snap onto the resource node centre');
    g.beginBuildMode('lumber');
    g.tryPlaceBuilding(near);
    const factory = g.buildings.find((b) => b.type === 'lumber');
    ok(factory, 'lumber factory was not created');
    ok(factory.resourceNode === node, 'factory bound to the wrong node');
    ok(node.factory === factory, 'node does not reference its factory');
    ok(factory.isConstructing, 'new factory should start under construction');
    eq(factory.hp, Math.round(factory.maxHp * 0.3), 'construction HP should be 30%');

    // 施工中的工厂不参与产出
    g.resetEconomyWindow();
    ok(g.income.wood <= otherWood.length * 7 + 0.001, 'construction factory must not contribute income (got ' + g.income.wood + ')');
    eq(node.isProducing, false, 'node with construction factory must not be producing');

    g.updateBuildings(5);
    eq(factory.isConstructing, false, 'factory did not finish after 5 seconds');
    g.resetEconomyWindow();
    ok(g.income.wood >= 7 - 0.01, 'completed factory should contribute wood income (got ' + g.income.wood + ')');
    ok(node.isProducing, 'node should produce after factory completion');
    const before = g.resources.wood;
    g.updateEconomy(2);
    ok(g.resources.wood > before, 'wood did not increase after the factory completed');
  });

  check('second factory on the same node is rejected', () => {
    reset();
    // 资源点间距只有 76px，±90 会吸附到邻点；两次都点在同一个资源点上
    const node = g.resourceNodes.find((n) => n.resourceType === 'wood');
    g.beginBuildMode('lumber');
    g.tryPlaceBuilding({ x: node.x, y: node.y });
    g.beginBuildMode('lumber');
    g.tryPlaceBuilding({ x: node.x + 12, y: node.y + 8 });
    eq(g.buildings.filter((b) => b.type === 'lumber').length, 1, 'only one lumber factory per node is allowed');
    ok(node.factory, 'the node should keep its single factory binding');
  });

  check('factory ignores the wrong resource type node', () => {
    reset();
    const stone = g.resourceNodes.find((n) => n.resourceType === 'stone');
    if (stone) {
      const placement = g.getBuildingPlacement('lumber', { x: stone.x + 60, y: stone.y });
      ok(!placement.valid || placement.resourceNode.resourceType === 'wood',
        'lumber factory must link to a wood node only');
    }
  });

  check('wall segments build in parallel after the 2s timer', () => {
    reset();
    g.resourceNodes = [];
    g.resources = { wood: 500, stone: 500, iron: 500 };
    g.beginBuildMode('wall');
    g.startWallDrag({ x: 520, y: 210 });
    g.updateWallDrag({ x: 680, y: 210 });
    g.commitWallBuild();
    const walls = g.buildings.filter((b) => b.type === 'wall');
    ok(walls.length >= 6, 'expected at least 6 wall segments, got ' + walls.length);
    ok(walls.every((wall) => wall.isConstructing), 'walls should start under construction');
    ok(walls.every((wall) => Math.abs(wall.buildTotal - 2) < 0.001), 'wall build time should be 2s');

    g.updateBuildings(1.2);
    ok(walls.every((wall) => wall.isConstructing), 'walls finished too early');
    g.updateBuildings(1.0);
    ok(walls.every((wall) => !wall.isConstructing), 'all walls should finish in parallel after 2s');
  });

  check('towers and barracks occupy their scheduled build times', () => {
    reset();
    g.resourceNodes = [];
    eq(g.buildings.filter((b) => b.type === 'tower').length, 0, 'sandbox should start without towers');
    g.beginBuildMode('tower');
    const placement = g.getBuildingPlacement('tower', { x: 520, y: 260 });
    ok(placement.valid, 'tower placement rejected: ' + placement.reason);
    g.tryPlaceBuilding({ x: 520, y: 260 });
    const tower = g.buildings.find((b) => b.type === 'tower');
    ok(tower, 'tower not created');
    eq(tower.buildTotal, 6, 'tower build time');
    g.updateBuildings(6.1);
    ok(!tower.isConstructing, 'tower should finish after 6s');
  });

  check('construction buildings cannot shoot or train', () => {
    reset();
    g.beginBuildMode('barracks');
    g.tryPlaceBuilding({ x: 580, y: 1300 });
    const barracks = g.buildings.find((b) => b.type === 'barracks');
    ok(barracks.isConstructing, 'barracks should be under construction');
    g.selectBuilding(barracks);
    const ironBefore = g.resources.iron;
    g.trainInfantry();
    eq(g.resources.iron, ironBefore, 'training should not start in a building under construction');
    eq(barracks.trainingRemaining, 0, 'training timer should stay at zero');
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



