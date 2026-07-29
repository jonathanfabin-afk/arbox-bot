// Local race runner. Runs on your laptop in Israel to beat the ~120ms
// Frankfurt-to-Israel latency the CF Worker eats on every POST.
//
// Design: minimal, single-purpose. This does ONE thing — win the race.
// Everything else (audits, reminders, waitlist watching, /today command)
// stays on the CF Worker. Both fire at opens_at; whichever POST lands at
// Arbox first books, the other gets a "you're already booked" response.
//
// Loop shape:
//   startup → login all users → for each rule → schedule a fire at opens_at
//   on fire: fetch class id → precision-wait to T=0 → POST → notify
//   after fire: reschedule for the next occurrence
//
// Auth stays warm: relogin every 10 min in the background so the POST path
// never blocks on a cold login.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Agent, setGlobalDispatcher } from 'undici';

// Keep TCP+TLS connections to Arbox warm for a long time. Node's default
// undici pool times out idle connections at 4s — meaning our first request
// after 6h between races pays a full TCP+TLS handshake (~200-500ms). We can't
// afford that in the fire path. Bumping to 10 min holds the pool through the
// pre-warm → fire window; connections are lightweight to hold open.
setGlobalDispatcher(new Agent({
  keepAliveTimeout: 10 * 60 * 1000,
  keepAliveMaxTimeout: 30 * 60 * 1000,
  pipelining: 1,
  connect: { timeout: 10_000 },
}));

// Single-instance guard. Task Scheduler's IgnoreNew doesn't work when the
// scheduled task is a launcher that exits immediately (wscript forks cmd/node
// and returns — TS thinks the task completed and re-fires the trigger). Without
// this check we'd spawn a new node process every repetition tick and end up
// with N concurrent runners eating RAM. Lockfile pattern is bulletproof.
const LOCK_FILE = path.resolve(process.cwd(), 'race-runner.lock');
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
if (fs.existsSync(LOCK_FILE)) {
  const other = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
  if (Number.isFinite(other) && other !== process.pid && isPidAlive(other)) {
    console.log(new Date().toISOString(), `another instance is running (pid=${other}). Exiting.`);
    process.exit(0); // Exit 0 so run.bat doesn't restart in a tight loop.
  }
  // Stale lock — previous instance died without cleanup. Take over.
}
fs.writeFileSync(LOCK_FILE, String(process.pid));
const cleanupLock = () => { try { fs.unlinkSync(LOCK_FILE); } catch {} };
process.on('exit', cleanupLock);
process.on('SIGINT', () => { cleanupLock(); process.exit(0); });
process.on('SIGTERM', () => { cleanupLock(); process.exit(0); });

// Refuse to die on transient errors. Race fires depend on this process staying
// alive for days at a time; a single uncaught rejection from a flaky network
// call must not take the whole thing down.
process.on('uncaughtException', (e) => {
  console.error(new Date().toISOString(), 'uncaughtException:', e.message, e.stack);
});
process.on('unhandledRejection', (r) => {
  console.error(new Date().toISOString(), 'unhandledRejection:', r?.message || r);
});
// Heartbeat so we can tell in the log if the process ever went silent.
setInterval(() => console.log(new Date().toISOString(), 'heartbeat', 'rss=' + Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB'), 5 * 60 * 1000);

const NS = 'e8d8d3a6e8904f4c9aa78522235be4c7';
const ARBOX = 'https://apiappv2.arboxapp.com';
const TZ = 'Asia/Jerusalem';
const LOGIN_TTL_MS = 10 * 60 * 1000;
const HORIZON_DAYS = 21;
const PRE_FIRE_LEAD_MS = 5000;   // start looking-alive this early
const AUTH_REFRESH_MS = 8 * 60 * 1000;

const env = process.env;
for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'TELEGRAM_BOT_TOKEN']) {
  if (!env[k]) { console.error(`missing env: ${k}`); process.exit(2); }
}
const NOTIFY_TAG = env.NOTIFY_TAG || 'local';
const ONLY_CHAT_IDS = env.ONLY_CHAT_IDS ? env.ONLY_CHAT_IDS.split(',').map(s => s.trim()).filter(Boolean) : null;

