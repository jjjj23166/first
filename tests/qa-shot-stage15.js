/* Stage 15 screenshots: wave preview + counter feedback + gunner. */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP = String.raw`(() => {
  const g = window.__ZRTS__;
  g.hideIntro();
  g.gameOver = null;
  g.waveSpawnQueue = [];
  g.updateFog = function () {};
  g.drawFog = function () {};
  g.isWorldVisible = function () { return true; };

  // 布置一个能看清克制关系的战场：步兵 + 炮手 vs 血肉 / 快速 / 铁甲
  const cmd = g.buildings.find((b) => b.type === 'command');
  const UnitClass = g.units[0].constructor;

  g.units = [];
  const infantry = new UnitClass({
    id: 'demo-inf', name: '步兵-01', type: 'infantry', x: cmd.x - 60, y: cmd.y + 150,
    team: 'player', radius: 11, hp: 80, maxHp: 80, speed: 94, accent: '#8cc59b', idlePhase: 0
  });
  const gunner = new UnitClass({
    id: 'demo-gun', name: '炮手-01', type: 'gunner', x: cmd.x, y: cmd.y + 150,
    team: 'player', radius: 12, hp: 95, maxHp: 95, speed: 76, accent: '#e0a86a', idlePhase: 1
  });
  g.units.push(infantry, gunner);

  // 三种护甲一组，故意靠得很近以便看到范围伤害
  g.zombies = [];
  const place = (type, dx, dy) => {
    const z = g.spawnZombie(type, cmd.x + dx, cmd.y + dy, {});
    z.route = null; z.routeIndex = 0; z.target = null;
    return z;
  };
  const normal = place('normal', -30, 30);
  const fast1 = place('fast', 24, 34);
  const fast2 = place('fast', 44, 20);
  const heavy = place('heavy', 60, 60);

  // 让克制反馈立刻可见
  g.damageZombie(heavy, 14, infantry, 'bullet');
  g.damageZombie(heavy, 14, gunner, 'pierce');
  g.damageZombie(fast1, 16, gunner, 'blast');

  // 造一次精英波预告，展示状态条
  g.waveNumber = 3;
  g.wavePreview = { wave: 4, total: 9, isElite: true, composition: { brute: 2, heavy: 2, fast: 3, normal: 2 }, hint: '精英波 · 暴君来袭，需要穿甲火力' };
  g.nextWaveIn = 18;
  g.syncWavePreview();
  g.updateHud();

  g.camera.zoom = g.camera.maxZoom;
  g.centerCameraOn(cmd.x + 10, cmd.y + 100);
  // 清掉之前的飘字，保证截图时只显示最新一批（飘字只活 620ms）
  g.damageNumbers = [];
  return { units: g.units.length, zombies: g.zombies.length, cmd: { x: cmd.x, y: cmd.y } };
})()`;

/* 截图前一刻再打一轮伤害，确保飘字还在生命周期内 */
const BURST = String.raw`(() => {
  const g = window.__ZRTS__;
  const cmd = g.buildings.find((b) => b.type === 'command');
  const infantry = g.units.find((u) => u.type === 'infantry');
  const gunner = g.units.find((u) => u.type === 'gunner');
  g.damageNumbers = [];
  for (const z of g.zombies) {
    if (!z.alive) continue;
    if (z.armor === 'armor') {
      g.damageZombie(z, 14, infantry, 'bullet');   // 被护甲吃掉
      g.damageZombie(z, 14, gunner, 'pierce');     // 穿甲暴击
    } else if (z.armor === 'swift') {
      g.damageZombie(z, 16, gunner, 'blast');      // 范围暴击
    } else {
      g.damageZombie(z, 12, infantry, 'bullet');   // 正常
    }
  }
  // 让波次预告保持在场
  g.waveNumber = 3;
  g.wavePreview = { wave: 4, total: 9, isElite: true, composition: { brute: 2, heavy: 2, fast: 3, normal: 2 }, hint: '精英波 · 暴君来袭' };
  g.nextWaveIn = 18;
  g.syncWavePreview();
  return g.damageNumbers.length;
})()`;

(async () => {
  const port = 9451;
  const userDir = path.join(os.tmpdir(), `zrts-shot15-${Date.now()}`);
  const url = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}?debug=1&seed=31415926`;
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--window-size=1400,1000', `--user-data-dir=${userDir}`, `--remote-debugging-port=${port}`, url], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 80; i++) {
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
  await sleep(3200);
  const setup = await send('Runtime.evaluate', { expression: SETUP, returnByValue: true, awaitPromise: true });
  if (setup.result.exceptionDetails) console.log('ERR', setup.result.exceptionDetails.exception?.description);
  else console.log('setup', JSON.stringify(setup.result.result.value));
  await sleep(300);
  const burst = await send('Runtime.evaluate', { expression: BURST, returnByValue: true, awaitPromise: true });
  if (burst.result.exceptionDetails) console.log('BURST ERR', burst.result.exceptionDetails.exception?.description);
  else console.log('damage numbers:', burst.result.result.value);
  await sleep(120);
  const cap = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(process.cwd(), 'stage15-strategy.png'), Buffer.from(cap.result.data, 'base64'));
  console.log('wrote stage15-strategy.png');
  ws.close(); child.kill(); await sleep(300);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
})();
