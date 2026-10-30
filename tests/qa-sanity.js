/* Sanity check: load the game, let it run, catch page exceptions / console errors. */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9341;
const USER_DIR = path.join(os.tmpdir(), `zrts-sanity-${Date.now()}`);
const PAGE_URL = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}?debug=1`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STATE_EXPRESSION = `(async () => {
  const g = window.__ZRTS__;
  const logs = [];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // 让时间加速：直接推进多帧，模拟 60 秒游戏时间
  for (let i = 0; i < 1200; i++) {
    g.update(0.05);
    g.drawMinimap();
  }
  g.render(performance.now(), performance.now() - g.startedAt);

  const saved = { metal: g.metal };
  g.metal = 300;
  g.selectBuilding(g.commandCenter);
  const engineerButtonBefore = {
    disabled: document.getElementById('train-engineer').disabled,
    text: document.getElementById('train-engineer').textContent
  };
  g.metal = saved.metal;

  return JSON.stringify({
    units: g.units.length,
    engineers: g.getEngineerCount(),
    nests: g.spawnPoints.map((s) => [s.id, s.shieldNodes.length, s.maxHp, s.shieldNodes.map((n) => n.maxHp)]),
    engineerButton: !!document.getElementById('train-engineer'),
    engineerButtonBefore,
    wave: Number(g.nextWaveIn.toFixed(1)),
    waveNumber: g.waveNumber,
    zombies: g.zombies.length,
    gameOver: g.gameOver,
    victoryText: document.getElementById('result-title').textContent
  });
})()`;

(async () => {
  if (!fs.existsSync(EDGE)) throw new Error('Edge not found');
  const browser = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${USER_DIR}`,
    '--no-first-run',
    '--disable-gpu',
    '--window-size=1400,1000',
    PAGE_URL
  ], { stdio: 'ignore' });

  const exceptions = [];
  const consoleIssues = [];
  let ws;
  try {
    let page = null;
    for (let i = 0; i < 75; i++) {
      try {
        const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
        page = tabs.find((tab) => tab.type === 'page');
        if (page) break;
      } catch (error) {
        // still starting
      }
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
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      }
      if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(message.params.type)) {
        consoleIssues.push(`${message.params.type}: ${message.params.args.map((a) => a.value || a.description).join(' ')}`);
      }
    });
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = ++serial;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Runtime.enable');
    await sleep(2500);
    const state = await send('Runtime.evaluate', {
      expression: STATE_EXPRESSION,
      awaitPromise: true,
      returnByValue: true
    });
    if (state.result.exceptionDetails) {
      console.error('evaluate failed:', state.result.exceptionDetails.exception?.description);
      process.exitCode = 1;
    } else {
      console.log(state.result.result.value);
    }
    console.log('pageExceptions:', JSON.stringify(exceptions));
    console.log('consoleIssues:', JSON.stringify(consoleIssues));
    if (exceptions.length || consoleIssues.length) process.exitCode = 1;
  } finally {
    if (ws) ws.close();
    browser.kill();
    await sleep(300);
    try {
      fs.rmSync(USER_DIR, { recursive: true, force: true });
    } catch (error) {
      // ignore
    }
  }
})().catch((error) => {
  console.error('sanity error:', error.message);
  process.exitCode = 1;
});
