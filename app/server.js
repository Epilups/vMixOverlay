#!/usr/bin/env node
/* Floorball scoreboard overlay server — zero dependencies, Node 18+.
   Serves /overlay (vMix Web Browser input), /control (operator panel),
   a GET-friendly REST API (Stream Deck), and an SSE state stream. */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8712);
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');

/* ---------- config + state ---------- */

const loadConfig = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
let config = loadConfig();

const teamState = (t) => ({
  name: t.name, short: t.short, color: t.color, logo: t.logo || '',
  score: 0, penalties: [],
});

let state = {
  visible: true,
  period: 1,
  clock: { ms: config.countUp ? 0 : config.periodMinutes * 60000, running: false },
  home: teamState(config.home),
  away: teamState(config.away),
  maxPenalties: config.maxPenalties || 2,
  penaltyPresets: config.penaltyPresets,
  periodMinutes: config.periodMinutes,
  countUp: !!config.countUp,
  rev: 0,
};

/* ---------- SSE clients ---------- */

const clients = new Set();
let dirty = false;

function broadcast() {
  state.rev++;
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch (_) { clients.delete(res); } }
}
const touch = () => { dirty = true; };

/* ---------- clock ---------- */

const TICK = 100;
setInterval(() => {
  if (state.clock.running) {
    if (state.countUp) {
      state.clock.ms = Math.min(state.periodMinutes * 60000, state.clock.ms + TICK);
      if (state.clock.ms >= state.periodMinutes * 60000) state.clock.running = false;
    } else {
      state.clock.ms = Math.max(0, state.clock.ms - TICK);
      if (state.clock.ms === 0) state.clock.running = false;
    }
    // Floorball penalties run only while the game clock runs. Only the
    // active (displayed) slots tick — anything queued beyond maxPenalties
    // waits untouched until it's promoted into a slot.
    for (const side of ['home', 'away']) {
      const list = state[side].penalties;
      const activeCount = Math.min(list.length, state.maxPenalties);
      for (let i = 0; i < activeCount; i++) list[i].msLeft = Math.max(0, list[i].msLeft - TICK);
      const before = list.length;
      state[side].penalties = list.filter((p) => p.msLeft > 0);
      if (state[side].penalties.length !== before) dirty = true;
    }
    dirty = true;
  }
  if (dirty) { dirty = false; broadcast(); }
}, TICK);

/* ---------- helpers ---------- */

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const parseClock = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;              // seconds
  const m = s.match(/^(\d{1,3}):(\d{1,2})(?:\.(\d))?$/);      // mm:ss(.t)
  if (!m) return null;
  return (Number(m[1]) * 60 + Number(m[2])) * 1000 + (m[3] ? Number(m[3]) * 100 : 0);
};
const sideOf = (q) => (String(q.team || '').toLowerCase() === 'away' ? 'away' : 'home');
let penaltyId = 1;
const HARD_CAP = 6; // per side; anything past maxPenalties is queued, this just stops runaway input

/* Resolve a penalty by id or slot (1-based). Returns -1 when it doesn't exist. */
function findIndex(side, q, fallback) {
  const list = state[side].penalties;
  if (q.id != null) return list.findIndex((p) => p.id === Number(q.id));
  if (q.slot != null) {
    const i = parseInt(q.slot, 10) - 1;
    return i >= 0 && i < list.length ? i : -1;
  }
  return list.length > fallback ? fallback : -1;
}

/* ---------- API ---------- */