// ============================================================================
// CF KV (read-only) — same source of truth the Worker uses
// ============================================================================
const kvBase = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${NS}`;
const cfHeaders = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };

async function kvGet(key) {
  const r = await fetch(`${kvBase}/values/${encodeURIComponent(key)}`, { headers: cfHeaders });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`kvGet ${key} → ${r.status}`);
  return await r.text();
}
async function kvGetJson(key) { const t = await kvGet(key); return t ? JSON.parse(t) : null; }

async function loadUsers() {
  const index = await kvGetJson('index:users') || [];
  const out = [];
  for (const chatId of index) {
    if (ONLY_CHAT_IDS && !ONLY_CHAT_IDS.includes(String(chatId))) continue;
    const user = await kvGetJson(`users:${chatId}`);
    const rules = await kvGetJson(`rules:${chatId}`) || [];
    if (!user) continue;
    out.push({ chatId: String(chatId), user, rules: rules.filter(r => !r.paused && r.mode === 'race') });
  }
  return out;
}

// ============================================================================
// Arbox client — persistent session, warm auth
// ============================================================================
function authHeaders(session, wl) {
  // Header names match the CF Worker exactly (authH in src/worker.js).
  // NB: it's `refreshtoken`, not `accessrefreshtoken` — Arbox is picky.
  return {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    accesstoken: session.token,
    refreshtoken: session.refresh || '',
    whitelabel: wl,
  };
}

async function arboxLogin(email, password, wl) {
  // Match CF Worker headers exactly (Accept matters — Arbox is picky).
  // Retry once on 5xx (Arbox occasionally 504s at peak race moments).
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${ARBOX}/api/v2/user/login`, {
      method: 'POST',
      headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', whitelabel: wl },
      body: JSON.stringify({ email, password }),
    });
    const text = await r.text();
    let b = null; try { b = JSON.parse(text); } catch {}
    if (r.ok) return { token: b.data.token, refresh: b.data.refreshToken, userId: b.data.id };
    if (r.status >= 500 && attempt === 0) { await new Promise(res => setTimeout(res, 300)); continue; }
    throw new Error(`login ${r.status} ${text.slice(0, 150)}`);
  }
}

async function arboxFetchPackage(session, wl, boxId) {
  // Same endpoint the CF Worker uses (arboxFetchPackage in src/worker.js).
  // Prefer main plan; skip drop-in memberships if a real plan is present.
  const r = await fetch(`${ARBOX}/api/v2/boxes/${boxId}/memberships/1`, {
    headers: authHeaders(session, wl),
  });
  if (!r.ok) throw new Error(`memberships failed: ${r.status}`);
  const b = await r.json();
  const list = b.data || [];
  if (!list.length) throw new Error('no active package');
  const active = list.filter(p => p.active === 1);
  const isDropIn = p => {
    const name = (p.membership_types && p.membership_types.name) || '';
    return /drop.?in|חד.?פעמ/i.test(name);
  };
  const main = active.find(p => !isDropIn(p));
  return (main || active[0] || list[0]).id;
}

async function arboxSchedule(session, wl, locationsBoxId, dateStr) {
  const iso = `${dateStr}T00:00:00.000Z`;
  const r = await fetch(`${ARBOX}/api/v2/schedule/betweenDates`, {
    method: 'POST',
    headers: authHeaders(session, wl),
    body: JSON.stringify({ from: iso, to: iso, locations_box_id: locationsBoxId }),
  });
  const b = await r.json();
  return b.data || [];
}

