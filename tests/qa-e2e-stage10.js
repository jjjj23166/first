/* End-to-end play check: real mouse flow for factory + wall drag, then a few game seconds. */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9381;
const USER_DIR = path.join(os.tmpdir(), `zrts-e2e-${Date.now()}`);
const PAGE_URL = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}?debug=1`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RUN = `(async () => {
  const g = window.__ZRTS__;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const canvas = document.getElementById('game-canvas');
  const rect = canvas.getBoundingClientRect();
  const toScreen = (wx, wy) => ({
    clientX: rect.left + ((wx - g.camera.x) * g.camera.zoom / 800) * rect.width,
    clientY: rect.top + ((wy - g.camera.y) * g.camera.zoom / 600) * rect.height
  });

  g.gameOver = 'qa';
  g.zombies = [];
  g.waveSpawnQueue = [];
  g.nextWaveIn = 9999;
  document.getElementById('intro-card').classList.add('is-hidden');

  const wood = g.resourceNodes.find((n) => n.resourceType === 'wood');
  g.camera.zoom = 1;
  g.centerCameraOn(wood.x, wood.y);

  // 1) 点建造按钮 → 移动鼠标 → 点击放置木材厂
  document.querySelector('[data-build-type="lumber"]').click();
  await wait(60);
  const target = toScreen(wood.x + 90, wood.y);
  window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, ...target }));
  await wait(60);
  canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, ...target }));
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, buttons: 0, ...target }));
  await wait(120);

  const factory = g.buildings.find((b) => b.type === 'lumber');
  const afterPlace = {
    factoryCreated: Boolean(factory),
    constructing: factory ? factory.isConstructing : null,
    hp: factory ? factory.hp : null,
    buildRemaining: factory ? Number(factory.buildRemaining.toFixed(1)) : null,
    wood: Math.round(g.resources.wood)
  };

  // 2) 模拟 6 秒（工厂 5 秒完工）
  for (let i = 0; i < 120; i++) g.updateBuildings(0.05);
  for (let i = 0; i < 40; i++) g.updateEconomy(0.05);
  g.syncEconomyHud();
  const afterBuild = {
    constructing: factory ? factory.isConstructing : null,
    producing: wood.isProducing,
    wood: Math.round(g.resources.wood),
    income: Number(g.income.wood.toFixed(2)),
    hudWood: document.querySelector('[data-resource="wood"] [data-resource-amount]').textContent,
    hudFactory: document.getElementById('factory-total').textContent
  };

  // 3) 拖拽造墙（先拉远视角到基地南侧空地）
  g.camera.zoom = 1;
  g.centerCameraOn(760, 1180);
  document.querySelector('[data-build-type="wall"]').click();
  await wait(60);
  const start = toScreen(640, 1180);
  canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, ...start }));
  for (let i = 1; i <= 10; i++) {
    const p = toScreen(640 + i * 32, 1180);
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, button: 0, buttons: 1, ...p }));
    await wait(12);
  }
  const previewCount = g.buildGhost && g.buildGhost.tiles ? g.buildGhost.tiles.length : 0;
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, buttons: 0 }));
  await wait(80);
  const walls = g.buildings.filter((b) => b.type === 'wall');
  const afterWalls = {
    previewCount,
    wallCount: walls.length,
    allConstructing: walls.every((w) => w.isConstructing),
    wood: Math.round(g.resources.wood),
    stone: Math.round(g.resources.stone)
  };

  // 4) 让围墙建完
  for (let i = 0; i < 60; i++) g.updateBuildings(0.05);
  const wallsDone = walls.every((w) => !w.isConstructing && w.hp === w.maxHp);

  g.render(performance.now(), performance.now() - g.startedAt);
  g.drawMinimap();
  g.syncEconomyHud();

  return JSON.stringify({ afterPlace, afterBuild, afterWalls, wallsDone });
})()`;

(async () => {
  const browser = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${USER_DIR}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1400,1000', PAGE_URL
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
    const evaluated = await send('Runtime.evaluate', { expression: RUN, returnByValue: true, awaitPromise: true });
    if (evaluated.result.exceptionDetails) throw new Error(evaluated.result.exceptionDetails.exception?.description);
    console.log(evaluated.result.result.value);
  } finally {
    if (ws) ws.close();
    browser.kill();
    await sleep(300);
    try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  }
})().catch((error) => {
  console.error('e2e error:', error.message);
  process.exitCode = 1;
});

