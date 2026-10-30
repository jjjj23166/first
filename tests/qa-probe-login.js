/* Probe: does the login overlay render, and is the game frozen before deploy? */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9501;
const USER_DIR = path.join(os.tmpdir(), `zrts-login-${Date.now()}`);
const base = path.join(process.cwd(), 'index.html').replace(/\\/g, '/');
const PAGE_URL = `file:///${base}?debug=1&seed=31415926`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = String.raw`(() => {
  const out = {};
  const g = window.__ZRTS__;
  out.booted = Boolean(g);
  out.hasLoginOverlay = Boolean(document.getElementById('login-overlay'));
  const overlay = document.getElementById('login-overlay');
  out.overlayHidden = overlay ? overlay.classList.contains('is-hidden') : null;
  out.pausedByLogin = g ? g.pausedByLogin : null;
  out.loginStep = g ? g.loginStep : null;
  out.difficultyOptions = document.querySelectorAll('.difficulty-option').length;
  out.stepIdentityVisible = (() => {
    const el = document.getElementById('login-step-identity');
    return el ? !el.hidden : null;
  })();
  out.stepLoadoutVisible = (() => {
    const el = document.getElementById('login-step-loadout');
    return el ? !el.hidden : null;
  })();
  out.diffId = g && g.loginDifficulty;
  out.waveNumber = g ? g.waveNumber : null;
  out.nextWaveIn = g ? Math.round(g.nextWaveIn) : null;
  // 冻结期间 waveNumber 应保持 0
  return out;
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
    const errors = [];
    await new Promise((resolve) => ws.addEventListener('open', resolve));
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        const d = message.params.exceptionDetails;
        errors.push(d.exception?.description || d.text);
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        errors.push(message.params.args.map((a) => a.value || a.description || '').join(' '));
      }
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

    const res = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    if (res.result.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description || 'evaluate failed');
    }
    console.log('PROBE:', JSON.stringify(res.result.result.value, null, 2));
    console.log('PAGE ERRORS:', errors.length ? errors : 'none');

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('login-step1.png', Buffer.from(shot.result.data, 'base64'));
    console.log('screenshot saved: login-step1.png');
  } finally {
    if (ws) ws.close();
    browser.kill();
    await sleep(300);
    try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  }
})().catch((error) => {
  console.error('PROBE error:', error.message);
  process.exitCode = 1;
});
