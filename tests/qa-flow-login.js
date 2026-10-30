/* Walk the full login flow and capture each step. */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9502;
const USER_DIR = path.join(os.tmpdir(), `zrts-flow-${Date.now()}`);
const base = path.join(process.cwd(), 'index.html').replace(/\\/g, '/');
const PAGE_URL = `file:///${base}?debug=1&seed=31415926`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
      return r.result.result.value;
    };
    const shoot = async (name) => {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(name, Buffer.from(shot.result.data, 'base64'));
      console.log('  saved', name);
    };

    await send('Runtime.enable');
    await sleep(2600);

    // --- 1. empty name should be rejected ---
    const reject = await evaluate(String.raw`(() => {
      const g = window.__ZRTS__;
      document.getElementById('login-next').click();
      return {
        step: g.loginStep,
        invalid: document.getElementById('login-name').classList.contains('is-invalid'),
        errorShown: document.getElementById('login-name-error').classList.contains('is-visible')
      };
    })()`);
    console.log('empty-name rejected:', JSON.stringify(reject));

    // --- 2. type a valid callsign, go to step 2 ---
    const step2 = await evaluate(String.raw`(() => {
      const g = window.__ZRTS__;
      const input = document.getElementById('login-name');
      input.value = '灰烬-7';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('login-next').click();
      return {
        step: g.loginStep,
        loadoutVisible: !document.getElementById('login-step-loadout').hidden,
        identityHidden: document.getElementById('login-step-identity').hidden,
        callsignLabel: document.getElementById('login-loadout-callsign').textContent,
        diffs: Array.from(document.querySelectorAll('.difficulty-option')).map(b => b.dataset.difficulty + (b.classList.contains('is-selected') ? '*' : '')),
        steps: Array.from(document.querySelectorAll('.login-step')).map(s => s.textContent.trim() + (s.classList.contains('is-active') ? '[active]' : '') + (s.classList.contains('is-done') ? '[done]' : ''))
      };
    })()`);
    console.log('step2:', JSON.stringify(step2, null, 2));
    await sleep(500);
    await shoot('login-step2.png');

    // --- 3. select nightmare difficulty ---
    const diffSel = await evaluate(String.raw`(() => {
      const g = window.__ZRTS__;
      const btn = document.querySelector('.difficulty-option[data-difficulty="nightmare"]');
      btn.click();
      return {
        loginDifficulty: g.loginDifficulty,
        selected: document.querySelectorAll('.difficulty-option.is-selected').length,
        aria: btn.getAttribute('aria-checked'),
        savedProfile: JSON.parse(localStorage.getItem('zrts.profile.v1') || '{}').lastDifficulty
      };
    })()`);
    console.log('difficulty select:', JSON.stringify(diffSel));

    // --- 4. seed validation ---
    const badSeed = await evaluate(String.raw`(() => {
      const g = window.__ZRTS__;
      const seed = document.getElementById('login-seed');
      seed.value = 'abc';
      const before = location.search;
      document.getElementById('login-start').click();
      return {
        invalid: seed.classList.contains('is-invalid'),
        errorShown: document.getElementById('login-seed-error').classList.contains('is-visible'),
        urlUnchanged: location.search === before
      };
    })()`);
    console.log('bad seed rejected:', JSON.stringify(badSeed));

    // --- 5. dice fills a seed ---
    const dice = await evaluate(String.raw`(() => {
      document.getElementById('login-seed-dice').click();
      const v = document.getElementById('login-seed').value;
      return { value: v, is8digit: /^\d{8}$/.test(v) };
    })()`);
    console.log('dice:', JSON.stringify(dice));

    // --- 6. profile persisted? ---
    const profile = await evaluate(`JSON.parse(localStorage.getItem('zrts.profile.v1') || '{}')`);
    console.log('profile:', JSON.stringify(profile));

    await sleep(300);
    await shoot('login-step2-filled.png');

    console.log('PAGE ERRORS:', errors.length ? errors : 'none');
  } finally {
    if (ws) ws.close();
    browser.kill();
    await sleep(300);
    try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  }
})().catch((error) => {
  console.error('FLOW error:', error.message);
  process.exitCode = 1;
});
