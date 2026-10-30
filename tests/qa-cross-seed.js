/* Cross-seed river/bridge/resource validation. */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPR = String.raw`(() => {
  const g = window.__ZRTS__;
  if (!g || !g.river) return { err: 'river not exposed' };
  let bridgesNotCovering = 0;
  let riverBlocksOffBridge = 0;
  for (const b of g.river.bridges) {
    const px = -Math.sin(b.angle), py = Math.cos(b.angle);
    let firstWater = null, lastWater = null;
    for (let s = -260; s <= 260; s += 2) {
      const d = g.riverDepth(b.x + px * s, b.y + py * s);
      if (d >= -2) { if (firstWater === null) firstWater = s; lastWater = s; }
    }
    if (firstWater !== null && (-b.width / 2 > firstWater || b.width / 2 < lastWater)) bridgesNotCovering++;
    // 桥面正中应可通行，桥外侧（沿河方向偏移半个桥长之外）应被水拦住
    const sideX = b.x + Math.cos(b.angle) * (b.length * 0.5 + 30);
    const sideY = b.y + Math.sin(b.angle) * (b.length * 0.5 + 30);
    if (g.isWaterBlocking(sideX, sideY, 12)) riverBlocksOffBridge++;
  }
  const types = Array.from(new Set(g.resourceNodes.map((n) => n.resourceType))).sort();
  return {
    bridges: g.river.bridges.length,
    bridgesNotCovering,
    riverBlocksOffBridge,
    nodes: g.resourceNodes.length,
    types: types.join('/'),
    firstSampleX: Math.round(g.river.samples[0].x)
  };
})()`;

(async () => {
  const seeds = ['1', '777', '31415926', '99999'];
  for (const seed of seeds) {
    const port = 9500 + Math.floor(Math.random() * 300);
    const userDir = path.join(os.tmpdir(), `zrts-xseed-${Date.now()}-${seed}`);
    const url = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}?debug=1&seed=${seed}`;
    const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${userDir}`, `--remote-debugging-port=${port}`, url], { stdio: 'ignore' });
    let targets = null;
    for (let i = 0; i < 60; i++) {
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
    await sleep(2800);
    const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) console.log('seed', seed, 'ERR', r.result.exceptionDetails.exception?.description);
    else console.log('seed', seed, JSON.stringify(r.result.result.value));
    ws.close(); child.kill(); await sleep(250);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})();
