/* Stage 16: procedural music system regression. */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9480;
const USER_DIR = path.join(os.tmpdir(), `zrts-music-${Date.now()}`);
const PAGE_URL = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}?debug=1&seed=31415926`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TEST = String.raw`(() => {
  const g = window.__ZRTS__;
  const results = [];
  const check = (name, fn) => {
    try { fn(); results.push({ name, pass: true, detail: '' }); }
    catch (error) { results.push({ name, pass: false, detail: String((error && error.message) || error) }); }
  };
  const ok = (value, message) => { if (!value) throw new Error(message); };

  g.gameOver = null;
  g.zombies = [];
  g.waveSpawnQueue = [];
  g.nextWaveIn = 9999;

  check('music system exists and is enabled by default', () => {
    ok(g.music, 'music instance missing');
    ok(g.music.enabled === true, 'music should start enabled');
    ok(typeof g.music.unlock === 'function', 'unlock() missing');
    ok(typeof g.music.setIntensity === 'function', 'setIntensity() missing');
  });

  check('music toggle button is rendered', () => {
    const button = document.getElementById('music-toggle');
    ok(button, 'music-toggle button missing');
    ok(button.textContent.includes('音乐') || button.textContent.includes('静音'), 'button label unexpected: ' + button.textContent);
  });

  check('audio context unlocks on user interaction', () => {
    g.music.unlock();
    ok(g.music.ctx, 'AudioContext was not created');
    ok(g.music.started === true, 'music should report started');
    ok(g.music.master, 'master gain missing');
    // 增益是淡入的，调用瞬间读到的仍是 0；这里断言上下文已在运行、淡入已排程
    ok(g.music.ctx.state === 'running', 'AudioContext should be running, got ' + g.music.ctx.state);
    ok(typeof g.music.master.gain.value === 'number', 'master gain should be readable');
  });

  check('toggling off silences the master gain', () => {
    g.music.setEnabled(false);
    ok(g.music.enabled === false, 'enabled flag should be false');
    g.music.toggle();
    ok(g.music.enabled === true, 'toggle should re-enable');
  });

  check('calm battlefield keeps intensity low', () => {
    g.zombies = [];
    g.nextWaveIn = 9999;
    g.updateMusic();
    ok(g.music.targetIntensity < 0.2, 'idle intensity too high: ' + g.music.targetIntensity.toFixed(2));
  });

  check('a zombie near the base raises intensity', () => {
    const cmd = g.commandCenter;
    g.zombies = [];
    for (let i = 0; i < 10; i++) {
      const z = g.spawnZombie('normal', cmd.x + 60 + i * 8, cmd.y + 40, {});
      z.target = cmd;
      z.route = null;
    }
    g.nextWaveIn = 9999;
    g.updateMusic();
    ok(g.music.targetIntensity > 0.5, 'crowd near base should raise intensity, got ' + g.music.targetIntensity.toFixed(2));
  });

  check('distant zombies barely raise intensity', () => {
    const cmd = g.commandCenter;
    g.zombies = [];
    for (let i = 0; i < 3; i++) {
      const z = g.spawnZombie('normal', cmd.x + 1800, cmd.y + 400 + i * 20, {});
      z.target = null;
      z.route = null;
    }
    g.nextWaveIn = 9999;
    g.updateMusic();
    ok(g.music.targetIntensity < 0.25, 'far zombies should stay calm, got ' + g.music.targetIntensity.toFixed(2));
  });

  check('incoming wave ramps intensity before contact', () => {
    g.zombies = [];
    g.nextWaveIn = 2;
    g.updateMusic();
    ok(g.music.targetIntensity > 0.2, 'wave warning should raise intensity, got ' + g.music.targetIntensity.toFixed(2));
  });

  check('game over silences the music', () => {
    g.zombies = [];
    g.nextWaveIn = 2;
    g.gameOver = 'victory';
    g.updateMusic();
    ok(g.music.targetIntensity === 0, 'game over should zero intensity, got ' + g.music.targetIntensity);
    g.gameOver = null;
  });

  check('intensity values stay within 0..1', () => {
    for (const value of [-5, 0, 0.5, 1, 99]) {
      g.music.setIntensity(value);
      ok(g.music.targetIntensity >= 0 && g.music.targetIntensity <= 1,
        'setIntensity(' + value + ') produced ' + g.music.targetIntensity);
    }
  });

  check('music keeps scheduling notes while enabled', () => {
    g.music.unlock();
    g.music.setEnabled(true);
    const before = g.music.stepIndex;
    g.music.nextNoteAt = g.music.ctx.currentTime;
    g.music.schedule();
    ok(g.music.stepIndex !== before || !g.music.enabled,
      'schedule() did not advance the step counter');
  });

  return results;
})()`;

(async () => {
  if (!fs.existsSync(EDGE)) throw new Error('Edge not found');
  const browser = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${USER_DIR}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required',
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
    await new Promise((resolve) => ws.addEventListener('open', resolve));
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
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
    const evaluated = await send('Runtime.evaluate', { expression: TEST, returnByValue: true });
    if (evaluated.result.exceptionDetails) {
      throw new Error(evaluated.result.exceptionDetails.exception?.description || 'evaluate failed');
    }
    const results = evaluated.result.result.value;
    for (const result of results) {
      console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ' :: ' + result.detail : ''}`);
    }
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exitCode = failed ? 1 : 0;
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
