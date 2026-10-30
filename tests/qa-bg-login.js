/* Why is the battlefield black behind the login card? */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9503;
const USER_DIR = path.join(os.tmpdir(), `zrts-bg-${Date.now()}`);
const base = path.join(process.cwd(), 'index.html').replace(/\\/g, '/');
const PAGE_URL = `file:///${base}?debug=1&seed=31415926`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
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
    ws = new WebSocket(page.webSocketDebuggerUrl);
    const pending = new Map();
    let serial = 0;
    await new Promise((resolve) => ws.addEventListener('open', resolve));
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    });
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = ++serial; pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
      return r.result.result.value;
    };
    await send('Runtime.enable');
    await sleep(2600);

    const info = await evaluate(String.raw`(() => {
      const g = window.__ZRTS__;
      const canvas = document.getElementById('game-canvas');
      // sample the canvas pixels to see if the battlefield actually drew something
      const ctx = canvas.getContext('2d');
      const sample = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      const overlay = document.getElementById('login-overlay');
      const cs = getComputedStyle(overlay);
      return {
        canvasSize: [canvas.width, canvas.height],
        pixels: {
          center: sample(400, 300),
          topLeft: sample(40, 40),
          bottomRight: sample(760, 560)
        },
        overlayBg: cs.backgroundImage.slice(0, 160),
        camera: { x: Math.round(g.camera.x), y: Math.round(g.camera.y), zoom: g.camera.zoom },
        fogInited: Boolean(g.fogCanvas || g.fogCtx),
        pausedByLogin: g.pausedByLogin,
        terrainPresent: Boolean(g.terrain)
      };
    })()`);
    console.log(JSON.stringify(info, null, 2));
  } finally {
    if (ws) ws.close();
    browser.kill();
    await sleep(300);
    try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  }
})().catch((e) => { console.error('ERR', e.message); process.exitCode = 1; });
