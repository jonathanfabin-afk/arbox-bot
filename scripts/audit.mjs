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

async function tg(chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, parse_mode: 'HTML', text }),
  });
  if (!r.ok) console.error(`tg ${chatId} failed: ${r.status} ${await r.text()}`);
}

async function kvPut(key, value) {
  await fetch(`${kvBase}/values/${encodeURIComponent(key)}`, {
    method: 'PUT', headers: cfHeaders, body: value,
  });
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
  u.chatId = chatId; // stamp it on so user-facing notifications can address them
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
  // Per-rule classification of "gym hasn't published" — collected to notify the
  // affected user once (not the admin). Keyed by rule.id + classification kind.
  const userRuleIssues = new Map(); // key = `${ruleId}|${kind}|${detail}` → human description
  let onTrack = 0;

  function classifyMissing(date, slot) {
    const dayItems = items.filter(c => c.date === date);
    if (!dayItems.length) return 'closed';
    const atTime = dayItems.filter(c => (c.time || '').startsWith(slot.time));
    if (!atTime.length) return 'no-such-time';
    return 'unpublished'; // class exists at the time but our filter didn't match — treat as noise
  }

  for (const rule of rules) {
    const knownHours = rule.openHoursBefore || rule.detectedHoursBefore || u.detectedHoursBefore;
    if (!knownHours) continue;
    for (const slot of ruleSlots(rule)) {
      for (let d = 0; d < HORIZON_DAYS; d++) {
        const date = dateInTz(new Date(nowMs + d * 86400000));
        const wd = wdayInTz(date);
        if (!rule.days.includes(wd)) continue;
        const classStartMs = israelDateTimeToUtcMs(date, slot.time);
        if (classStartMs < nowMs) continue;
        const opensAtMs = classStartMs - knownHours * 3_600_000;
        if (opensAtMs > nowMs) break; // window not opened yet — nothing to audit further out

        const klass = findClassByTime(items.filter(c => c.date === date), slot.time, slot.class);
        const label = `${date} ${slot.time}`;
        if (!klass) {
          const kind = classifyMissing(date, slot);
          if (kind === 'closed') {
            const key = `${rule.id}|closed|${wd}`;
            if (!userRuleIssues.has(key)) {
              userRuleIssues.set(key, `הכלל שלך כולל יום <b>${WEEKDAY_HE[wd]}</b>, אבל המכון סגור ביום זה (אין שיעורים בלוח).`);
            }
          } else if (kind === 'no-such-time') {
            const key = `${rule.id}|no-such-time|${slot.time}`;
            if (!userRuleIssues.has(key)) {
              // Suggest the times the gym actually runs (any day in the horizon)
              const allTimes = [...new Set(items.map(c => (c.time || '').slice(0, 5)).filter(Boolean))].sort();
              userRuleIssues.set(key, `הכלל שלך מבקש שיעור בשעה <b>${slot.time}</b>, אבל המכון לא מריץ שיעור בשעה הזאת.\nהשעות הקיימות בלוח: ${allTimes.join(', ') || '(אין)'}`);
            }
          }
          // 'unpublished' is silent — the gym just hasn't published this week's schedule yet
          continue;
        }
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

  // Notify the affected user about rule-config issues (debounced 7 days).
  let userNotified = false;
  if (userRuleIssues.size > 0) {
    const lastMs = parseInt((await kvGet(`audit:notified:${u.chatId || ''}`)) || '0', 10);
    if (Date.now() - lastMs > 7 * 86400000) {
      const lines = ['⚠️ <b>בעיות בכלל הרישום האוטומטי שלך</b>', '', 'יש משהו בכלל שלא מסתדר עם הלוח של המכון:', ''];
      for (const msg of userRuleIssues.values()) lines.push(`• ${msg}`, '');
      lines.push('בקש /recurring בבוט כדי לערוך או למחוק את הכלל הבעייתי.');
      try { await tg(u.chatId, lines.join('\n')); userNotified = true; await kvPut(`audit:notified:${u.chatId}`, String(Date.now())); } catch {}
    } else {
      userNotified = 'debounced';
    }
  }
  return { user: u, onTrackCount: onTrack, fixes, issues, userRuleIssueCount: userRuleIssues.size, userNotified };
}

const WEEKDAY_HE = { sun: 'ראשון', mon: 'שני', tue: 'שלישי', wed: 'רביעי', thu: 'חמישי', fri: 'שישי', sat: 'שבת' };

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

  const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const header = anyAction ? `📊 Audit — ${stamp} Israel` : `✅ Weekly audit — ${stamp} Israel`;
  const sections = reports.map(r => {
    const lines = [`<b>${esc(r.user.email || '?')}</b>`];
    if (r.fixes.length) lines.push('', ...r.fixes);
    if (r.issues.length) lines.push('', ...r.issues);
    if (r.userRuleIssueCount > 0) {
      const tag = r.userNotified === 'debounced' ? 'already notified <7d ago' : (r.userNotified ? 'notified user' : 'notification failed');
      lines.push('', `ℹ️ ${r.userRuleIssueCount} rule-config issue${r.userRuleIssueCount === 1 ? '' : 's'} — ${tag}`);
    }
    if (!r.fixes.length && !r.issues.length && !r.userRuleIssueCount) lines.push(`✓ ${r.onTrackCount} upcoming booking${r.onTrackCount === 1 ? '' : 's'} on track`);
    return lines.join('\n');
  });
  const fullReport = `${header}\n\n${sections.join('\n\n')}`;
  // Always persist the most recent report so /lastaudit in the bot can fetch it.
  await kvPut('audit:last_report', fullReport);
  await kvPut('audit:last_report_at', String(Date.now()));

  console.log(JSON.stringify({ anyAction, isSunday, send: anyAction || isSunday, reports }, null, 2));
  if (!(anyAction || isSunday)) { console.log('Clean weekday run — staying silent.'); return; }
  await tg(env.ADMIN_CHAT_ID, fullReport);
})().catch(e => { console.error('audit failed:', e); process.exit(1); });
