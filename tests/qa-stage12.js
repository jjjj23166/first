/* Stage 12: side dock regression. Verifies functional entries are grouped, openable and interactive. */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9401;
const USER_DIR = path.join(os.tmpdir(), `zrts-dock-${Date.now()}`);
const PAGE_URL = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}?debug=1`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TEST = String.raw`(async () => {
  const g = window.__ZRTS__;
  const results = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  g.gameOver = 'qa';
  g.zombies = [];
  g.waveSpawnQueue = [];
  g.nextWaveIn = 9999;
  document.getElementById('intro-card').classList.add('is-hidden');

  const check = async (name, fn) => {
    try { await fn(); results.push({ name, pass: true, detail: '' }); }
    catch (error) { results.push({ name, pass: false, detail: String(error && error.message || error) }); }
  };
  const ok = (value, message) => { if (!value) throw new Error(message); };
  const key = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));

  await check('dock starts closed with map tab preselected', () => {
    ok(document.getElementById('dock').dataset.open === 'false', 'dock should start closed');
    ok(document.getElementById('dock-toggle').getAttribute('aria-expanded') === 'false', 'toggle should report collapsed');
    const active = document.querySelector('.dock-tab.is-active');
    ok(active && active.dataset.dockTab === 'map', 'map tab should be active by default');
  });

  await check('dock toggle opens and closes the panel', async () => {
    const toggle = document.getElementById('dock-toggle');
    toggle.click();
    await wait(50);
    ok(document.getElementById('dock').dataset.open === 'true', 'dock did not open');
    const visibleView = document.querySelector('.dock-view.is-active');
    ok(visibleView && getComputedStyle(visibleView).display !== 'none', 'active view is not visible when open');
    ok(document.getElementById('dock-panel').offsetWidth > 100, 'dock panel has no width when open');
    toggle.click();
    await wait(50);
    ok(document.getElementById('dock').dataset.open === 'false', 'dock did not close');
    ok(getComputedStyle(document.getElementById('dock-panel')).display === 'none', 'panel still displayed when closed');
  });

  await check('each tab switches to its own content', async () => {
    g.setDockOpen(true);
    for (const tab of ['economy', 'force', 'log', 'map-seed', 'map']) {
      document.querySelector('[data-dock-tab="' + tab + '"]').click();
      await wait(40);
      const view = document.querySelector('.dock-view[data-dock-view="' + tab + '"]');
      ok(view.classList.contains('is-active'), tab + ' view did not activate');
      const others = Array.from(document.querySelectorAll('.dock-view')).filter((v) => v !== view && v.classList.contains('is-active'));
      ok(others.length === 0, 'more than one dock view is active');
    }
  });

  await check('keyboard shortcuts open each dock view', async () => {
    g.setDockOpen(false);
    const map = { KeyE: 'economy', KeyU: 'force', KeyL: 'log', KeyN: 'map-seed', KeyM: 'map' };
    for (const [code, view] of Object.entries(map)) {
      key(code);
      await wait(40);
      ok(g.dockOpen, code + ' did not open the dock');
      ok(document.querySelector('.dock-view[data-dock-view="' + view + '"]').classList.contains('is-active'),
        code + ' did not switch to ' + view);
    }
    key('Escape');
    await wait(40);
    ok(!g.dockOpen, 'Escape did not close the dock');
  });

  await check('economy tab lists every resource deposit', async () => {
    g.openDockView('economy');
    await wait(60);
    g.renderDepositList();
    const rows = document.querySelectorAll('#deposit-list .deposit-row');
    ok(rows.length === g.resourceNodes.length, 'deposit rows ' + rows.length + ' != nodes ' + g.resourceNodes.length);
    const first = rows[0].textContent;
    ok(first.includes(g.resourceNodes[0].resource.name), 'deposit row missing resource name');
  });

  await check('force tab keeps the live roster', async () => {
    g.openDockView('force');
    await wait(60);
    const rows = document.querySelectorAll('#selection-list .unit-row');
    ok(rows.length === g.units.filter((u) => u.alive).length, 'roster rows out of sync');
    ok(document.getElementById('selected-detail') !== null, 'selected detail missing from force tab');
  });

  await check('minimap inside the dock is clickable and moves the camera', async () => {
    g.openDockView('map');
    await wait(80);
    const canvas = document.getElementById('minimap');
    const rect = canvas.getBoundingClientRect();
    ok(rect.width > 100, 'minimap has no size inside the dock');
    g.camera.zoom = 1;
    g.centerCameraOn(400, 900);
    const before = { x: g.camera.x, y: g.camera.y };
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: rect.left + rect.width * 0.8, clientY: rect.top + rect.height * 0.2,
      pointerId: 1, isPrimary: true, button: 0
    }));
    await wait(40);
    ok(Math.abs(g.camera.x - before.x) > 100 || Math.abs(g.camera.y - before.y) > 100, 'minimap click did not move the camera');
  });

  await check('build panel collapses to an icon strip and expands again', async () => {
    const panel = document.getElementById('build-panel');
    ok(!panel.classList.contains('is-collapsed'), 'build panel should start expanded');
    const expandedHeight = panel.offsetHeight;
    document.getElementById('build-collapse').click();
    await wait(220);
    ok(panel.classList.contains('is-collapsed'), 'build panel did not collapse');
    const collapsedHeight = panel.offsetHeight;
    ok(collapsedHeight < expandedHeight * 0.75,
      'collapsed panel is not meaningfully smaller (' + collapsedHeight + ' vs ' + expandedHeight + ')');
    // 折叠后图纸文本隐藏、图标仍然可见可点
    const name = document.querySelector('[data-build-type="barracks"] .build-name');
    ok(getComputedStyle(name).display === 'none', 'build name should be hidden while collapsed');
    key('KeyB');
    await wait(120);
    ok(!panel.classList.contains('is-collapsed'), 'B key did not expand the build panel');
    ok(getComputedStyle(name).display !== 'none', 'build name did not come back after expanding');
  });

  await check('build buttons still work after layout change', async () => {
    g.resources = { wood: 500, stone: 500, iron: 500 };
    g.buildMode = null;
    const barracksBtn = document.querySelector('[data-build-type="barracks"]');
    barracksBtn.click();
    await wait(40);
    ok(g.buildMode === 'barracks', 'build button click no longer enters build mode');
    g.cancelBuildMode();
    ok(barracksBtn.querySelector('.build-cost').textContent.includes('W 80'), 'build cost label lost');
  });

  await check('seed controls live inside the dock', async () => {
    g.openDockView('map-seed');
    await wait(50);
    const seedBtn = document.getElementById('seed-new');
    ok(seedBtn && seedBtn.closest('.dock-view[data-dock-view="map-seed"]'), 'seed new-map button is not in the dock');
    ok(document.getElementById('seed-label').textContent.length >= 8, 'seed label not rendered');
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
    await sleep(2400);
    const evaluated = await send('Runtime.evaluate', { expression: TEST, returnByValue: true, awaitPromise: true });
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
