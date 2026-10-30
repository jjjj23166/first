/* Stage 14: units must never be stuck inside building models. */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9434;
const USER_DIR = path.join(os.tmpdir(), `zrts-clip-${Date.now()}`);
const PAGE_URL = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}?debug=1&seed=31415926`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TEST = String.raw`(() => {
  const g = window.__ZRTS__;
  const results = [];
  g.gameOver = null;
  g.zombies = [];
  g.waveSpawnQueue = [];
  g.nextWaveIn = 9999;

  const check = (name, fn) => {
    try { fn(); results.push({ name, pass: true, detail: '' }); }
    catch (error) { results.push({ name, pass: false, detail: String((error && error.message) || error) }); }
  };
  const ok = (value, message) => { if (!value) throw new Error(message); };

  // 穿透深度：单位圆心到建筑矩形的距离小于半径，就是模型穿模
  const clipDepth = (unit, rect) => {
    const cx = Math.max(rect.x, Math.min(unit.x, rect.x + rect.width));
    const cy = Math.max(rect.y, Math.min(unit.y, rect.y + rect.height));
    const d = Math.hypot(unit.x - cx, unit.y - cy);
    return d < unit.radius ? +(unit.radius - d).toFixed(2) : 0;
  };
  const worstClip = (unit) => {
    let worst = 0;
    for (const b of g.buildings) {
      if (!b.alive) continue;
      worst = Math.max(worst, clipDepth(unit, b.rect));
    }
    return worst;
  };
  const step = (frames) => { for (let i = 0; i < frames; i++) g.update(0.033); };

  const cmd = g.buildings.find((b) => b.type === 'command');

  check('unit pushed inside a building gets pushed back out', () => {
    const unit = g.units.find((u) => u.alive);
    ok(unit, 'no unit available');
    unit.x = cmd.rect.x + cmd.rect.width / 2;
    unit.y = cmd.rect.y + cmd.rect.height / 2;
    unit.moveTarget = null;
    step(2);
    ok(worstClip(unit) === 0, 'unit still clipped into a building by ' + worstClip(unit) + 'px');
  });

  check('unit shoved inside a building can walk out on command', () => {
    const unit = g.units.find((u) => u.alive);
    unit.x = cmd.rect.x + cmd.rect.width / 2;
    unit.y = cmd.rect.y + cmd.rect.height / 2;
    unit.moveTo(cmd.rect.x - 260, cmd.rect.y - 60);
    step(180);
    ok(worstClip(unit) === 0, 'unit left clipped (' + worstClip(unit) + 'px)');
    ok(unit.x < cmd.rect.x - 120,
      'unit never escaped the building (x=' + Math.round(unit.x) + ', building left edge=' + Math.round(cmd.rect.x) + ')');
  });

  check('ordering a unit onto a building never parks it in the model', () => {
    const unit = g.units.find((u) => u.alive);
    unit.x = cmd.rect.x - 40;
    unit.y = cmd.rect.y + cmd.rect.height / 2;
    unit.moveTo(cmd.rect.x + cmd.rect.width / 2, cmd.rect.y + cmd.rect.height / 2);
    step(240);
    ok(worstClip(unit) === 0, 'unit parked inside the building model (' + worstClip(unit) + 'px deep)');
  });

  check('walking straight at a building stops at its wall', () => {
    const unit = g.units.find((u) => u.alive);
    unit.x = cmd.rect.x - 120;
    unit.y = cmd.rect.y + cmd.rect.height / 2;
    unit.moveTo(cmd.rect.x + 400, unit.y);
    step(240);
    ok(worstClip(unit) === 0, 'unit clipped into the wall (' + worstClip(unit) + 'px)');
    ok(unit.x <= cmd.rect.x - 8 || unit.x >= cmd.rect.x + cmd.rect.width + 8,
      'unit stopped inside the footprint (x=' + Math.round(unit.x) + ')');
  });

  check('stacked units never end up inside a building', () => {
    const unit = g.units.find((u) => u.alive);
    for (const other of g.units) {
      if (!other.alive || other === unit) continue;
      other.x = cmd.rect.x + cmd.rect.width / 2;
      other.y = cmd.rect.y + cmd.rect.height / 2;
      other.moveTarget = null;
    }
    unit.x = cmd.rect.x + cmd.rect.width / 2;
    unit.y = cmd.rect.y + cmd.rect.height / 2;
    unit.moveTarget = null;
    step(60);
    for (const u of g.units) {
      if (!u.alive) continue;
      ok(worstClip(u) === 0, 'unit ' + u.id + ' clipped into a building (' + worstClip(u) + 'px)');
    }
  });

  check('units stay out of buildings during a long march', () => {
    const unit = g.units.find((u) => u.alive);
    unit.x = cmd.rect.x - 200;
    unit.y = cmd.rect.y + cmd.rect.height / 2;
    let worst = 0;
    for (let leg = 0; leg < 6; leg++) {
      const targetX = leg % 2 === 0 ? cmd.rect.x + cmd.rect.width + 200 : cmd.rect.x - 200;
      unit.moveTo(targetX, cmd.rect.y + (leg % 2 ? 90 : -90));
      for (let i = 0; i < 120; i++) {
        g.update(0.033);
        worst = Math.max(worst, worstClip(unit));
      }
    }
    ok(worst === 0, 'unit clipped into a building while marching (' + worst + 'px)');
  });

  check('zombies pushed into a building get pushed back out', () => {
    g.zombies = [];
    const zombie = g.spawnZombie('normal', cmd.rect.x + cmd.rect.width / 2, cmd.rect.y + cmd.rect.height / 2, {});
    zombie.target = null;
    zombie.route = null;
    step(2);
    ok(worstClip(zombie) === 0, 'zombie still clipped (' + worstClip(zombie) + 'px)');
  });

  check('a zombie crowd never ends up inside a building', () => {
    g.zombies = [];
    for (let i = 0; i < 6; i++) {
      const z = g.spawnZombie('normal', cmd.rect.x + cmd.rect.width / 2, cmd.rect.y + cmd.rect.height / 2, {});
      z.target = null;
      z.route = null;
    }
    step(40);
    for (const z of g.zombies) {
      if (!z.alive) continue;
      ok(worstClip(z) === 0, 'zombie ' + z.id + ' clipped into a building (' + worstClip(z) + 'px)');
    }
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
