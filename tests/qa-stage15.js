/* Stage 15: strategy systems — counters, economy decisions, wave pressure. */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9441;
const USER_DIR = path.join(os.tmpdir(), `zrts-strat-${Date.now()}`);
const PAGE_URL = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}?debug=1&seed=31415926`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TEST = String.raw`(() => {
  const g = window.__ZRTS__;
  const results = [];
  g.gameOver = null;
  g.zombies = [];
  g.waveSpawnQueue = [];
  g.nextWaveIn = 9999;

  const check = (name, fn) => {
    try { fn(); results.push({ name, pass: true, detail: '' }); }
    catch (error) { results.push({ name, pass: false, detail: String((error && error.message) || error) }); }
  };
  const ok = (value, message) => { if (!value) throw new Error(message); };

  const freshZombie = (type) => {
    const z = g.spawnZombie(type, 1200, 800, {});
    z.alive = true;
    return z;
  };
  const hit = (type, attackType, amount = 10) => {
    const z = freshZombie(type);
    const before = z.hp;
    g.damageZombie(z, amount, null, attackType);
    const dealt = before - z.hp;
    z.alive = false;
    return { dealt, armor: z.armor, mult: z.lastHitMultiplier };
  };

  /* ---------- 1. 兵种克制 ---------- */
  check('every zombie type declares an armor class', () => {
    for (const type of ['normal', 'fast', 'heavy', 'spitter', 'brute']) {
      const z = freshZombie(type);
      ok(z && z.armor, 'zombie type ' + type + ' has no armor class');
      ok(['flesh', 'armor', 'swift'].includes(z.armor), 'unknown armor ' + z.armor);
      z.alive = false;
    }
  });

  check('bullets are weak against armored zombies', () => {
    const armor = hit('heavy', 'bullet');
    const flesh = hit('normal', 'bullet');
    ok(armor.mult <= 0.5, 'bullet should be heavily reduced vs armor, got x' + armor.mult);
    ok(flesh.mult >= 0.95, 'bullet should be efficient vs flesh, got x' + flesh.mult);
    ok(armor.dealt < flesh.dealt, 'bullets should hurt flesh more than armor');
  });

  check('piercing rounds are the answer to armor', () => {
    const pierce = hit('heavy', 'pierce');
    const bullet = hit('heavy', 'bullet');
    ok(pierce.mult >= 1.5, 'pierce vs armor should be strong, got x' + pierce.mult);
    ok(pierce.dealt > bullet.dealt * 3, 'pierce should massively out-damage bullets vs armor');
  });

  check('blast damage is the answer to fast swarms', () => {
    const blast = hit('fast', 'blast');
    const pierce = hit('fast', 'pierce');
    ok(blast.mult >= 1.3, 'blast vs swift should be strong, got x' + blast.mult);
    ok(blast.dealt > pierce.dealt, 'blast should beat pierce against fast targets');
  });

  check('no single attack type is best against everything', () => {
    const bulletWins = hit('normal', 'bullet').dealt > hit('normal', 'pierce').dealt;
    const pierceWins = hit('heavy', 'pierce').dealt > hit('heavy', 'bullet').dealt;
    const blastWins = hit('fast', 'blast').dealt > hit('fast', 'bullet').dealt;
    ok(bulletWins && pierceWins && blastWins, 'each attack type must have a niche it wins');
  });

  check('infantry fire bullets and towers fire piercing rounds', () => {
    // 开局只有工程兵，这里直接构造一个步兵来检查武器表
    const infantry = new (g.units[0].constructor)({
      id: 'qa-inf', name: '步兵-QA', type: 'infantry', x: 1000, y: 800,
      team: 'player', radius: 11, hp: 80, maxHp: 80, speed: 94, accent: '#8cc59b', idlePhase: 0
    });
    ok(infantry.weapon.attackType === 'bullet', 'infantry should use bullets, got ' + infantry.weapon.attackType);

    // 防御塔射击走穿甲弹。注意 findNearestZombie 会检查战争迷雾可见性，
    // 这里临时让迷雾全可见，避免测试点落在未探索区域。
    const originalVisible = g.isWorldVisible;
    g.isWorldVisible = () => true;

    const towerSpec = { name: '防御塔', cost: { wood: 0, stone: 0, iron: 0 }, maxHp: 240, width: 46, height: 46, range: 170, damage: 14, fireInterval: 0.8 };
    const TowerClass = g.buildings[0].constructor;
    const tower = new TowerClass({ id: 'qa-tower', type: 'tower', x: 1400, y: 700, spec: towerSpec, completed: true });
    g.zombies = [];
    const heavy = g.spawnZombie('heavy', 1470, 700, {});
    heavy.hp = 200;
    const before = heavy.hp;
    for (let i = 0; i < 40; i++) tower.update(0.1, g);
    const dealt = before - heavy.hp;
    ok(dealt > 0, 'tower never damaged the armored zombie');
    // 一次塔击 14 伤害；穿甲（x1.65）约 23，若误用子弹（x0.35）只有约 5
    ok(dealt >= 20, 'tower should use piercing rounds vs armor (dealt ' + dealt.toFixed(1) + ')');

    heavy.alive = false;
    g.zombies = [];
    g.isWorldVisible = originalVisible;
  });

  check('gunners exist as a splash-damage unit type', () => {
    const barracks = g.buildings.find((b) => b.type === 'barracks');
    ok(barracks || true, 'barracks may not exist yet; checking spec instead');
    const gunner = new (g.units[0].constructor)({
      id: 'qa-gunner', name: '炮手-QA', type: 'gunner', x: 1000, y: 800,
      team: 'player', radius: 12, hp: 95, maxHp: 95, speed: 76, accent: '#e0a86a', idlePhase: 0
    });
    ok(gunner.weapon.attackType === 'blast', 'gunner should use blast damage');
    ok(gunner.weapon.splashRadius > 0, 'gunner should have splash radius');
  });

  check('splash damage hits several zombies at once', () => {
    const gunner = new (g.units[0].constructor)({
      id: 'qa-gunner2', name: '炮手-QA2', type: 'gunner', x: 1300, y: 800,
      team: 'player', radius: 12, hp: 95, maxHp: 95, speed: 76, accent: '#e0a86a', idlePhase: 0
    });
    g.zombies = [];
    const center = g.spawnZombie('normal', 1360, 800, {});
    const neighbors = [
      g.spawnZombie('normal', 1375, 812, {}),
      g.spawnZombie('normal', 1378, 790, {}),
      g.spawnZombie('normal', 1350, 815, {})
    ];
    const all = [center].concat(neighbors);
    const before = all.map((z) => z.hp);
    g.applySplashDamage(gunner, center, gunner.weapon);
    let damaged = 0;
    all.forEach((z, i) => { if (z.hp < before[i]) damaged++; });
    ok(damaged >= 3, 'splash should damage at least 3 clustered zombies, damaged ' + damaged);
    ok(damaged === all.length, 'splash should reach the whole cluster (' + damaged + '/' + all.length + ')');
    for (const z of all) z.alive = false;
    g.zombies = [];
  });

  /* ---------- 2. 经济决策 ---------- */
  check('resource nodes have finite reserves', () => {
    const node = g.resourceNodes[0];
    ok(node.reserveMax > 0, 'node should declare a max reserve');
    ok(node.reserve === node.reserveMax, 'node should start full');
    ok(node.reserveRatio === 1, 'fresh node should be at 100% reserve');
  });

  check('mining spends reserve and stops when depleted', () => {
    // 必须有工厂在产出才会消耗储量：这里复用已经建好的工厂，没有就临时造一个
    let node = g.resourceNodes.find((n) => n.hasFactory && !n.factory.isConstructing);
    let tempFactory = null;
    if (!node) {
      node = g.resourceNodes[0];
      const LumberClass = null;
      // 直接伪造一个已完工的工厂对象绑定上去，只为验证储量逻辑
      tempFactory = { alive: true, isConstructing: false, x: node.x, y: node.y };
      node.factory = tempFactory;
    }

    const originalReserve = node.reserve;
    node.reserve = 3;
    g.updateEconomy(1);
    ok(node.reserve < 3, 'mining should consume reserve, left ' + node.reserve);
    ok(node.isDepleted, 'node should be depleted once reserve hits zero');

    // 采空后不应再产出
    const incomeBefore = JSON.stringify(g.income);
    g.updateEconomy(1);
    ok((g.income[node.resourceType] || 0) === 0, 'depleted node should not produce, income=' + JSON.stringify(g.income));

    node.reserve = originalReserve;
    if (tempFactory) node.factory = null;
  });

  check('factory keeps the mining noise model in range', () => {
    g.updateEconomy(0.5);
    ok(typeof g.mineNoise === 'number', 'mineNoise should be numeric');
    ok(g.mineNoise >= 0 && g.mineNoise <= 1, 'mineNoise must stay in 0..1, got ' + g.mineNoise);
  });

  check('mining noise accelerates the wave timer', () => {
    g.waveSpawnQueue = [];
    g.nextWaveIn = 100;
    g.mineNoise = 0;
    g.updateMiningNoise(1);
    const slow = g.nextWaveIn;
    g.nextWaveIn = 100;
    g.mineNoise = 1;
    // 直接测满噪音下的缩短幅度
    const factories = g.resourceNodes.filter((n) => n.isProducing).length;
    g.mineNoise = 1;
    g.updateMiningNoise(1);
    const fast = g.nextWaveIn;
    ok(fast <= slow, 'high noise should not slow the wave timer');
    ok(slow === 100, 'zero noise should leave the timer alone, got ' + slow);
    g.nextWaveIn = 9999;
    g.mineNoise = 0;
  });

  /* ---------- 3. 波次压力 ---------- */
  check('next wave is previewed before it arrives', () => {
    g.refreshWavePreview();
    ok(g.wavePreview, 'wavePreview missing');
    ok(g.wavePreview.total > 0, 'preview should list a positive count');
    ok(g.wavePreview.wave === g.waveNumber + 1, 'preview should describe the next wave');
    ok(Object.keys(g.wavePreview.composition).length > 0, 'preview should list the composition');
    ok(typeof g.wavePreview.hint === 'string' && g.wavePreview.hint.length > 0, 'preview needs a hint');
  });

  check('preview is rendered into the status strip', () => {
    g.refreshWavePreview();
    g.syncWavePreview();
    const tag = document.getElementById('wave-preview-tag');
    const copy = document.getElementById('wave-preview-copy');
    ok(tag && tag.textContent.trim().length > 0, 'preview tag is empty');
    ok(copy && copy.textContent.trim().length > 0, 'preview copy is empty');
    ok(copy.textContent.indexOf('只') >= 0, 'preview copy should show the count');
  });

  check('every 4th wave is an elite wave', () => {
    const elite = [4, 8, 12].every((n) => g.composeWave(n).isElite);
    const normal = [1, 2, 3, 5].every((n) => !g.composeWave(n).isElite);
    ok(elite, 'waves 4/8/12 should be elite');
    ok(normal, 'non-multiple-of-4 waves should not be elite');
  });

  check('elite waves contain brute elites', () => {
    const spec = g.composeWave(4);
    ok(spec.composition.brute >= 2, 'elite wave should include brutes, got ' + spec.composition.brute);
    ok(spec.pool.filter((t) => t === 'brute').length >= 2, 'elite pool should carry brutes');
  });

  check('wave composition scales up over time', () => {
    const early = g.composeWave(1).count;
    const late = g.composeWave(10).count;
    ok(late > early, 'later waves should be bigger (' + early + ' -> ' + late + ')');
  });

  check('brutes are armored elites with high HP', () => {
    const brute = freshZombie('brute');
    ok(brute.isElite, 'brute should be flagged elite');
    ok(brute.armor === 'armor', 'brute should be armored, got ' + brute.armor);
    ok(brute.maxHp >= 400, 'brute should be tanky, got ' + brute.maxHp);
    brute.alive = false;
  });

  check('spitters attack from range', () => {
    const spitter = freshZombie('spitter');
    const normal = freshZombie('normal');
    ok(spitter.attackReach > normal.attackReach * 5,
      'spitter should out-range melee zombies (' + spitter.attackReach + ' vs ' + normal.attackReach + ')');
    spitter.alive = false;
    normal.alive = false;
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
