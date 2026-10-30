/* QA harness: Edge headless + Chrome DevTools Protocol.
 * Run with: node qa-core-loop.js
 * It loads index.html?debug=1 and checks the three P0 priority features.
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = __dirname;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9337;
const USER_DIR = path.join(os.tmpdir(), `zrts-qa-${Date.now()}`);
const PAGE_URL = `file:///${path.join(ROOT, 'index.html').replace(/\\/g, '/')}?debug=1`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEndpoint() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json`);
      const tabs = await response.json();
      const page = tabs.find((tab) => tab.type === 'page');
      if (page) return page;
    } catch (error) {
      // Browser is still starting.
    }
    await sleep(200);
  }
  throw new Error('CDP endpoint did not become ready');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let serial = 0;

    ws.addEventListener('open', () => {
      const send = (method, params = {}) => new Promise((res, rej) => {
        const id = ++serial;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
      resolve({ ws, send });
    });
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        return;
      }
      if (!message.id) return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.rej(new Error(JSON.stringify(message.error)));
      else waiter.res(message.result);
    });
    ws.addEventListener('error', reject);
  });
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

async function waitForGame(send) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const ready = await evaluate(send, 'Boolean(window.__ZRTS__)').catch(() => false);
    if (ready) return;
    await sleep(250);
  }
  throw new Error('Game debug object was not exposed');
}

const TEST_EXPRESSION = String.raw`(() => {
  const results = [];
  const g = window.__ZRTS__;
  g.gameOver = 'qa';
  g.keys.clear();

  const check = (name, fn) => {
    try {
      fn();
      results.push({ name, pass: true, detail: '' });
    } catch (error) {
      results.push({ name, pass: false, detail: String(error && error.message || error) });
    }
  };
  const ok = (value, message) => { if (!value) throw new Error(message); };
  const eq = (actual, expected, message) => {
    if (actual !== expected) throw new Error(message + ' (expected ' + expected + ', got ' + actual + ')');
  };

  check('P0-1 wave starts at a near-base map edge', () => {
    g.waveSpawnQueue = [];
    g.nextWaveIn = 0;
    g.startNextWave();
    ok(g.waveSpawnQueue.length > 0, 'startNextWave produced no queue');
    for (let i = 0; i < 6; i++) g.spawnWaveZombie();
    const waveZombies = g.zombies.filter((z) => z.alive && z.route);
    const z = waveZombies[waveZombies.length - 1];
    ok(z, 'wave zombies have no march route');
    ok(z.x < 120, 'wave zombie spawned at x=' + z.x + ', not near the west edge');
    ok(g.currentWaveApproach && g.currentWaveApproach.name, 'missing approach direction label');
  });

  check('P0-1 wave follows the road toward the command center', () => {
    const z = g.zombies.filter((item) => item.alive && item.route).pop();
    ok(z, 'no routed zombie available');
    const startX = z.x;
    const startY = z.y;
    const approach = g.currentWaveApproach;
    const marker = approach ? approach.path[approach.path.length - 1] : null;

    // 让尸潮一路走到基地门口（最多 120 秒模拟时间）
    let reached = false;
    for (let i = 0; i < 2400 && !reached; i++) {
      g.updateZombies(0.05);
      if (marker && Math.hypot(z.x - marker.x, z.y - marker.y) < 150) reached = true;
    }

    ok(z.alive, 'wave zombie died during march test');
    const travelled = Math.hypot(z.x - startX, z.y - startY);
    ok(travelled > 150, 'wave zombie barely moved (travelled ' + travelled.toFixed(0) + 'px)');
    ok(z.x > startX + 120 || reached, 'wave zombie did not advance east / reach the base');
    ok(reached || z.route === null || Math.hypot(z.x - g.commandCenter.x, z.y - g.commandCenter.y) < 600,
      'wave zombie is not converging on the base');
  });

  check('P0-5 command center can train an engineer', () => {
    // 前面的尸潮测试可能已经打坏了指挥中心，这里把它复原成开场状态
    const cc = g.commandCenter;
    cc.alive = true;
    cc.isConstructing = false;
    cc.buildRemaining = 0;
    cc.hp = cc.maxHp;
    cc.trainingRemaining = 0;
    if (!g.buildings.includes(cc)) g.buildings.push(cc);
    g.gameOver = 'qa';

    const button = document.getElementById('train-engineer');
    ok(g.commandCenter.isWorking, 'test precondition: command center should be operational');
    ok(button, 'missing #train-engineer button');
    g.resources.iron = 300;
    g.selectBuilding(g.commandCenter);
    ok(!button.disabled, 'engineer button should be enabled when command center is selected');
    const before = g.units.filter((u) => u.alive && u.team === 'player' && u.type === 'engineer').length;
    button.click();
    ok(g.commandCenter.trainingRemaining > 0, 'training timer did not start');
    ok(g.resources.iron <= 241, 'engineer training did not deduct 60 iron');
    g.updateBuildings(8.2);
    const after = g.units.filter((u) => u.alive && u.team === 'player' && u.type === 'engineer').length;
    eq(after, before + 1, 'engineer was not deployed after 8 seconds');
  });

  check('P0-5 engineer cap is four', () => {
    const cc = g.commandCenter;
    cc.alive = true;
    cc.isConstructing = false;
    cc.buildRemaining = 0;
    cc.hp = cc.maxHp;
    cc.trainingRemaining = 0;
    if (!g.buildings.includes(cc)) g.buildings.push(cc);
    g.gameOver = 'qa';

    const button = document.getElementById('train-engineer');
    ok(g.commandCenter.isWorking, 'test precondition: command center should be operational');
    g.resources.iron = 300;
    g.selectBuilding(g.commandCenter);
    button.click();
    g.updateBuildings(8.2);
    const count = g.units.filter((u) => u.alive && u.team === 'player' && u.type === 'engineer').length;
    eq(count, 4, 'engineer count should reach the cap of four');
    const metalBefore = g.resources.iron;
    g.selectBuilding(g.commandCenter);
    g.trainEngineer();
    ok(g.commandCenter.trainingRemaining === 0, 'training started even though engineer cap was reached');
    eq(g.resources.iron, metalBefore, 'metal was deducted when engineer cap blocked training');
  });

  check('P0-8 nest has 1200 core HP and 2-3 shield nodes of 200 HP', () => {
    const nest = g.spawnPoints[0];
    eq(nest.maxHp, 1200, 'nest core max HP');
    ok(Array.isArray(nest.shieldNodes), 'nest has no shieldNodes array');
    ok(nest.shieldNodes.length >= 2 && nest.shieldNodes.length <= 3, 'shield node count must be 2-3');
    for (const node of nest.shieldNodes) eq(node.maxHp, 200, 'shield node max HP');
  });

  check('P0-8 core is invulnerable until every shield node is destroyed', () => {
    const nest = g.spawnPoints[1] || g.spawnPoints[0];
    nest.alive = true;
    nest.hp = nest.maxHp;
    for (const node of nest.shieldNodes) {
      node.alive = true;
      node.hp = node.maxHp;
    }
    const coreBefore = nest.hp;
    g.damageSpawnPoint(nest, 90);
    eq(nest.hp, coreBefore, 'core took damage while shields were alive');
    eq(nest.shieldNodes[0].hp, 110, 'first shield node should absorb damage');
    for (const node of nest.shieldNodes) {
      node.alive = true;
      node.hp = node.maxHp;
    }
    for (const node of nest.shieldNodes) g.damageSpawnPoint(nest, 200);
    ok(nest.shieldNodes.every((node) => !node.alive), 'shield nodes were not destroyed by 200 damage each');
    eq(nest.hp, coreBefore, 'core took damage before all shields were confirmed down');
    g.damageSpawnPoint(nest, 100);
    eq(nest.hp, coreBefore - 100, 'core did not take damage after shields were destroyed');
  });

  check('P0-8 shield nodes and core are separately targetable', () => {
    const nest = g.spawnPoints[2] || g.spawnPoints[0];
    const node = nest.shieldNodes[0];
    ok(node, 'no shield node to target');
    eq(g.findAttackableAt({ x: node.x, y: node.y }), node, 'clicking a shield node should target that node');
    eq(g.findAttackableAt({ x: nest.x, y: nest.y }), nest, 'clicking the core should target the nest');
  });

  return results;
})()`;

async function main() {
  if (!fs.existsSync(EDGE)) throw new Error('Microsoft Edge not found at ' + EDGE);
  const browser = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${USER_DIR}`,
    '--no-first-run',
    '--disable-gpu',
    '--disable-extensions',
    '--window-size=1400,1000',
    PAGE_URL
  ], { stdio: 'ignore' });

  let connection;
  try {
    const page = await waitForEndpoint();
    connection = await connect(page.webSocketDebuggerUrl);
    await connection.send('Runtime.enable');
    await waitForGame(connection.send);
    const results = await evaluate(connection.send, TEST_EXPRESSION);
    const failed = results.filter((result) => !result.pass);
    for (const result of results) {
      console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ' :: ' + result.detail : ''}`);
    }
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    if (connection) connection.ws.close();
    browser.kill();
    await sleep(300);
    try {
      fs.rmSync(USER_DIR, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup failures after the browser has exited.
    }
  }
}

main().catch((error) => {
  console.error('QA harness error:', error.message);
  process.exitCode = 1;
});


