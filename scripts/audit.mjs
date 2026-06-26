#!/usr/bin/env node
// Daily audit for arbox-bot. Reads CF KV, probes Arbox per user, recovers
// missed bookings, and posts a Telegram report to the admin.
//
// Env vars (set by GitHub Actions from repo secrets):
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, TELEGRAM_BOT_TOKEN, ADMIN_CHAT_ID

const NS = 'e8d8d3a6e8904f4c9aa78522235be4c7';
const ARBOX = 'https://apiappv2.arboxapp.com';
const TZ = 'Asia/Jerusalem';
const HORIZON_DAYS = 14;

const env = process.env;
for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'TELEGRAM_BOT_TOKEN', 'ADMIN_CHAT_ID']) {
  if (!env[k]) { console.error(`missing env ${k}`); process.exit(2); }
}

const cfHeaders = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
const kvBase = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${NS}`;

async function kvGet(key) {
  const r = await fetch(`${kvBase}/values/${encodeURIComponent(key)}`, { headers: cfHeaders });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`kvGet ${key} → ${r.status}`);
  return await r.text();
}

async function tg(text) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.ADMIN_CHAT_ID, parse_mode: 'HTML', text }),
  });
  if (!r.ok) console.error(`tg failed: ${r.status} ${await r.text()}`);
}

const esc = s => String(s == null ? '' : s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function dateInTz(d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
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
  if (Array.isArray(rule.slots) && rule.slots.length) return rule.slots;
  if (rule.time) return [{ time: rule.time, class: rule.class || null }];
  return [];
}

function findClassByTime(items, time, classNameSubstr) {
  const matches = items.filter(c => (c.time || '').startsWith(time));
  if (classNameSubstr) {
    const lc = classNameSubstr.toLowerCase();
    const refined = matches.filter(c => ((c.box_categories && c.box_categories.name) || '').toLowerCase().includes(lc));
    if (refined.length) return refined[0];
  }
  return matches[0] || null;
}

const DROP_IN = [/מקום\s*פנוי/i, /\d+\s*שעות?\s*לפני/i, /drop[\s-]?in/i, /stand[\s-]?by/i];
const isDropIn = m => DROP_IN.some(p => p.test((m.membership_types && m.membership_types.name) || ''));

async function arboxLogin(email, password, whitelabel = 'arbox') {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${ARBOX}/api/v2/user/login`, {
      method: 'POST',
      headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', whitelabel },
      body: JSON.stringify({ email, password }),
    });
    if (r.ok) {
      const j = await r.json();
      return { token: j.data.token, refresh: j.data.refreshToken };
    }
    if (r.status >= 500 && attempt === 0) { await new Promise(rr => setTimeout(rr, 300)); continue; }
    throw new Error(`login ${r.status}: ${(await r.text()).slice(0, 120)}`);
  }
}

