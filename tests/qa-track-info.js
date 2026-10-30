/* Measure duration + loudness of the CC0 tracks in the browser. */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = path.join(process.cwd(), 'audio-src', 'sci-fi', 'ogg');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ogg') && !['hover.ogg', 'victory.ogg'].includes(f));
const payload = files.map((f) => ({ name: f, b64: fs.readFileSync(path.join(dir, f)).toString('base64') }));
console.log('tracks:', files.join(', '));

(async () => {
  const port = 9497;
  const userDir = path.join(os.tmpdir(), `zrts-dur-${Date.now()}`);
  const url = `file:///${path.join(process.cwd(), 'index.html').replace(/\\/g, '/')}?debug=1`;
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${userDir}`, `--remote-debugging-port=${port}`, url], { stdio: 'ignore' });
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
  await sleep(3000);

  const expr = `(async () => {
    const tracks = ${JSON.stringify(payload)};
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const out = [];
    for (const t of tracks) {
      const bin = atob(t.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      try {
        const buf = await ctx.decodeAudioData(bytes.buffer.slice(0));
        const d = buf.getChannelData(0);
        let peak = 0, sum = 0, n = 0;
        for (let i = 0; i < d.length; i += 200) { const v = Math.abs(d[i]); peak = Math.max(peak, v); sum += v * v; n++; }
        out.push({ name: t.name, dur: +buf.duration.toFixed(1), peak: +peak.toFixed(3), rms: +Math.sqrt(sum / n).toFixed(4) });
      } catch (e) { out.push({ name: t.name, error: String(e) }); }
    }
    return out;
  })()`;

  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) console.log('ERR', r.result.exceptionDetails.exception?.description);
  else for (const row of r.result.result.value) console.log(JSON.stringify(row));
  ws.close(); child.kill(); await sleep(250);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
})();
