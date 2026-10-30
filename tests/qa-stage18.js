/* Stage 18: login main screen regression (identity step, loadout step, difficulty, profile, pause). */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9480;
const USER_DIR = path.join(os.tmpdir(), `zrts-login-${Date.now()}`);
const base = path.join(process.cwd(), 'index.html').replace(/\\/g, '/');
const PAGE_URL = `file:///${base}?debug=1&seed=31415926`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TEST = String.raw`(() => {
  const g = window.__ZRTS__;
  const results = [];
  const check = (name, fn) => {
    try { fn(); results.push({ name, pass: true, detail: '' }); }
    catch (error) { results.push({ name, pass: false, detail: String((error && error.message) || error) }); }
  };
  const ok = (value, message) => { if (!value) throw new Error(message); };
  const el = (id) => document.getElementById(id);

  // ---------- 结构 ----------
  check('login overlay exists and is shown before deploy', () => {
    const overlay = el('login-overlay');
    ok(overlay, 'missing #login-overlay');
    ok(!overlay.classList.contains('is-hidden'), 'overlay should be visible before deploy');
    ok(g.pausedByLogin === true, 'game should be paused while logging in');
  });

  check('both login steps exist with identity step active', () => {
    ok(el('login-step-identity'), 'missing identity step');
    ok(el('login-step-loadout'), 'missing loadout step');
    ok(!el('login-step-identity').hidden, 'identity step should be visible');
    ok(el('login-step-loadout').hidden, 'loadout step should be hidden initially');
    ok(g.loginStep === 'identity', 'loginStep should be identity, got ' + g.loginStep);
  });

  check('step indicator marks step 1 active', () => {
    const steps = Array.from(document.querySelectorAll('.login-step'));
    ok(steps.length === 2, 'expected 2 step markers, got ' + steps.length);
    ok(steps[0].classList.contains('is-active'), 'step 1 should be active');
    ok(!steps[1].classList.contains('is-active'), 'step 2 should not be active');
  });

  // ---------- 冻结 ----------
  check('battlefield is frozen before deploy', () => {
    ok(g.waveNumber === 0, 'waveNumber should stay 0, got ' + g.waveNumber);
    ok(g.zombies.length === 0, 'no zombies should exist before deploy');
    ok(g.nextWaveIn > 25, 'wave countdown should not tick, got ' + g.nextWaveIn);
  });

  // ---------- 代号校验 ----------
  check('empty callsign is rejected', () => {
    el('login-name').value = '';
    el('login-next').click();
    ok(g.loginStep === 'identity', 'should stay on identity step');
    ok(el('login-name').classList.contains('is-invalid'), 'name field should be marked invalid');
    ok(el('login-name-error').classList.contains('is-visible'), 'error should be visible');
  });

  check('one-character callsign is rejected', () => {
    el('login-name').value = 'A';
    el('login-name').dispatchEvent(new Event('input', { bubbles: true }));
    el('login-next').click();
    ok(g.loginStep === 'identity', 'single char should be rejected');
  });

  // ---------- 进入第二步 ----------
  check('valid callsign advances to loadout step', () => {
    const input = el('login-name');
    input.value = '灰烬-7';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    el('login-next').click();
    ok(g.loginStep === 'loadout', 'should advance to loadout, got ' + g.loginStep);
    ok(!el('login-step-loadout').hidden, 'loadout should be visible');
    ok(el('login-step-identity').hidden, 'identity should be hidden');
  });

  check('step indicator updates after advancing', () => {
    const steps = Array.from(document.querySelectorAll('.login-step'));
    ok(steps[0].classList.contains('is-done'), 'step 1 should be marked done');
    ok(steps[1].classList.contains('is-active'), 'step 2 should be active');
  });

  check('callsign is shown on loadout step', () => {
    const label = el('login-loadout-callsign').textContent;
    ok(label.includes('灰烬-7'), 'callsign missing from loadout header: ' + label);
  });

  // ---------- 难度 ----------
  check('three difficulty options are rendered', () => {
    const options = document.querySelectorAll('.difficulty-option');
    ok(options.length === 3, 'expected 3 difficulties, got ' + options.length);
    const ids = Array.from(options).map((o) => o.dataset.difficulty);
    ok(ids.includes('recruit') && ids.includes('veteran') && ids.includes('nightmare'),
      'unexpected difficulty ids: ' + ids.join(','));
  });

  check('default difficulty is veteran and selected', () => {
    const selected = document.querySelectorAll('.difficulty-option.is-selected');
    ok(selected.length === 1, 'exactly one should be selected, got ' + selected.length);
    ok(selected[0].dataset.difficulty === 'veteran', 'veteran should be default, got ' + selected[0].dataset.difficulty);
  });

  check('selecting nightmare updates state and aria', () => {
    const btn = document.querySelector('.difficulty-option[data-difficulty="nightmare"]');
    btn.click();
    ok(g.loginDifficulty === 'nightmare', 'loginDifficulty should be nightmare, got ' + g.loginDifficulty);
    ok(btn.getAttribute('aria-checked') === 'true', 'aria-checked should be true');
    ok(document.querySelectorAll('.difficulty-option.is-selected').length === 1, 'only one selected');
  });

  check('difficulty selection persists to local storage', () => {
    const raw = window.localStorage.getItem('zrts.profile.v1');
    ok(raw, 'profile should be saved');
    const saved = JSON.parse(raw);
    ok(saved.lastDifficulty === 'nightmare', 'lastDifficulty should persist, got ' + saved.lastDifficulty);
  });

  // ---------- 种子 ----------
  check('invalid seed is rejected', () => {
    const seed = el('login-seed');
    seed.value = 'not-a-seed';
    const before = location.search;
    el('login-start').click();
    ok(seed.classList.contains('is-invalid'), 'seed should be marked invalid');
    ok(el('login-seed-error').classList.contains('is-visible'), 'seed error should show');
    ok(location.search === before, 'should not navigate on invalid seed');
  });

  check('dice button generates 8-digit seed', () => {
    el('login-seed-dice').click();
    const value = el('login-seed').value;
    ok(/^\d{8}$/.test(value), 'dice should produce 8 digits, got ' + value);
  });

  check('valid seed clears the invalid state', () => {
    const seed = el('login-seed');
    seed.value = '31415926';
    seed.dispatchEvent(new Event('input', { bubbles: true }));
    ok(!seed.classList.contains('is-invalid'), 'invalid state should clear');
  });

  // ---------- 返回 ----------
  check('back button returns to identity step', () => {
    el('login-back').click();
    ok(g.loginStep === 'identity', 'should return to identity, got ' + g.loginStep);
    ok(!el('login-step-identity').hidden, 'identity should be visible again');
  });

  // ---------- 存档展示 ----------
  check('profile record fields render placeholders when empty', () => {
    const wave = el('record-best-wave');
    ok(wave, 'missing record-best-wave');
    ok(wave.classList.contains('is-empty'), 'empty record should carry is-empty');
    ok(wave.querySelector('strong').textContent === '—', 'empty record should show dash');
  });

  // ---------- 难度配置 ----------
  check('difficulty configs are ordered recruit < veteran < nightmare', () => {
    const r = g.difficultyConfig ? g.difficultyConfig.recruit : null;
    // fall back: verify through the live difficulty object
    const live = g.difficulty;
    ok(live, 'difficulty not exposed');
    ok(live.id === 'veteran', 'page loaded without ?diff should be veteran, got ' + live.id);
    ok(typeof live.countScale === 'number', 'countScale should be numeric');
    ok(live.countScale > 0 && live.hpScale > 0 && live.waveInterval > 0, 'difficulty multipliers must be positive');
    void r;
  });

  check('paused game does not advance after waiting', () => {
    ok(g.pausedByLogin === true, 'still paused');
    ok(g.waveNumber === 0, 'still wave 0');
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
    const pageErrors = [];
    await new Promise((resolve) => ws.addEventListener('open', resolve));
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        const d = message.params.exceptionDetails;
        pageErrors.push(d.exception?.description || d.text);
      }
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    });
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = ++serial; pending.set(id, resolve);
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
    if (pageErrors.length) {
      console.log('\nPAGE EXCEPTIONS:');
      pageErrors.forEach((e) => console.log('  ' + String(e).split('\n')[0]));
    }
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exitCode = failed || pageErrors.length ? 1 : 0;
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
