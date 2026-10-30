/* Stage 11: world seed regression. Loads the same seed twice and different seeds, comparing maps. */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9391;
const USER_DIR = path.join(os.tmpdir(), `zrts-seed-${Date.now()}`);
const FILE_URL = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}?debug=1`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SAMPLE = `(() => {
  const g = window.__ZRTS__;
  // 将地形缩略到 24×16 用于指纹比较
  const small = document.createElement('canvas');
  small.width = 24;
  small.height = 16;
  const c = small.getContext('2d');
  c.drawImage(g.terrain, 0, 0, 24, 16);
  const data = c.getImageData(0, 0, 24, 16).data;
  let hash = 0;
  for (let i = 0; i < data.length; i += 4) {
    hash = (Math.imul(hash, 31) + data[i] + data[i + 1] * 7 + data[i + 2] * 13) >>> 0;
  }
  return JSON.stringify({
    seedText: document.getElementById('seed-label').textContent,
    urlSeed: new URLSearchParams(location.search).get('seed'),
    terrainHash: hash,
    resources: g.resourceNodes.map((n) => [n.resourceType, Math.round(n.x), Math.round(n.y)]),
    nests: g.spawnPoints.map((n) => [n.id, Math.round(n.x), Math.round(n.y)]),
    waveSpawn: g.currentWaveApproach ? null : null,
    approachSpawn: (function () { g.startNextWave(); return [Math.round(g.currentWaveApproach.spawn.x), Math.round(g.currentWaveApproach.spawn.y)]; })(),
    ruin: (function () { return null; })()
  });
})()`;

function launch(url) {
  return spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${USER_DIR}`, '--no-first-run', '--disable-gpu', '--window-size=1400,1000', url
  ], { stdio: 'ignore' });
}

async function connect() {
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
  const ws = new WebSocket(page.webSocketDebuggerUrl);
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
  await sleep(2400);
  return { ws, send };
}

async function sampleWith(url) {
  const browser = launch(url);
  try {
    const { ws, send } = await connect();
    try {
      const evaluated = await send('Runtime.evaluate', { expression: SAMPLE, returnByValue: true });
      if (evaluated.result.exceptionDetails) {
        throw new Error(evaluated.result.exceptionDetails.exception?.description || 'evaluate failed');
      }
      return JSON.parse(evaluated.result.result.value);
    } finally {
      ws.close();
    }
  } finally {
    browser.kill();
    await sleep(400);
    try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  }
}

(async () => {
  const results = [];
  const check = (name, fn) => {
    try { fn(); results.push([name, true, '']); }
    catch (error) { results.push([name, false, String(error.message || error)]); }
  };
  const ok = (value, message) => { if (!value) throw new Error(message); };

  const a = await sampleWith(`${FILE_URL}&seed=12345678`);
  const b = await sampleWith(`${FILE_URL}&seed=12345678`);
  const c = await sampleWith(`${FILE_URL}&seed=99999999`);

  check('same seed produces identical map', () => {
    ok(a.seedText === b.seedText, `seed labels differ: ${a.seedText} vs ${b.seedText}`);
    ok(a.terrainHash === b.terrainHash, `terrain hash differs: ${a.terrainHash} vs ${b.terrainHash}`);
    ok(JSON.stringify(a.resources) === JSON.stringify(b.resources), 'resource layout differs between identical seeds');
    ok(JSON.stringify(a.nests) === JSON.stringify(b.nests), 'nest layout differs between identical seeds');
    ok(JSON.stringify(a.approachSpawn) === JSON.stringify(b.approachSpawn), 'wave entry differs between identical seeds');
  });

  check('different seed produces a different map', () => {
    ok(a.terrainHash !== c.terrainHash, 'terrain hash did not change with seed');
  });

  check('seed is shown in HUD and URL', () => {
    ok(a.seedText.includes('12345678'), `HUD seed label missing: ${a.seedText}`);
    ok(a.urlSeed === '12345678', `URL seed missing: ${a.urlSeed}`);
  });

  check('no seed in URL generates and persists one', async () => {
    const d = await sampleWith(FILE_URL);
    ok(d.urlSeed && d.urlSeed.length > 0 && d.urlSeed !== 'null', 'no seed was written to the URL');
    ok(d.seedText.includes(d.urlSeed.padStart(8, '0')), `HUD label ${d.seedText} does not match URL seed ${d.urlSeed}`);
  });

  for (const [name, pass, detail] of results) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  }
  const failed = results.filter((r) => !r[1]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => {
  console.error('seed test error:', error.message);
  process.exitCode = 1;
});
