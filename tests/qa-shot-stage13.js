/* Stage 13 screenshots: river + bridges + denser resources. */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9431;
const USER_DIR = path.join(os.tmpdir(), `zrts-shot13-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const shots = [
  { file: 'stage13-river.png', expr: `(() => { const g = window.__ZRTS__; g.hideIntro(); g.updateFog = function(){}; g.drawFog = function(){}; if (g.exploredMask && g.exploredCtx) { g.exploredCtx.fillStyle='#fff'; g.exploredCtx.fillRect(0,0,g.exploredMask.width,g.exploredMask.height); } g.camera.zoom = g.camera.minZoom; g.centerCameraOn(1000, 800); return 'ok'; })()` },
  { file: 'stage13-bridge.png', expr: `(() => { const g = window.__ZRTS__; g.hideIntro(); g.updateFog = function(){}; g.drawFog = function(){}; if (g.exploredMask && g.exploredCtx) { g.exploredCtx.fillStyle='#fff'; g.exploredCtx.fillRect(0,0,g.exploredMask.width,g.exploredMask.height); } const b = g.river.bridges[1]; g.camera.zoom = g.camera.maxZoom; g.centerCameraOn(b.x, b.y); return 'ok'; })()` }
];

(async () => {
  const url = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}?debug=1&seed=31415926`;
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--window-size=1400,1000', `--user-data-dir=${USER_DIR}`, `--remote-debugging-port=${PORT}`, url], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); targets = await r.json(); if (targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) break; } catch { /* retry */ }
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
  for (const shot of shots) {
    await send('Runtime.evaluate', { expression: shot.expr, returnByValue: true, awaitPromise: true });
    await sleep(700);
    const cap = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.cwd(), shot.file), Buffer.from(cap.result.data, 'base64'));
    console.log('wrote', shot.file);
  }
  ws.close(); child.kill(); await sleep(300);
  try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
})();
