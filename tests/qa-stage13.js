/* Stage 13: river terrain + resource density regression. */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9411;
const USER_DIR = path.join(os.tmpdir(), `zrts-river-${Date.now()}`);
const PAGE_URL = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}?debug=1&seed=31415926`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TEST = String.raw`(() => {
  const g = window.__ZRTS__;
  const results = [];
  g.gameOver = 'qa';
  g.zombies = [];
  g.waveSpawnQueue = [];
  g.nextWaveIn = 9999;

  const check = (name, fn) => {
    try { fn(); results.push({ name, pass: true, detail: '' }); }
    catch (error) { results.push({ name, pass: false, detail: String(error && error.message || error) }); }
  };
  const ok = (value, message) => { if (!value) throw new Error(message); };

  check('river exists with bridges', () => {
    ok(g.river, 'river data not exposed');
    ok(g.river.samples.length > 30, 'river polyline too short');
    ok(g.river.bridges.length >= 2, 'expected at least 2 bridges, got ' + g.river.bridges.length);
    ok(g.river.width > 40, 'river width too small');
  });

  check('river blocks movement on open water', () => {
    const mid = g.river.samples[Math.floor(g.river.samples.length / 2)];
    ok(g.isWaterBlocking(mid.x, mid.y, 11), 'river centre should block units');
    ok(!g.isWaterBlocking(mid.x + 4000, mid.y, 11), 'far away land should not be water');
  });

  check('bridges are walkable', () => {
    for (const bridge of g.river.bridges) {
      ok(!g.isWaterBlocking(bridge.x, bridge.y, 11), 'bridge centre ' + bridge.id + ' should be walkable');
    }
  });

  check('a unit cannot cross the river away from a bridge', () => {
    const mid = g.river.samples[Math.floor(g.river.samples.length / 2)];
    const unit = g.units[0];
    unit.alive = true;
    unit.x = mid.x - g.river.width - 40;
    unit.y = mid.y;
    unit.moveTarget = null;
    for (let i = 0; i < 200; i++) g.tryMoveEntity(unit, 1.2, 0);
    ok(g.isWaterBlocking(unit.x + 6, unit.y, 0) === true || unit.x < mid.x - 20,
      'unit walked into the river (x=' + unit.x.toFixed(0) + ' centre=' + mid.x.toFixed(0) + ')');
  });

  check('units can walk across a bridge', () => {
    const bridge = g.river.bridges[0];
    const unit = g.units[0];
    unit.alive = true;
    unit.moveTarget = null;
    // 先在桥面上沿桥身方向走到桥心，确认桥面本身可站立
    unit.x = bridge.x;
    unit.y = bridge.y;
    ok(!g.isWaterBlocking(unit.x, unit.y, 11), 'bridge centre should be walkable');

    // 沿桥的垂直方向（过河方向）从河岸一侧走到另一侧的河岸
    const perpX = -Math.sin(bridge.angle);
    const perpY = Math.cos(bridge.angle);
    const span = g.river.width + 24;
    unit.x = bridge.x - perpX * (span * 0.5);
    unit.y = bridge.y - perpY * (span * 0.5);
    let travelled = 0;
    for (let i = 0; i < 400; i++) {
      const beforeX = unit.x;
      const beforeY = unit.y;
      g.tryMoveEntity(unit, perpX * 1.4, perpY * 1.4);
      travelled += Math.hypot(unit.x - beforeX, unit.y - beforeY);
      if (travelled > span) break;
    }
    ok(travelled > span * 0.85,
      'unit could not cross the bridge (travelled ' + travelled.toFixed(0) + ' of ' + span.toFixed(0) + ')');
  });

  check('resource density increased', () => {
    ok(g.resourceNodes.length >= 8, 'expected at least 8 resource nodes, got ' + g.resourceNodes.length);
    const types = new Set(g.resourceNodes.map((n) => n.resourceType));
    ok(types.has('wood') && types.has('stone') && types.has('iron'), 'all three resource types should exist');
  });

  check('resource nodes keep clear of deep water', () => {
    for (const node of g.resourceNodes) {
      ok(!g.isWaterBlocking(node.x, node.y, 17), 'resource node ' + node.id + ' sits in the river');
    }
  });

  check('resource nodes respect minimum spacing', () => {
    // 资源点改成 32px 单格后，间距约束也收紧到 76px（工厂 64×54 仍放得下）
    let closest = Infinity;
    for (let i = 0; i < g.resourceNodes.length; i++) {
      for (let j = i + 1; j < g.resourceNodes.length; j++) {
        closest = Math.min(closest, Math.hypot(
          g.resourceNodes[i].x - g.resourceNodes[j].x,
          g.resourceNodes[i].y - g.resourceNodes[j].y
        ));
      }
    }
    ok(closest >= 74, 'resource nodes too close together: ' + closest.toFixed(0) + 'px');
  });

  check('no resource node overlaps the base or a nest', () => {
    for (const node of g.resourceNodes) {
      ok(!(node.x > 146 - 70 && node.x < 146 + 312 + 70 && node.y > 772 - 70 && node.y < 772 + 238 + 70),
        'node ' + node.id + ' overlaps the base pad');
      for (const nest of g.spawnPoints) {
        ok(Math.hypot(node.x - nest.x, node.y - nest.y) >= 170, 'node ' + node.id + ' too close to ' + nest.id);
      }
    }
  });

  // 场景清理放到最后一组测试里做，不影响前面的资源点断言
  const clearBattlefield = () => {
    g.units = [];
    g.buildings = g.buildings.filter((b) => b.type === 'command');
    g.resourceNodes = [];
    g.zombies = [];
  };

  check('zombies detour to a bridge instead of deadlocking', () => {
    // 丧尸从桥的一侧河岸出发，目标在正对面（直线必经河水），
    // 但起点要选在"偏离桥面"的位置：桥面本身可通行，桥外的水面才会拦人。
    const across = (b) => ({ x: -Math.sin(b.angle), y: Math.cos(b.angle) });
    let bridge = null;
    let perpX = 0;
    let perpY = 0;
    let offset = 0;
    let reach = 0;
    for (const candidate of g.river.bridges) {
      const dir = across(candidate);
      const halfW = candidate.width * 0.5;
      // 沿桥两侧平移，找一个仍在深水阻挡范围内、但已离开桥面的偏移量
      for (const off of [halfW + 18, halfW + 30, halfW + 44]) {
        const cx = candidate.x + Math.cos(candidate.angle) * off;
        const cy = candidate.y + Math.sin(candidate.angle) * off;
        const far = candidate.width * 0.5 + 130;
        const ax = cx - dir.x * far;
        const ay = cy - dir.y * far;
        const bx = cx + dir.x * far;
        const by = cy + dir.y * far;
        if (g.isWaterBlocking(ax, ay, 12) || g.isWaterBlocking(bx, by, 12)) continue;
        if (ax < 40 || ax > g.worldBounds.width - 40 || ay < 40 || ay > g.worldBounds.height - 40) continue;
        if (bx < 40 || bx > g.worldBounds.width - 40 || by < 40 || by > g.worldBounds.height - 40) continue;
        // 中线必须被水挡住（说明不能直线走过去），桥面上则必须能过
        let blockedOnLine = false;
        for (let s = -far; s <= far; s += 6) {
          const px = cx + dir.x * s;
          const py = cy + dir.y * s;
          if (g.isWaterBlocking(px, py, 12)) blockedOnLine = true;
        }
        if (!blockedOnLine) continue;
        bridge = candidate; perpX = dir.x; perpY = dir.y; offset = off; reach = far;
        break;
      }
      if (bridge) break;
    }
    ok(bridge, 'no bridge with open water beside its deck');

    // 用真实资源点当目标：索敌校验只认 Unit/Building/ResourceNode，
    // 假对象会让丧尸立刻改换目标、绕过河走，测不到绕路逻辑。
    const baseX = bridge.x + Math.cos(bridge.angle) * offset;
    const baseY = bridge.y + Math.sin(bridge.angle) * offset;
    const goalX = baseX + perpX * reach;
    const goalY = baseY + perpY * reach;
    const goal = g.resourceNodes[0];
    goal.x = goalX;
    goal.y = goalY;
    goal.destroyed = false;
    for (const node of g.resourceNodes) {
      if (node !== goal) node.destroyed = true;
    }

    const zombie = g.spawnZombie('normal', baseX - perpX * reach, baseY - perpY * reach, {});
    // 尸潮自带行军路线会让丧尸沿公路走，这里清掉才能测"直冲河道被挡"的分支
    zombie.route = null;
    zombie.routeIndex = 0;
    zombie.target = goal;
    ok(!g.isWaterBlocking(zombie.x, zombie.y, zombie.radius), 'test start should be on land');

    let detoured = false;
    let sawWaterBlock = false;
    for (let i = 0; i < 1600; i++) {
      zombie.update(0.05, g);
      if (zombie.target !== goal) zombie.target = goal;
      if (zombie.terrainStuck) {
        sawWaterBlock = true;
        if (g.detourToBridge(zombie)) { detoured = true; break; }
        zombie.terrainStuck = false;
      }
    }
    ok(sawWaterBlock, 'zombie never got blocked by the river (pos ' + Math.round(zombie.x) + ',' + Math.round(zombie.y) + ')');
    ok(detoured, 'zombie never requested a bridge detour');
    ok(Array.isArray(zombie.route) && zombie.route.length > 0, 'detour route not stored');
    ok(!g.isWaterBlocking(zombie.route[0].x, zombie.route[0].y, zombie.radius), 'first detour waypoint should not be in water');
  });

  return results;
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