// The "smart" endpoint — auto-books if room, otherwise waitlists.
// data.user_booked = booked; data.user_in_standby = waitlisted.
async function arboxBook(session, wl, packageId, scheduleId) {
  const r = await fetch(`${ARBOX}/api/v2/scheduleStandBy/insert`, {
    method: 'POST',
    headers: authHeaders(session, wl),
    body: JSON.stringify({ extras: null, membership_user_id: packageId, schedule_id: scheduleId }),
  });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  return { ok: r.ok, status: r.status, body, text };
}

// Warm the TCP+TLS connection to Arbox just before the race so the actual
// POST reuses the socket with zero handshake overhead. Uses the lightest
// authenticated endpoint we have — the getUserProfile GET returns fast and
// keeps the connection pooled for the imminent POST.
async function prewarmArboxConnection(session, wl) {
  try {
    await fetch(`${ARBOX}/api/v2/user/getUserProfile`, { method: 'GET', headers: authHeaders(session, wl) });
  } catch {}
}

// Fire 3 POSTs in parallel. The first successful response wins; the others
// arrive at Arbox as "already booked" no-ops. Same shape as the CF Worker's
// burstFire — helps when a single POST would fall in the slow tail of a
// long-tailed response-time distribution (~900ms Mon 07-27, killing Liron's race).
// Retries once immediately on 514 (Arbox's overload signal at peak race moments).
async function burstBook(session, wl, packageId, scheduleId) {
  const oneShot = async () => {
    let res = await arboxBook(session, wl, packageId, scheduleId);
    if (res.status === 514) res = await arboxBook(session, wl, packageId, scheduleId);
    return res;
  };
  // Small staggering so we don't hit Arbox with 3 packets in the same μs
  // (which historically triggered 429 rate limits on the CF Worker).
  const results = await Promise.all([
    oneShot(),
    new Promise(r => setTimeout(() => r(oneShot()), 20)),
    new Promise(r => setTimeout(() => r(oneShot()), 40)),
  ]);
  const ok = results.find(r => r.ok);
  return ok || results[0];
}

