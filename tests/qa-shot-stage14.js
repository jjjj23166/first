/* Stage 14 screenshot: units hugging a building without clipping into it. */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP = String.raw`(() => {
  const g = window.__ZRTS__;
  g.hideIntro();
  g.gameOver = null;
  g.nextWaveIn = 9999;
  g.waveSpawnQueue = [];
  g.zombies = [];
  g.updateFog = function () {};
  g.drawFog = function () {};

  const cmd = g.buildings.find((b) => b.type === 'command');

  // 补足 12 个士兵：全部塞进建筑中心，再统一下达"走到建筑中心"的命令。
  // 修复前它们会被吸附/卡在模型内部；修复后应该被推到建筑外侧围成一圈。
  const UnitClass = g.units[0].constructor;
  while (g.units.length < 12) {
    const i = g.units.length;
    g.units.push(new UnitClass({
      id: 'shot-' + i, name: '步兵-' + i, type: 'infantry',
      x: cmd.x, y: cmd.y, team: 'player', radius: 11,
      hp: 100, maxHp: 100, speed: 70, accent: '#fff', idlePhase: i * 0.7
    }));
  }
  g.units.forEach((u) => {
    u.x = cmd.x; u.y = cmd.y;   // 故意全部叠在建筑里
    u.moveTo(cmd.x, cmd.y);     // 再命令它们走向建筑中心
  });
  for (let i = 0; i < 240; i++) g.update(0.033);

  // 统计还有多少实体的模型压进了建筑
  let clipped = 0;
  for (const u of g.units) {
    for (const b of g.buildings) {
      if (!b.alive) continue;
      const cx = Math.max(b.rect.x, Math.min(u.x, b.rect.x + b.rect.width));
      const cy = Math.max(b.rect.y, Math.min(u.y, b.rect.y + b.rect.height));
      if (Math.hypot(u.x - cx, u.y - cy) < u.radius) clipped++;
    }
  }
  window.__clippedCount = clipped;

  g.camera.zoom = g.camera.maxZoom;
  g.centerCameraOn(cmd.x, cmd.y);
  return { units: g.units.length, clipped };
})()`;

(async () => {
  const port = 9436;
  const userDir = path.join(os.tmpdir(), `zrts-shot14-${Date.now()}`);
  const url = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}?debug=1&seed=31415926`;
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--window-size=1400,1000', `--user-data-dir=${userDir}`, `--remote-debugging-port=${port}`, url], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); targets = await r.json(); if (targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) break; } catch { /* retry */ }
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(3200);
  const setup = await send('Runtime.evaluate', { expression: SETUP, returnByValue: true, awaitPromise: true });
  if (setup.result.exceptionDetails) console.log('ERR', setup.result.exceptionDetails.exception?.description);
  else console.log('setup', JSON.stringify(setup.result.result.value));
  await sleep(800);
  const cap = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(process.cwd(), 'stage14-no-clip.png'), Buffer.from(cap.result.data, 'base64'));
  console.log('wrote stage14-no-clip.png');
  ws.close(); child.kill(); await sleep(300);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
})();