const authH = (t, r, wl) => ({ Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', accesstoken: t, refreshtoken: r, whitelabel: wl });

async function arboxFetchPackage(ctx, boxId) {
  const r = await fetch(`${ARBOX}/api/v2/boxes/${boxId}/memberships/1`, { headers: authH(ctx.token, ctx.refresh, ctx.whitelabel) });
  if (!r.ok) throw new Error(`memberships ${r.status}`);
  const j = await r.json();
  const active = (j.data || []).filter(p => p.active === 1);
  const main = active.find(p => !isDropIn(p));
  return (main || active[0] || j.data[0]).id;
}

async function arboxSchedule(ctx, from, to) {
  const r = await fetch(`${ARBOX}/api/v2/schedule/betweenDates`, {
    method: 'POST', headers: authH(ctx.token, ctx.refresh, ctx.whitelabel),
    body: JSON.stringify({ from: `${from}T00:00:00.000Z`, to: `${to}T00:00:00.000Z`, locations_box_id: ctx.locationsBoxId }),
  });
  const j = await r.json();
  return j.data || [];
}

async function arboxBook(ctx, scheduleId) {
  const r = await fetch(`${ARBOX}/api/v2/scheduleUser/insert`, {
    method: 'POST', headers: authH(ctx.token, ctx.refresh, ctx.whitelabel),
    body: JSON.stringify({ extras: null, membership_user_id: ctx.packageId, schedule_id: scheduleId }),
  });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  return { ok: r.ok, status: r.status, body, text };
}
async function arboxBookOrWaitlist(ctx, scheduleId) {
  const r = await fetch(`${ARBOX}/api/v2/scheduleStandBy/insert`, {
    method: 'POST', headers: authH(ctx.token, ctx.refresh, ctx.whitelabel),
    body: JSON.stringify({ extras: null, membership_user_id: ctx.packageId, schedule_id: scheduleId }),
  });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  let mode = 'unknown';
  if (body?.data?.user_booked) mode = 'book';
  else if (body?.data?.user_in_standby) mode = 'waitlist';
  return { ok: r.ok, status: r.status, body, text, mode };
}
async function bookWithFallback(ctx, scheduleId, useWaitlist) {
  const res = await arboxBook(ctx, scheduleId);
  if (res.ok) return { ...res, mode: 'book' };
  if (useWaitlist) return await arboxBookOrWaitlist(ctx, scheduleId);
  return res;
}

async function auditUser(chatId) {
  const u = JSON.parse(await kvGet(`users:${chatId}`) || 'null');
  if (!u) return null;
  const rulesRaw = await kvGet(`rules:${chatId}`);
  const rules = (rulesRaw ? JSON.parse(rulesRaw) : []).filter(r => !r.paused && r.mode === 'race');
  if (!rules.length) return { user: u, onTrackCount: 0, fixes: [], issues: [] };

  let ctx;
  try {
    const login = await arboxLogin(u.email, u.password, u.whitelabel || 'arbox');
    ctx = { token: login.token, refresh: login.refresh, whitelabel: u.whitelabel || 'arbox', boxId: u.boxId, locationsBoxId: u.locationsBoxId };
    ctx.packageId = await arboxFetchPackage(ctx, ctx.boxId);
  } catch (e) {
    return { user: u, onTrackCount: 0, fixes: [], issues: [`❌ Login failed: ${e.message}`] };
  }

  const today = dateInTz(new Date());
  const horizon = dateInTz(new Date(Date.now() + HORIZON_DAYS * 86400000));
  const items = await arboxSchedule(ctx, today, horizon);
  const nowMs = Date.now();
  const fixes = [], issues = [];
  let onTrack = 0;

  for (const rule of rules) {
    const knownHours = rule.openHoursBefore || rule.detectedHoursBefore || u.detectedHoursBefore;
    if (!knownHours) continue;
    for (const slot of ruleSlots(rule)) {
      for (let d = 0; d < HORIZON_DAYS; d++) {
        const date = dateInTz(new Date(nowMs + d * 86400000));
        if (!rule.days.includes(wdayInTz(date))) continue;
        const classStartMs = israelDateTimeToUtcMs(date, slot.time);
        if (classStartMs < nowMs) continue;
        const opensAtMs = classStartMs - knownHours * 3_600_000;
        if (opensAtMs > nowMs) break; // window not opened yet — nothing to audit further out

        const klass = findClassByTime(items.filter(c => c.date === date), slot.time, slot.class);
        const label = `${date} ${slot.time}`;
        if (!klass) { issues.push(`⚠️ ${label} — gym hasn't published the class`); continue; }
        const name = (klass.box_categories && klass.box_categories.name) || slot.class || '?';
        if (klass.user_booked) { onTrack++; continue; }
        if (klass.user_in_standby) { onTrack++; continue; }

        const useWaitlist = rule.waitlistIfFull !== false;
        const res = await bookWithFallback(ctx, klass.id, useWaitlist);
        if (res.ok) {
          const tag = res.mode === 'waitlist' ? '📋 added to waitlist' : '🏁 booked';
          fixes.push(`✅ ${label} ${name} — ${tag}`);
        } else {
          const m = (res.body?.error?.messageToUser) || (res.body?.error?.message) || `HTTP ${res.status}`;
          issues.push(`❌ ${label} ${name} — could not recover: ${esc(m)}`);
        }
        break;
      }
    }
  }
  return { user: u, onTrackCount: onTrack, fixes, issues };
}

(async () => {
  const idxRaw = await kvGet('index:users');
  const userIds = idxRaw ? JSON.parse(idxRaw) : [];
  const reports = [];
  for (const chatId of userIds) {
    try { const r = await auditUser(chatId); if (r) reports.push(r); }
    catch (e) { reports.push({ user: { email: chatId }, onTrackCount: 0, fixes: [], issues: [`❌ Audit crashed: ${e.message}`] }); }
  }

  const anyAction = reports.some(r => r.fixes.length > 0 || r.issues.length > 0);
  const isSunday = wdayInTz(dateInTz(new Date())) === 'sun';
  const send = anyAction || isSunday;

  console.log(JSON.stringify({ anyAction, isSunday, send, reports }, null, 2));

  if (!send) { console.log('Clean weekday run — staying silent.'); return; }

  const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const header = anyAction ? `📊 Audit — ${stamp} Israel` : `✅ Weekly audit — ${stamp} Israel`;
  const sections = reports.map(r => {
    const lines = [`<b>${esc(r.user.email || '?')}</b>`];
    if (r.fixes.length) lines.push('', ...r.fixes);
    if (r.issues.length) lines.push('', ...r.issues);
    if (!r.fixes.length && !r.issues.length) lines.push(`✓ ${r.onTrackCount} upcoming booking${r.onTrackCount === 1 ? '' : 's'} on track`);
    return lines.join('\n');
  });
  await tg(`${header}\n\n${sections.join('\n\n')}`);
})().catch(e => { console.error('audit failed:', e); process.exit(1); });
