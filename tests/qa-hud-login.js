/* Which HUD child is still visible during login? */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9506;
const USER_DIR = path.join(os.tmpdir(), `zrts-hud-${Date.now()}`);
const base = path.join(process.cwd(), 'index.html').replace(/\\/g, '/');
const PAGE_URL = `file:///${base}?debug=1&seed=31415926`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = String.raw`(() => {
  const frame = document.getElementById('game-frame');
  const hud = document.querySelector('.hud-layer');
  const out = { frameHasClass: frame.classList.contains('is-login'), kids: [] };
  for (const c of hud.children) {
    const cs = getComputedStyle(c);
    out.kids.push({ cls: String(c.className).slice(0, 46), opacity: cs.opacity, vis: cs.visibility, z: cs.zIndex });
  }
  return out;
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
    await send('Runtime.enable');
    await sleep(2600);
    const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    console.log(JSON.stringify(r.result.result.value, null, 2));
  } finally {
    if (ws) ws.close();
    browser.kill();
    await sleep(300);
    try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  }
})().catch((e) => { console.error('ERR', e.message); process.exitCode = 1; });
