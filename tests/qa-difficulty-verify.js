/* Verify difficulty actually takes effect after deploy. */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = String.raw`(() => {
  const g = window.__ZRTS__;
  return {
    diffId: g.difficulty ? g.difficulty.id : null,
    countScale: g.difficulty ? g.difficulty.countScale : null,
    hpScale: g.difficulty ? g.difficulty.hpScale : null,
    waveInterval: g.difficulty ? g.difficulty.waveInterval : null,
    loginCompleted: g.loginCompleted,
    resources: { wood: g.resources.wood, stone: g.resources.stone, iron: g.resources.iron },
    waveNumber: g.waveNumber,
    nextWaveIn: Math.round(g.nextWaveIn),
    pausedByLogin: g.pausedByLogin,
    loginOverlayHidden: document.getElementById('login-overlay').classList.contains('is-hidden')
  };
})()`;

async function probePage(port, url, label) {
  const userDir = path.join(os.tmpdir(), `zrts-diff-${port}-${Date.now()}`);
  const browser = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${userDir}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1200,900', url
  ], { stdio: 'ignore' });
  let ws;
  try {
    let page = null;
    for (let i = 0; i < 100; i++) {
      try {
        const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
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
    await sleep(2800);
    const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
    console.log(label, JSON.stringify(r.result.result.value));
  } finally {
    if (ws) ws.close();
    browser.kill();
    await sleep(300);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  }
}

(async () => {
  const base = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}`;
  await probePage(9511, `${base}?debug=1&seed=31415926&diff=recruit&game=1`, 'recruit  :');
  await probePage(9512, `${base}?debug=1&seed=31415926&diff=veteran&game=1`, 'veteran  :');
  await probePage(9513, `${base}?debug=1&seed=31415926&diff=nightmare&game=1`, 'nightmare:');
})().catch((e) => { console.error('DIFF error:', e.message); process.exitCode = 1; });
