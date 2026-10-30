/* End-to-end: click DEPLOY, confirm navigation params and that the game runs. */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9507;
const USER_DIR = path.join(os.tmpdir(), `zrts-deploy-${Date.now()}`);
const base = path.join(process.cwd(), 'index.html').replace(/\\/g, '/');
const PAGE_URL = `file:///${base}`;
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
    const errors = [];
    let lastLoggedUrl = null;
    await new Promise((resolve) => ws.addEventListener('open', resolve));
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        const d = message.params.exceptionDetails;
        errors.push(d.exception?.description || d.text);
      }
      if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) {
        lastLoggedUrl = message.params.frame.url;
      }
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    });
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = ++serial; pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
      return r.result.result.value;
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(2600);

    console.log('boot url:', await evaluate('location.search'));

    // fill identity -> next -> choose nightmare -> set seed -> deploy
    await evaluate(String.raw`(() => {
      const input = document.getElementById('login-name');
      input.value = '测试指挥官';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('login-next').click();
      document.querySelector('.difficulty-option[data-difficulty="nightmare"]').click();
      const seed = document.getElementById('login-seed');
      seed.value = '31415926';
      seed.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);

    await evaluate(`document.getElementById('login-start').click()`);
    await sleep(3200);

    console.log('navigated to:', lastLoggedUrl);

    const after = await evaluate(String.raw`(() => {
      const g = window.__ZRTS__;
      const params = new URLSearchParams(location.search);
      const overlay = document.getElementById('login-overlay');
      return {
        search: location.search,
        diff: params.get('diff'),
        seed: params.get('seed'),
        game: params.get('game'),
        overlayHidden: overlay ? overlay.classList.contains('is-hidden') : null,
        pausedByLogin: g ? g.pausedByLogin : 'no-debug-hook',
        // difficulty effects
        startWood: g ? g.resources.wood : null,
        startIron: g ? g.resources.iron : null
      };
    })()`).catch((e) => ({ error: e.message }));
    console.log('after deploy:', JSON.stringify(after, null, 2));
    console.log('PAGE ERRORS:', errors.length ? errors : 'none');
  } finally {
    if (ws) ws.close();
    browser.kill();
    await sleep(300);
    try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  }
})().catch((e) => { console.error('DEPLOY error:', e.message); process.exitCode = 1; });
