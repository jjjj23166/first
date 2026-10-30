/* Stage 16: campaign levels + endless mode (levels-work.html). */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FILE = 'levels-work.html';
const BASE_PORT = 9460;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 打开一个带 query 的页面，跑一段表达式，返回结果。 */
async function evaluate(port, query, expression, waitMs = 2600) {
  const userDir = path.join(os.tmpdir(), `zrts-lv-${Date.now()}-${port}`);
  const url = `file:///${path.join(process.cwd(), FILE).replace(/\\/g, '/')}?${query}`;
  const child = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${userDir}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1400,1000', url
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
    if (!page) throw new Error('no page for ' + query);

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
    await sleep(waitMs);
    const evaluated = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (evaluated.result.exceptionDetails) {
      throw new Error(evaluated.result.exceptionDetails.exception?.description || 'evaluate failed');
    }
    return evaluated.result.result.value;
  } finally {
    if (ws) ws.close();
    child.kill();
    await sleep(250);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  }
}

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

(async () => {
  if (!fs.existsSync(EDGE)) throw new Error('Edge not found');
  if (!fs.existsSync(FILE)) throw new Error(FILE + ' missing');

  const probe = String.raw`(() => {
    const g = window.__ZRTS__;
    if (!g) return { err: 'debug not exposed' };
    return {
      mode: g.levelMode,
      levelId: g.level ? g.level.id : null,
      levelName: g.level ? g.level.name : null,
      goalType: g.levelGoal ? g.levelGoal.type : null,
      resources: { wood: Math.round(g.resources.wood), stone: Math.round(g.resources.stone), iron: Math.round(g.resources.iron) },
      nests: g.spawnPoints.length,
      shieldCounts: g.spawnPoints.map((p) => p.shieldNodes.length),
      nestHps: g.spawnPoints.map((p) => p.maxHp),
      nestNames: g.spawnPoints.map((p) => p.name),
      levelTitle: g.levelTitle,
      timeLeft: g.levelTimeLeft,
      waveIntervalOverride: g.waveIntervalOverride,
      hasLevelOverlay: Boolean(document.getElementById('level-overlay')),
      hasLevelList: Boolean(document.getElementById('level-list'))
    };
  })()`;

  // ---- 关卡 1..5 ----
  const expectations = [
    { id: 1, name: '灰烬前哨', goal: 'nests', nests: 3, wood: 320, stone: 200, iron: 150 },
    { id: 2, name: '公路封锁', goal: 'survive', nests: 3, wood: 280, stone: 180, iron: 130 },
    { id: 3, name: '限时清剿', goal: 'timed', nests: 4, wood: 340, stone: 220, iron: 170 },
    { id: 4, name: '物资匮乏', goal: 'nests', nests: 3, wood: 110, stone: 70, iron: 50 },
    { id: 5, name: '母巢深处', goal: 'boss', nests: 1, wood: 420, stone: 280, iron: 220 }
  ];

  let port = BASE_PORT;
  for (const exp of expectations) {
    const data = await evaluate(port++, `debug=1&level=${exp.id}`, probe);
    if (data.err) {
      check(`level ${exp.id} loads`, false, data.err);
      continue;
    }
    check(`level ${exp.id} is ${exp.name}`, data.levelId === exp.id && data.levelName === exp.name,
      `id=${data.levelId} name=${data.levelName}`);
    check(`level ${exp.id} goal is ${exp.goal}`, data.goalType === exp.goal, `goal=${data.goalType}`);
    check(`level ${exp.id} has ${exp.nests} nest(s)`, data.nests === exp.nests, `nests=${data.nests}`);
    check(`level ${exp.id} starting resources`, data.resources.wood === exp.wood && data.resources.stone === exp.stone && data.resources.iron === exp.iron,
      JSON.stringify(data.resources));
    check(`level ${exp.id} HUD title`, Boolean(data.levelTitle) && data.levelTitle.includes(exp.name), data.levelTitle);
  }

  // ---- 关卡 5 的母巢特性 ----
  const boss = await evaluate(port++, 'debug=1&level=5', probe);
  check('boss level nest has more shields', boss.shieldCounts.length === 1 && boss.shieldCounts[0] >= 5,
    JSON.stringify(boss.shieldCounts));
  check('boss level nest has scaled HP', boss.nestHps.length === 1 && boss.nestHps[0] > 1200 * 2,
    JSON.stringify(boss.nestHps));
  check('boss level nest is named 母巢', boss.nestNames.length === 1 && boss.nestNames[0] === '母巢',
    JSON.stringify(boss.nestNames));

  // ---- 关卡 3 的限时倒计时 ----
  const timed = await evaluate(port++, 'debug=1&level=3', probe);
  check('timed level starts with a countdown', timed.timeLeft !== null && timed.timeLeft > 200 && timed.timeLeft <= 300,
    `timeLeft=${timed.timeLeft}`);

  // ---- 自由模式 ----
  const free = await evaluate(port++, 'debug=1&seed=777', probe);
  check('free mode has no level', free.mode === 'free' && free.levelId === null, `mode=${free.mode}`);
  check('free mode keeps 3 nests and default resources', free.nests === 3 && free.resources.wood === 260,
    `nests=${free.nests} wood=${free.resources.wood}`);
  check('free mode has no countdown', free.timeLeft === null, `timeLeft=${free.timeLeft}`);

  // ---- 无尽模式 ----
  const endless = await evaluate(port++, 'debug=1&level=endless', probe);
  check('endless mode loads', endless.mode === 'endless', `mode=${endless.mode}`);
  check('endless mode goal is endless', endless.goalType === 'endless', `goal=${endless.goalType}`);

  // ---- 无尽模式波次不封顶 ----
  const endlessWaves = await evaluate(port++, 'debug=1&level=endless', String.raw`(() => {
    const g = window.__ZRTS__;
    const counts = [];
    for (let w = 1; w <= 30; w++) {
      g.waveSpawnQueue = [];
      g.startNextWave();
      counts.push(g.waveSpawnQueue.length);
    }
    return { counts, finalWave: g.waveNumber, hpScale: g.waveHpScale, dmgScale: g.waveDamageScale };
  })()`);
  const maxCount = Math.max(...endlessWaves.counts);
  check('endless waves keep growing past wave 10', endlessWaves.counts[29] > endlessWaves.counts[9],
    `wave10=${endlessWaves.counts[9]} wave30=${endlessWaves.counts[29]}`);
  check('endless waves eventually exceed campaign cap of 26', maxCount > 26, `max=${maxCount}`);
  check('endless hp/damage scale past campaign caps', endlessWaves.hpScale > 1.9 && endlessWaves.dmgScale > 1.6,
    `hp=${endlessWaves.hpScale.toFixed(2)} dmg=${endlessWaves.dmgScale.toFixed(2)}`);

  // ---- 无尽模式第 5/10/15 波首领波 ----
  const bossWaves = await evaluate(port++, 'debug=1&level=endless', String.raw`(() => {
    const g = window.__ZRTS__;
    const out = {};
    for (let w = 1; w <= 15; w++) {
      g.waveSpawnQueue = [];
      g.startNextWave();
      out[g.waveNumber] = { count: g.waveSpawnQueue.length, heavies: g.waveSpawnQueue.filter((e) => e.type === 'heavy').length };
    }
    return out;
  })()`);
  check('endless every 5th wave is a boss wave',
    bossWaves['5'] && bossWaves['10'] && bossWaves['15']
      ? bossWaves['5'].count > bossWaves['4'].count && bossWaves['10'].count > bossWaves['9'].count
      : false,
    JSON.stringify({ w4: bossWaves['4'], w5: bossWaves['5'], w9: bossWaves['9'], w10: bossWaves['10'] }));

  // ---- 目标判定 ----
  const goals = await evaluate(port++, 'debug=1&level=2', String.raw`(() => {
    const g = window.__ZRTS__;
    const out = {};
    g.waveNumber = 1; g.waveSpawnQueue = []; g.zombies = [];
    out.surviveEarly = g.evaluateGoal();
    g.waveNumber = 6;
    out.surviveDone = g.evaluateGoal();
    g.zombies = [{ alive: true }];
    out.surviveWithZombies = g.evaluateGoal();
    g.zombies = [];
    return out;
  })()`);
  check('survive goal not met before target wave', goals.surviveEarly === null, String(goals.surviveEarly));
  check('survive goal met at wave N with clear field', goals.surviveDone === 'victory', String(goals.surviveDone));
  check('survive goal blocked while zombies remain', goals.surviveWithZombies === null, String(goals.surviveWithZombies));

  const nestsGoal = await evaluate(port++, 'debug=1&level=1', String.raw`(() => {
    const g = window.__ZRTS__;
    const out = {};
    out.before = g.evaluateGoal();
    for (const p of g.spawnPoints) { p.alive = false; }
    out.after = g.evaluateGoal();
    return out;
  })()`);
  check('nests goal unmet initially', nestsGoal.before === null, String(nestsGoal.before));
  check('nests goal met when all nests destroyed', nestsGoal.after === 'victory', String(nestsGoal.after));

  const timedGoal = await evaluate(port++, 'debug=1&level=3', String.raw`(() => {
    const g = window.__ZRTS__;
    const out = {};
    out.running = g.evaluateGoal();
    g.levelTimeLeft = 0;
    out.timeout = g.evaluateGoal();
    g.levelTimeLeft = 120;
    for (const p of g.spawnPoints) { p.alive = false; }
    out.cleared = g.evaluateGoal();
    return out;
  })()`);
  check('timed goal running is not a result', timedGoal.running === null, String(timedGoal.running));
  check('timed goal reports timeout at zero', timedGoal.timeout === 'timeout', String(timedGoal.timeout));
  check('timed goal victory when cleared in time', timedGoal.cleared === 'victory', String(timedGoal.cleared));

  // ---- 进度与解锁 ----
  const progress = await evaluate(port++, 'debug=1&level=1', String.raw`(() => {
    const g = window.__ZRTS__;
    try { window.localStorage.removeItem('zrts.progress.v1'); } catch (e) {}
    const fresh = g.readProgress();
    const after1 = g.unlockNextLevel(1);
    const after2 = g.unlockNextLevel(2);
    const after5 = g.unlockNextLevel(5);
    return { fresh, after1, after2, after5 };
  })()`);
  check('fresh progress starts at level 1 unlocked', progress.fresh.unlocked === 1 && progress.fresh.cleared.length === 0,
    JSON.stringify(progress.fresh));
  check('clearing level 1 unlocks level 2', progress.after1.unlocked === 2 && progress.after1.cleared.includes(1),
    JSON.stringify(progress.after1));
  check('clearing level 5 unlocks endless (6)', progress.after5.unlocked === 6,
    JSON.stringify({ unlocked: progress.after5.unlocked }));

  // ---- 选关界面 ----
  const ui = await evaluate(port++, 'debug=1&level=1', String.raw`(() => {
    const g = window.__ZRTS__;
    try { window.localStorage.removeItem('zrts.progress.v1'); } catch (e) {}
    g.openLevelSelect();
    const overlay = document.getElementById('level-overlay');
    const visible = overlay.classList.contains('is-visible');
    const items = overlay.querySelectorAll('.level-item');
    const locked = overlay.querySelectorAll('.level-item.is-locked');
    const endlessCard = overlay.querySelector('.level-endless-card');
    const endlessLocked = endlessCard ? endlessCard.classList.contains('is-locked') : null;
    g.closeLevelSelect();
    const afterClose = overlay.classList.contains('is-visible');

    try { window.localStorage.setItem('zrts.progress.v1', JSON.stringify({ unlocked: 6, cleared: [1,2,3,4,5], endlessBest: 12 })); } catch (e) {}
    g.openLevelSelect();
    const lockedAfter = overlay.querySelectorAll('.level-item.is-locked').length;
    const endlessLockedAfter = overlay.querySelector('.level-endless-card').classList.contains('is-locked');
    const bestText = overlay.querySelector('.level-endless-card .level-goal').textContent;
    g.closeLevelSelect();
    try { window.localStorage.removeItem('zrts.progress.v1'); } catch (e) {}
    return { visible, itemCount: items.length, lockedCount: locked.length, endlessLocked, afterClose, lockedAfter, endlessLockedAfter, bestText };
  })()`);
  check('level overlay opens', ui.visible === true, `visible=${ui.visible}`);
  check('overlay lists all 5 levels', ui.itemCount === 5, `count=${ui.itemCount}`);
  check('locked levels are marked', ui.lockedCount === 4, `locked=${ui.lockedCount}`);
  check('endless locked before clearing campaign', ui.endlessLocked === true, String(ui.endlessLocked));
  check('level overlay closes', ui.afterClose === false, `afterClose=${ui.afterClose}`);
  check('all levels unlock after progress', ui.lockedAfter === 0, `locked=${ui.lockedAfter}`);
  check('endless unlocks after clearing campaign', ui.endlessLockedAfter === false, String(ui.endlessLockedAfter));
  check('endless best record is shown', /12/.test(ui.bestText || ''), ui.bestText);

  // ---- 关卡 1 全流程：拆巢即胜 ----
  const winFlow = await evaluate(port++, 'debug=1&level=1', String.raw`(() => {
    const g = window.__ZRTS__;
    g.nextWaveIn = 9999; g.waveSpawnQueue = []; g.zombies = [];
    const before = g.gameOver;
    for (const p of g.spawnPoints) { p.alive = false; }
    g.checkGameState();
    const overlay = document.getElementById('result-overlay');
    return {
      before,
      after: g.gameOver,
      overlayVisible: overlay.classList.contains('is-visible'),
      isVictory: overlay.classList.contains('victory'),
      title: document.getElementById('result-title').textContent
    };
  })()`);
  check('clearing nests ends the level as victory', winFlow.after === 'victory' && winFlow.isVictory,
    `gameOver=${winFlow.after} victory=${winFlow.isVictory}`);
  check('victory shows level name', /灰烬前哨/.test(winFlow.title || ''), winFlow.title);

  // ---- 无尽模式最高记录 ----
  const record = await evaluate(port++, 'debug=1&level=endless', String.raw`(() => {
    const g = window.__ZRTS__;
    try { window.localStorage.removeItem('zrts.progress.v1'); } catch (e) {}
    g.waveNumber = 7;
    const first = g.saveEndlessRecord();
    g.waveNumber = 3;
    const lower = g.saveEndlessRecord();
    g.waveNumber = 15;
    const higher = g.saveEndlessRecord();
    try { window.localStorage.removeItem('zrts.progress.v1'); } catch (e) {}
    return { first, lower, higher };
  })()`);
  check('endless record saves the best wave', record.first === 7 && record.higher === 15,
    JSON.stringify(record));
  check('endless record never decreases', record.lower === 7, `lower=${record.lower}`);

  // ---- 无尽模式被摧毁即结束 ----
  const endlessOver = await evaluate(port++, 'debug=1&level=endless', String.raw`(() => {
    const g = window.__ZRTS__;
    g.waveNumber = 9;
    g.commandCenter.alive = false;
    g.checkGameState();
    return {
      gameOver: g.gameOver,
      kicker: document.getElementById('result-kicker').textContent,
      stats: document.getElementById('result-stats').textContent
    };
  })()`);
  check('endless mode ends when command center falls', endlessOver.gameOver === 'defeat', String(endlessOver.gameOver));
  check('endless result shows wave reached', /9/.test(endlessOver.stats || ''), endlessOver.stats);

  // ---- 输出 ----
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' :: ' + r.detail : ''}`);
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => {
  console.error('QA error:', error.message);
  process.exitCode = 1;
});
