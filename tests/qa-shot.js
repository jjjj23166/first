/* Generic screenshot: terrain close-up + overview. */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const shotsArg = process.argv[2] || '[]';
const shots = JSON.parse(
  shotsArg.endsWith('.json') ? fs.readFileSync(path.join(process.cwd(), shotsArg), 'utf8') : shotsArg
);
const prefix = process.argv[3] || 'shot';

(async () => {
  const port = 9450 + Math.floor(Math.random() * 300);
  const userDir = path.join(os.tmpdir(), `zrts-shot-${Date.now()}`);
  const url = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}?debug=1&seed=31415926`;
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--window-size=1400,1000', `--user-data-dir=${userDir}`, `--remote-debugging-port=${port}`, url], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 90; i++) {
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
  await sleep(3400);

  const PREP = `(() => { const g = window.__ZRTS__; g.hideIntro(); if (g.updateFog) g.updateFog = function(){}; if (g.drawFog) g.drawFog = function(){}; return 'ok'; })()`;
  const prep = await send('Runtime.evaluate', { expression: PREP, returnByValue: true, awaitPromise: true });
  if (prep.result.exceptionDetails) console.log('prep ERR', prep.result.exceptionDetails.exception?.description);

  for (const shot of shots) {
    const r = await send('Runtime.evaluate', { expression: shot.expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) console.log('ERR', shot.file, r.result.exceptionDetails.exception?.description);
    else if (r.result.result.value !== 'ok') console.log('note', shot.file, JSON.stringify(r.result.result.value));
    await sleep(700);
    const cap = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.cwd(), shot.file), Buffer.from(cap.result.data, 'base64'));
    console.log('wrote', shot.file);
  }
  ws.close(); child.kill(); await sleep(300);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
})();