// ============================================================================
// Timezone helpers — mirror the CF Worker exactly so opens_at math matches
// ============================================================================
function dateInTz(d) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  return `${p.find(x => x.type === 'year').value}-${p.find(x => x.type === 'month').value}-${p.find(x => x.type === 'day').value}`;
}
function wdayInTz(dateStr) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(new Date(`${dateStr}T12:00:00Z`)).toLowerCase().slice(0, 3);
}
function israelDateTimeToUtcMs(dateStr, timeStr) {
  const probe = new Date(`${dateStr}T${timeStr}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' }).formatToParts(probe);
  const off = parts.find(p => p.type === 'timeZoneName').value;
  const m = off.match(/GMT([+-]\d+)(?::(\d+))?/);
  const hours = m ? parseInt(m[1], 10) : 3;
  const mins = m && m[2] ? parseInt(m[2], 10) : 0;
  const offsetMs = (hours * 60 + (hours < 0 ? -mins : mins)) * 60_000;
  return probe.getTime() - offsetMs;
}
function ruleSlots(rule) {
  if (Array.isArray(rule.slots)) return rule.slots;
  return [{ time: rule.time, class: rule.class }];
}

// ============================================================================
// Telegram
// ============================================================================
async function tg(chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, parse_mode: 'HTML', text }),
  });
  if (!r.ok) log(`tg failed to ${chatId}: ${r.status} ${await r.text()}`);
}
function escapeHtml(s) { return String(s || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }

// ============================================================================
// Race scheduling
// ============================================================================
function log(...args) { console.log(new Date().toISOString(), ...args); }

async function precisionSleep(ms) {
  if (ms <= 0) return;
  // setTimeout on Windows can drift 15ms. For the final leg we spin.
  if (ms > 20) {
    await new Promise(r => setTimeout(r, ms - 15));
  }
  const target = Date.now() + Math.max(0, ms - (ms > 20 ? ms - 15 : 0));
  while (Date.now() < target) { /* busy-wait the final millis */ }
}

function computeRacePosition(klass) {
  if (!klass.user_booked || !Array.isArray(klass.booked_users) || !klass.booked_users.length) return null;
  const sorted = [...klass.booked_users].sort((a, b) => (a.schedule_user_id || 0) - (b.schedule_user_id || 0));
  const idx = sorted.findIndex(u => u.schedule_user_id === klass.user_booked);
  return idx >= 0 ? { pos: idx + 1, of: sorted.length } : null;
}

// Sessions keyed by chatId. Each session has {token, refresh, packageId, lastLogin}.
const sessions = new Map();

async function ensureSession(chatId, user) {
  const existing = sessions.get(chatId);
  if (existing && (Date.now() - existing.lastLogin) < LOGIN_TTL_MS) return existing;
  const wl = user.whitelabel || 'arbox';
  const login = await arboxLogin(user.email, user.password, wl);
  const packageId = await arboxFetchPackage(login, wl, user.boxId);
  const s = { ...login, packageId, wl, locationsBoxId: user.locationsBoxId, lastLogin: Date.now() };
  sessions.set(chatId, s);
  log(`[${chatId}] session warmed (packageId=${packageId})`);
  return s;
}

function nextOccurrence(rule) {
  const now = Date.now();
  const knownHours = rule.openHoursBefore || rule.detectedHoursBefore;
  if (!knownHours) return null;
  for (const slot of ruleSlots(rule)) {
    for (let d = 0; d <= HORIZON_DAYS; d++) {
      const dateStr = dateInTz(new Date(now + d * 86400000));
      if (!rule.days.includes(wdayInTz(dateStr))) continue;
      const classStartMs = israelDateTimeToUtcMs(dateStr, slot.time);
      if (classStartMs <= now) continue;
      const opensAtMs = classStartMs - knownHours * 3_600_000;
      if (opensAtMs <= now) continue;
      return { dateStr, slot, classStartMs, opensAtMs, knownHours };
    }
  }
  return null;
}

// Fired once per (chatId, rule, occurrence). At end reschedules the next one.
async function scheduleRaceFire(chatId, user, rule) {
  const occ = nextOccurrence(rule);
  if (!occ) {
    log(`[${chatId}][${rule.id}] no upcoming occurrence — sleeping 1h then rechecking`);
    setTimeout(() => scheduleRaceFire(chatId, user, rule), 60 * 60 * 1000);
    return;
  }
  const untilOpen = occ.opensAtMs - Date.now();
  log(`[${chatId}][${rule.id}] next fire: ${occ.dateStr} ${occ.slot.time} "${occ.slot.class || '*'}" — in ${(untilOpen/1000/60).toFixed(1)}min`);

  // Sleep till PRE_FIRE_LEAD_MS before opens_at — then look alive.
  const preFireMs = Math.max(0, untilOpen - PRE_FIRE_LEAD_MS);
  await new Promise(r => setTimeout(r, preFireMs));

  try {
    const session = await ensureSession(chatId, user);
    // Fetch class list to resolve id. Do this in the last ~5s so registration
    // is guaranteed enabled by the time we hit the book endpoint.
    const items = await arboxSchedule(session, session.wl, session.locationsBoxId, occ.dateStr);
    const klass = items.find(c => (c.time || '').startsWith(occ.slot.time) &&
      (!occ.slot.class || ((c.box_categories && c.box_categories.name) || '').includes(occ.slot.class)));
    if (!klass) {
      log(`[${chatId}][${rule.id}] class not found in schedule`);
      setTimeout(() => scheduleRaceFire(chatId, user, rule), 30 * 60 * 1000);
      return;
    }

    // Prewarm the TCP+TLS connection ~500ms before opens_at so the real POST
    // is a keep-alive reuse (0-RTT for TCP, 0 handshake for TLS).
    const prewarmAt = occ.opensAtMs - 500;
    const untilPrewarm = prewarmAt - Date.now();
    if (untilPrewarm > 0) await precisionSleep(untilPrewarm);
    prewarmArboxConnection(session, session.wl).catch(() => {});

    // Precision-wait to opens_at.
    const remain = occ.opensAtMs - Date.now();
    await precisionSleep(remain);

    // FIRE — burst 3 parallel POSTs, retry each on 514.
    const t0 = performance.now();
    const res = await burstBook(session, session.wl, session.packageId, klass.id);
    const elapsedMs = performance.now() - t0;
    const arrivalOffset = Date.now() - occ.opensAtMs;
    log(`[${chatId}][${rule.id}] FIRED — arrived T+${arrivalOffset}ms, rt=${elapsedMs.toFixed(0)}ms, http=${res.status}`);

    // Refetch to see final state (BOOKED vs WL, position).
    let outcome = 'UNKNOWN', posTag = '';
    try {
      const after = await arboxSchedule(session, session.wl, session.locationsBoxId, occ.dateStr);
      const fresh = after.find(c => c.id === klass.id);
      if (fresh) {
        if (fresh.user_booked) {
          outcome = 'BOOKED';
          const rp = computeRacePosition(fresh);
          if (rp) posTag = ` — #${rp.pos}/${rp.of}`;
        } else if (fresh.user_in_standby) {
          outcome = `WAITLIST #${fresh.stand_by_position || '?'}`;
        }
      }
    } catch {}

    const name = (klass.box_categories && klass.box_categories.name) || occ.slot.class || '?';
    const emoji = outcome === 'BOOKED' ? '🏁' : outcome.startsWith('WAITLIST') ? '📋' : '❌';
    const msg = `${emoji} [${NOTIFY_TAG}] ${outcome} ${occ.dateStr} ${occ.slot.time} ${escapeHtml(name)}${posTag}\n<i>arrived T+${arrivalOffset}ms</i>`;
    await tg(chatId, msg);
  } catch (e) {
    log(`[${chatId}][${rule.id}] fire failed:`, e.message);
    try { await tg(chatId, `❌ [${NOTIFY_TAG}] race error ${occ.dateStr} ${occ.slot.time}: ${escapeHtml(e.message)}`); } catch {}
  }

  // Reschedule for next occurrence (usually a week out).
  setTimeout(() => scheduleRaceFire(chatId, user, rule), 60_000);
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  log('local race runner starting…');
  const users = await loadUsers();
  log(`loaded ${users.length} user(s), ${users.reduce((n, u) => n + u.rules.length, 0)} race rule(s)`);
  for (const { chatId, user, rules } of users) {
    log(`  ${chatId} · ${user.email} · ${rules.length} race rules`);
    // Warm session upfront so the first fire doesn't pay cold-login cost.
    try { await ensureSession(chatId, user); } catch (e) { log(`  ⚠ initial login failed: ${e.message}`); }
    // Keep session warm in the background.
    setInterval(async () => { try { await ensureSession(chatId, user); } catch (e) { log(`session refresh failed for ${chatId}: ${e.message}`); } }, AUTH_REFRESH_MS);
    for (const rule of rules) scheduleRaceFire(chatId, user, rule);
  }

  // Reload rules from KV every 15 min so wizard edits in the Telegram bot
  // take effect without restarting this process. For MVP we just re-run
  // scheduleRaceFire loops with fresh data on interval — this doesn't cancel
  // in-flight fires (they're idempotent — dup POST hits "already booked").
  setInterval(async () => {
    try {
      const refreshed = await loadUsers();
      log(`kv reload: ${refreshed.length} users, ${refreshed.reduce((n, u) => n + u.rules.length, 0)} rules`);
    } catch (e) { log(`kv reload failed: ${e.message}`); }
  }, 15 * 60 * 1000);
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