function api(pathname, q) {
  switch (pathname) {
    case '/api/state':
      return state;

    case '/api/score': {
      const s = sideOf(q);
      if (q.set != null) state[s].score = clamp(parseInt(q.set, 10) || 0, 0, 999);
      else state[s].score = clamp(state[s].score + (parseInt(q.delta, 10) || 0), 0, 999);
      touch(); return { ok: true, score: state[s].score };
    }

    case '/api/clock': {
      const a = String(q.action || '').toLowerCase();
      if (a === 'start') state.clock.running = true;
      else if (a === 'stop') state.clock.running = false;
      else if (a === 'toggle') state.clock.running = !state.clock.running;
      else if (a === 'reset') { state.clock.ms = state.countUp ? 0 : state.periodMinutes * 60000; state.clock.running = false; }
      else if (a === 'set') { const ms = parseClock(q.value); if (ms != null) state.clock.ms = ms; }
      else if (a === 'adjust') state.clock.ms = Math.max(0, state.clock.ms + (parseInt(q.secs, 10) || 0) * 1000);
      touch(); return { ok: true, clock: state.clock };
    }

    case '/api/period': {
      if (q.set != null) state.period = clamp(parseInt(q.set, 10) || 1, 1, 9);
      else state.period = clamp(state.period + (parseInt(q.delta, 10) || 0), 1, 9);
      if (String(q.resetClock) === '1') {
        state.clock.ms = state.countUp ? 0 : state.periodMinutes * 60000;
        state.clock.running = false;
      }
      touch(); return { ok: true, period: state.period };
    }

    /* ---- Penalties -------------------------------------------------------
       One list per side, ordered. Its index IS the slot: slot 1 is the top
       box on the overlay, slot 2 the one below. Slots beyond maxPenalties
       are QUEUED: they don't tick and aren't drawn. When a slot empties
       (expired or released) everything below moves up one slot and a queued
       penalty starts automatically — no operator action needed.
       Every endpoint addresses a penalty by `slot` (1-based, Stream-Deck
       friendly) or by `id` (stable, used by the control panel), and is a
       no-op when that slot/id doesn't exist. */

    case '/api/penalty/add': {
      const s = sideOf(q);
      if (state[s].penalties.length >= HARD_CAP) return { ok: false, reason: 'cap', penalties: state[s].penalties };
      const secs = clamp(parseInt(q.secs, 10) || state.penaltyPresets[0].secs, 1, 3600);
      const preset = state.penaltyPresets.find((p) => p.secs === secs);
      // Align to the game clock's current sub-second phase (it drifts off a
      // clean multiple of 1000 over time since ticks aren't wall-clock exact)
      // so this penalty's displayed seconds flip in lockstep with the clock
      // forever after, instead of drifting up to ~1s apart from it. Subtract
      // (not add) the needed remainder so the displayed duration still reads
      // as exactly `secs` instead of rounding up to secs+1.
      // Both flip on a multiple of 1000, but the clock runs towards the
      // penalty when counting down and away from it when counting up, so the
      // quantity held invariant is msLeft - clock.ms one way and
      // msLeft + clock.ms the other. Each needs the opposite correction.
      const phase = ((state.clock.ms % 1000) + 1000) % 1000;
      const ms = secs * 1000 - (state.countUp ? phase : (1000 - phase) % 1000);
      state[s].penalties.push({
        id: penaltyId++,
        msTotal: ms,
        msLeft: ms,
        label: q.label ? String(q.label).slice(0, 16) : (preset ? preset.label : Math.round(secs / 60) + ' min'),
      });
      touch(); return { ok: true, slot: state[s].penalties.length, penalties: state[s].penalties };
    }

    /* Release one penalty early. No args = the one that expires first (slot 1),
       which is what a goal against a short-handed team needs. */
    case '/api/penalty/end': {
      const s = sideOf(q);
      const i = findIndex(s, q, 0);
      if (i < 0) return { ok: false, reason: 'empty slot', penalties: state[s].penalties };
      state[s].penalties.splice(i, 1);
      touch(); return { ok: true, penalties: state[s].penalties };
    }

    /* Nudge a running penalty: secs=+10 / -10 (also accepts value=1:30 to set exactly). */
    case '/api/penalty/adjust': {
      const s = sideOf(q);
      const i = findIndex(s, q, 0);
      if (i < 0) return { ok: false, reason: 'empty slot', penalties: state[s].penalties };
      const p = state[s].penalties[i];
      const exact = parseClock(q.value);
      if (exact != null) p.msLeft = clamp(exact, 0, 3600000);
      else p.msLeft = clamp(p.msLeft + (parseInt(q.secs, 10) || 0) * 1000, 0, 3600000);
      if (p.msLeft > p.msTotal) p.msTotal = p.msLeft; // keep the drain bar sane
      if (p.msLeft === 0) state[s].penalties.splice(i, 1);
      touch(); return { ok: true, penalties: state[s].penalties };
    }

    /* Swap slot 1 and 2 — for when the timekeeper called them in the wrong order. */
    case '/api/penalty/swap': {
      const s = sideOf(q);
      const a = clamp((parseInt(q.a, 10) || 1) - 1, 0, HARD_CAP - 1);
      const b = clamp((parseInt(q.b, 10) || 2) - 1, 0, HARD_CAP - 1);
      const list = state[s].penalties;
      if (!list[a] || !list[b]) return { ok: false, reason: 'empty slot', penalties: list };
      [list[a], list[b]] = [list[b], list[a]];
      touch(); return { ok: true, penalties: list };
    }

    case '/api/penalty/clear': {
      const s = sideOf(q);
      state[s].penalties = [];
      touch(); return { ok: true };
    }

    case '/api/overlay': {
      const v = String(q.show || 'toggle').toLowerCase();
      state.visible = v === 'toggle' ? !state.visible : !(v === '0' || v === 'false' || v === 'hide');
      touch(); return { ok: true, visible: state.visible };
    }

    case '/api/teams': {
      for (const s of ['home', 'away']) {
        for (const k of ['name', 'short', 'color', 'logo']) {
          const key = `${s}${k[0].toUpperCase()}${k.slice(1)}`;
          if (q[key] != null) state[s][k] = String(q[key]).slice(0, 40);
        }
      }
      if (q.swap === '1') { const h = state.home, a = state.away; state.home = a; state.away = h; }
      touch(); return { ok: true };
    }

    case '/api/reset': {
      state.period = 1;
      state.clock = { ms: state.countUp ? 0 : state.periodMinutes * 60000, running: false };
      for (const s of ['home', 'away']) { state[s].score = 0; state[s].penalties = []; }
      touch(); return { ok: true };
    }

    case '/api/config/save': {
      const next = {
        ...config,
        home: { name: state.home.name, short: state.home.short, color: state.home.color, logo: state.home.logo },
        away: { name: state.away.name, short: state.away.short, color: state.away.color, logo: state.away.logo },
        periodMinutes: state.periodMinutes,
      };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
      config = next;
      return { ok: true, saved: true };
    }

    default:
      return null;
  }
}

/* ---------- static + routing ---------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

function serveStatic(res, rel) {
  const file = path.join(ROOT, 'public', rel.replace(/^\/+/, ''));
  if (!file.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const q = Object.fromEntries(u.searchParams);
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (u.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (u.pathname.startsWith('/api/')) {
    const out = api(u.pathname, q);
    if (out == null) { res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"unknown endpoint"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }

  if (u.pathname === '/' ) { res.writeHead(302, { Location: '/control' }).end(); return; }
  if (u.pathname === '/overlay') { serveStatic(res, 'overlay.html'); return; }
  if (u.pathname === '/control') { serveStatic(res, 'control.html'); return; }
  serveStatic(res, u.pathname);
}).listen(PORT, () => {
  console.log(`\n  Floorball scoreboard running`);
  console.log(`  Control panel : http://localhost:${PORT}/control`);
  console.log(`  vMix overlay  : http://localhost:${PORT}/overlay   (Web Browser input, 1920x1080)\n`);
});
