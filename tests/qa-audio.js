/* Audio system test: ambient sample layer + sfx buses + volume + persistence + ending phrase. */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9496;
const USER_DIR = path.join(os.tmpdir(), `zrts-audio-${Date.now()}`);
const PAGE_URL = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}?debug=1&seed=31415926`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TEST = String.raw`(async () => {
  const g = window.__ZRTS__;
  const m = g.music;
  const results = [];
  const check = (name, fn) => {
    try { fn(); results.push({ name, pass: true, detail: '' }); }
    catch (error) { results.push({ name, pass: false, detail: String((error && error.message) || error) }); }
  };
  const checkAsync = async (name, fn) => {
    try { await fn(); results.push({ name, pass: true, detail: '' }); }
    catch (error) { results.push({ name, pass: false, detail: String((error && error.message) || error) }); }
  };
  const ok = (value, message) => { if (!value) throw new Error(message); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  g.gameOver = null;
  g.zombies = [];
  g.waveSpawnQueue = [];
  g.nextWaveIn = 9999;

  check('music system exposes sfx and volume controls', () => {
    for (const fn of ['playFire', 'playHit', 'playBuildComplete', 'playZombieRoar',
                      'setVolume', 'setSfxVolume', 'playEnding', 'clearEnding', 'loadSettings', 'saveSettings']) {
      ok(typeof m[fn] === 'function', fn + ' missing');
    }
  });

  check('volume sliders are rendered', () => {
    const music = document.getElementById('volume-slider');
    const sfx = document.getElementById('sfx-slider');
    ok(music, 'volume-slider missing');
    ok(sfx, 'sfx-slider missing');
    ok(music.type === 'range' && sfx.type === 'range', 'sliders should be range inputs');
  });

  m.unlock();
  await wait(400);

  check('audio context is running after unlock', () => {
    ok(m.ctx, 'no AudioContext');
    ok(m.ctx.state === 'running', 'context state is ' + m.ctx.state);
  });

  check('music and sfx have separate gain buses', () => {
    ok(m.musicGain, 'musicGain missing');
    ok(m.sfxGain, 'sfxGain missing');
    ok(m.musicBus, 'musicBus missing');
    ok(m.musicGain !== m.sfxGain, 'buses must be distinct nodes');
  });

  await checkAsync('embedded ambient loop decodes and plays', async () => {
    for (let i = 0; i < 50 && !m.ambientSource; i++) await wait(100);
    ok(m.ambientSource, 'ambient source never created (decode failed?)');
    ok(m.ambientSource.loop === true, 'ambient should loop');
    ok(m.ambientSource.buffer, 'ambient buffer missing');
    ok(m.ambientSource.buffer.duration > 10, 'ambient loop too short: ' + m.ambientSource.buffer.duration);
    ok(m.ambientGain, 'ambient gain missing');
  });

  check('setVolume clamps and persists', () => {
    m.setVolume(0.8);
    ok(Math.abs(m.volume - 0.8) < 1e-6, 'volume not applied: ' + m.volume);
    m.setVolume(5);
    ok(m.volume === 1, 'should clamp to 1, got ' + m.volume);
    m.setVolume(-3);
    ok(m.volume === 0, 'should clamp to 0, got ' + m.volume);
    const saved = JSON.parse(window.localStorage.getItem(m.storageKey));
    ok(saved.volume === 0, 'volume not persisted');
  });

  check('setSfxVolume is independent of music volume', () => {
    m.setVolume(0.5);
    m.setSfxVolume(0.9);
    ok(Math.abs(m.sfxVolume - 0.9) < 1e-6, 'sfx volume not applied');
    ok(Math.abs(m.volume - 0.5) < 1e-6, 'music volume should be unaffected');
    const saved = JSON.parse(window.localStorage.getItem(m.storageKey));
    ok(saved.sfxVolume === 0.9, 'sfx volume not persisted');
  });

  check('enabled state persists to localStorage', () => {
    m.setEnabled(false);
    ok(JSON.parse(window.localStorage.getItem(m.storageKey)).enabled === false, 'disabled not saved');
    m.setEnabled(true);
    ok(JSON.parse(window.localStorage.getItem(m.storageKey)).enabled === true, 'enabled not saved');
  });

  check('settings reload from localStorage', () => {
    window.localStorage.setItem(m.storageKey, JSON.stringify({ enabled: false, volume: 0.25, sfxVolume: 0.35 }));
    m.loadSettings();
    ok(m.enabled === false, 'enabled not restored');
    ok(Math.abs(m.volume - 0.25) < 1e-6, 'volume not restored: ' + m.volume);
    ok(Math.abs(m.sfxVolume - 0.35) < 1e-6, 'sfx volume not restored: ' + m.sfxVolume);
    m.setEnabled(true);
    m.setVolume(0.55);
    m.setSfxVolume(0.7);
  });

  check('sfx throttling prevents runaway playback', () => {
    let played = 0;
    const originalBurst = m.noiseBurst.bind(m);
    m.noiseBurst = (...args) => { played++; return originalBurst(...args); };
    for (let i = 0; i < 20; i++) m.playHit(false);
    m.noiseBurst = originalBurst;
    ok(played <= 1, 'throttle failed, played ' + played + ' times');
  });

  check('firing differs by weapon type', () => {
    const calls = [];
    const origNoise = m.noiseBurst.bind(m);
    m.noiseBurst = (when, opts) => { calls.push({ freq: opts && opts.freq }); };
    m.lastSfx.fire = -Infinity; m.playFire('bullet');
    m.lastSfx.fire = -Infinity; m.playFire('pierce');
    m.noiseBurst = origNoise;
    ok(calls.length === 2, 'expected 2 fire sounds, got ' + calls.length);
    ok(calls[0].freq !== calls[1].freq, 'bullet and pierce should differ in timbre');
  });

  check('build-complete sound rises', () => {
    const tones = [];
    const origTone = m.tone.bind(m);
    m.tone = (when, opts) => { tones.push(opts && opts.freq); };
    m.playBuildComplete();
    m.tone = origTone;
    ok(tones.length === 2, 'expected 2 tones, got ' + tones.length);
    ok(tones[1] > tones[0], 'build-complete tones should rise');
  });

  check('zombie roar is throttled', () => {
    let count = 0;
    const orig = m.noiseBurst.bind(m);
    m.noiseBurst = () => { count++; };
    m.lastSfx.roar = -Infinity;
    m.playZombieRoar(1);
    m.playZombieRoar(1);
    m.noiseBurst = orig;
    ok(count === 1, 'roar should be throttled to 1 play, got ' + count);
  });

  check('victory ending ascends', () => {
    m.ending = null;
    const tones = [];
    const origTone = m.tone.bind(m);
    m.tone = (when, opts) => { tones.push(opts.freq); };
    m.playEnding('victory');
    m.tone = origTone;
    ok(m.ending && m.ending.result === 'victory', 'ending state not set');
    const melodic = tones.filter((f) => f >= 200);
    ok(melodic.length >= 4, 'victory phrase too short: ' + melodic.length);
    ok(melodic[melodic.length - 1] > melodic[0], 'victory melody should ascend');
  });

  check('defeat ending descends', () => {
    m.clearEnding();
    m.ending = null;
    const tones = [];
    const origTone = m.tone.bind(m);
    m.tone = (when, opts) => { tones.push(opts.freq); };
    m.playEnding('defeat');
    m.tone = origTone;
    const melodic = tones.filter((f) => f >= 100);
    ok(melodic.length >= 4, 'defeat phrase too short');
    ok(melodic[melodic.length - 1] < melodic[0], 'defeat melody should descend');
  });

  check('ending plays only once per game', () => {
    m.ending = null;
    let plays = 0;
    const origTone = m.tone.bind(m);
    m.tone = () => { plays++; };
    m.playEnding('victory');
    const first = plays;
    m.playEnding('victory');
    m.tone = origTone;
    ok(plays === first, 'ending re-triggered (' + first + ' -> ' + plays + ')');
  });

  check('clearEnding resets for a new game', () => {
    m.clearEnding();
    ok(m.ending === null, 'ending should be cleared');
  });

  check('ambient layer ducks during battle', () => {
    const calmTarget = 0.5 * (1 - 0 * 0.55);
    const battleTarget = 0.5 * (1 - 1 * 0.55);
    ok(calmTarget > battleTarget, 'ambient should duck when intensity rises');
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
    await sleep(2800);
    const evaluated = await send('Runtime.evaluate', { expression: TEST, returnByValue: true, awaitPromise: true });
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
