// Multi-tenant Arbox Telegram bot — Cloudflare Worker.
//
// Per-Telegram-user (chat_id) state stored in KV:
//   users:<chat_id>    → { email, password, boxId, locationsBoxId, boxName, externalGymId, default_mode, created }
//   pending:<chat_id>  → onboarding state machine
//   rules:<chat_id>    → [ { id, days, time, class?, mode, openHoursBefore?, paused, created } ]
//   index:users        → [chat_id, ...]
//   ratemark:<rule_key>→ ISO timestamp of last booking attempt (rate-limit guard)

const ARBOX_BASE = 'https://apiappv2.arboxapp.com';
const TZ = 'Asia/Jerusalem';
const HORIZON_DAYS = 14;

// =============================================================================
// Telegram helpers
// =============================================================================

async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return await r.json();
}

async function send(env, chatId, text, opts = {}) {
  return tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...opts });
}

async function deleteMessage(env, chatId, messageId) {
  return tg(env, 'deleteMessage', { chat_id: chatId, message_id: messageId });
}

async function answerCallback(env, callbackId, text) {
  return tg(env, 'answerCallbackQuery', { callback_query_id: callbackId, text });
}

const escape = s => String(s == null ? '' : s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// =============================================================================
// Date helpers (Asia/Jerusalem timezone-aware)
// =============================================================================

function dateInTz(d, tz = TZ) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  return `${p.find(x => x.type === 'year').value}-${p.find(x => x.type === 'month').value}-${p.find(x => x.type === 'day').value}`;
}

function weekdayShortInTz(dateStr, tz = TZ) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
    .format(new Date(`${dateStr}T12:00:00Z`)).toLowerCase().slice(0, 3);
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const fmtDays = arr => arr.map(d => d[0].toUpperCase() + d.slice(1)).join(',');

// Compute the UTC instant (ms) of the given Israel-local date+time.
function israelDateTimeToUtcMs(dateStr, timeStr /* HH:MM */) {
  // Get the offset that Asia/Jerusalem has at that wall-clock instant by formatting back.
  // Simple approach: assume +02:00 / +03:00 and let Intl resolve. Build with the named TZ.
  // Trick: use the formatToParts of an arbitrary instant to derive TZ offset for the date.
  const probe = new Date(`${dateStr}T${timeStr}:00Z`);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' });
  const parts = fmt.formatToParts(probe);
  const off = parts.find(p => p.type === 'timeZoneName').value; // "GMT+3"
  const m = off.match(/GMT([+-]\d+)(?::(\d+))?/);
  const hours = m ? parseInt(m[1], 10) : 2;
  const mins = m && m[2] ? parseInt(m[2], 10) : 0;
  const offsetMs = (hours * 60 + (hours < 0 ? -mins : mins)) * 60_000;
  // dateStr+timeStr in IL local = UTC - offset
  const utcGuess = new Date(`${dateStr}T${timeStr}:00Z`).getTime() - offsetMs;
  return utcGuess;
}

// =============================================================================
// Arbox API client
// =============================================================================

// Known Arbox whitelabel app namespaces. Default 'arbox' covers most public gyms.
// Add more here as we discover them (each is a separate "app" with its own gym pool).
const KNOWN_WHITELABELS = ['arbox', 'wondare'];

const authH = (token, refresh, whitelabel = 'arbox') => ({
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  accesstoken: token,
  refreshtoken: refresh,
  whitelabel,
});

async function arboxLogin(email, password, whitelabel = 'arbox') {
  // One retry on 5xx — Arbox occasionally 504s right at peak race moments.
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${ARBOX_BASE}/api/v2/user/login`, {
      method: 'POST',
      headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', whitelabel },
      body: JSON.stringify({ email, password }),
    });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (r.ok) return { ok: true, token: j.data.token, refresh: j.data.refreshToken, userId: j.data.id, profile: j.data, whitelabel };
    if (r.status >= 500 && attempt === 0) {
      await new Promise(res => setTimeout(res, 300));
      continue;
    }
    return { ok: false, status: r.status, text, body: j, whitelabel };
  }
}

async function arboxFetchProfile(token, refresh, whitelabel = 'arbox') {
  const r = await fetch(`${ARBOX_BASE}/api/v2/user/profile`, { headers: authH(token, refresh, whitelabel) });
  if (!r.ok) throw new Error(`profile failed: ${r.status}`);
  const j = await r.json();
  return j.data;
}

// Drop-in / standby / "24h before" supplementary plans — deprioritize these.
// We want the broadest-window main plan so race rules can fire 72h+ ahead.
const DROP_IN_NAME_PATTERNS = [
  /מקום\s*פנוי/i,        // "available" supplementary plan
  /\d+\s*שעות?\s*לפני/i, // "X hours before"
  /drop[\s-]?in/i,
  /stand[\s-]?by/i,
];

function isDropInMembership(m) {
  const name = (m.membership_types && m.membership_types.name) || '';
  return DROP_IN_NAME_PATTERNS.some(p => p.test(name));
}

async function arboxFetchPackage(token, refresh, boxId, whitelabel = 'arbox') {
  const r = await fetch(`${ARBOX_BASE}/api/v2/boxes/${boxId}/memberships/1`, { headers: authH(token, refresh, whitelabel) });
  if (!r.ok) throw new Error(`memberships failed: ${r.status}`);
  const j = await r.json();
  if (!j.data || !j.data.length) throw new Error('no active package');
  const active = j.data.filter(p => p.active === 1);
  // Prefer an active main plan; fall back to drop-in only if nothing else exists.
  const main = active.find(p => !isDropInMembership(p));
  const picked = main || active[0] || j.data[0];
  const otherActive = active.filter(p => p.id !== picked.id);
  if (otherActive.length) {
    const names = otherActive.map(p => `"${(p.membership_types && p.membership_types.name) || '?'}" id=${p.id}`).join(', ');
    console.log(`[membership] picked id=${picked.id} "${(picked.membership_types && picked.membership_types.name) || '?'}" (skipped ${otherActive.length}: ${names})`);
  }
  return picked.id;
}

// Returns { token, refresh, userId, packageId, whitelabel } for the configured user.
async function arboxContext(user) {
  const wl = user.whitelabel || 'arbox';
  const login = await arboxLogin(user.email, user.password, wl);
  if (!login.ok) throw new Error(`login failed: ${login.status} ${(login.body && login.body.message) || login.text.slice(0, 100)}`);
  const packageId = await arboxFetchPackage(login.token, login.refresh, user.boxId, wl);
  return {
    token: login.token, refresh: login.refresh, userId: login.userId, packageId, whitelabel: wl,
    boxId: user.boxId, locationsBoxId: user.locationsBoxId,
  };
}

async function arboxSchedule(ctx, dateStr) {
  const iso = `${dateStr}T00:00:00.000Z`;
  const r = await fetch(`${ARBOX_BASE}/api/v2/schedule/betweenDates`, {
    method: 'POST',
    headers: authH(ctx.token, ctx.refresh, ctx.whitelabel),
    body: JSON.stringify({ from: iso, to: iso, locations_box_id: ctx.locationsBoxId }),
  });
  const j = await r.json();
  return j.data || [];
}

async function arboxScheduleRange(ctx, fromStr, toStr) {
  const r = await fetch(`${ARBOX_BASE}/api/v2/schedule/betweenDates`, {
    method: 'POST',
    headers: authH(ctx.token, ctx.refresh, ctx.whitelabel),
    body: JSON.stringify({ from: `${fromStr}T00:00:00.000Z`, to: `${toStr}T00:00:00.000Z`, locations_box_id: ctx.locationsBoxId }),
  });
  const j = await r.json();
  return j.data || [];
}

async function arboxBook(ctx, scheduleId) {
  const r = await fetch(`${ARBOX_BASE}/api/v2/scheduleUser/insert`, {
    method: 'POST',
    headers: authH(ctx.token, ctx.refresh, ctx.whitelabel),
    body: JSON.stringify({ extras: null, membership_user_id: ctx.packageId, schedule_id: scheduleId }),
  });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  return { ok: r.ok, status: r.status, text, body, mode: 'book' };
}

// Standby endpoint: auto-books if class has space, otherwise adds to waitlist.
// Inspect response: data.user_booked = booked, data.user_in_standby = waitlisted.
async function arboxBookOrWaitlist(ctx, scheduleId) {
  const r = await fetch(`${ARBOX_BASE}/api/v2/scheduleStandBy/insert`, {
    method: 'POST',
    headers: authH(ctx.token, ctx.refresh, ctx.whitelabel),
    body: JSON.stringify({ extras: null, membership_user_id: ctx.packageId, schedule_id: scheduleId }),
  });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  let mode = 'unknown';
  if (body && body.data) {
    if (body.data.user_booked) mode = 'book';
    else if (body.data.user_in_standby) mode = 'waitlist';
  }
  return { ok: r.ok, status: r.status, text, body, mode };
}

async function arboxCancel(ctx, scheduleUserId, scheduleId) {
  const r = await fetch(`${ARBOX_BASE}/api/v2/scheduleUser/delete`, {
    method: 'POST',
    headers: authH(ctx.token, ctx.refresh, ctx.whitelabel),
    body: JSON.stringify({ id: scheduleUserId, schedule_id: scheduleId, membership_user_id: ctx.packageId }),
  });
  return { ok: r.ok, status: r.status, text: await r.text() };
}

// Burst-fire N regular-booking requests staggered around the exact opening moment.
// Uses arboxBook (NOT the standby endpoint) so Arbox doesn't fire its
// "you got in from the waitlist" notification when there's space.
// Caller is responsible for falling back to arboxBookOrWaitlist if this returns
// a "class full"-style error and the user wanted waitlist.
async function burstFire(ctx, scheduleId, opensAtMs) {
  const offsets = [-150, -75, 0, 75, 150]; // ms relative to opensAtMs
  const reqs = offsets.map(off => {
    const fireAt = opensAtMs + off;
    const wait = Math.max(0, fireAt - Date.now());
    return new Promise(r => setTimeout(r, wait))
      .then(() => arboxBook(ctx, scheduleId))
      .catch(e => ({ ok: false, status: 0, text: e.message, body: null, mode: 'error' }));
  });
  const results = await Promise.all(reqs);
  const booked = results.find(r => r.ok && r.mode === 'book');
  if (booked) return booked;
  const usefulErr = results.find(r => !isNotYetOpen(r));
  return usefulErr || results[0];
}

// Try regular booking first; if it fails and waitlist is allowed (and the failure
// isn't "not yet open"), fall back to the standby endpoint to join the waitlist.
async function bookWithFallback(ctx, scheduleId, useWaitlist) {
  const res = await arboxBook(ctx, scheduleId);
  if (res.ok) return res;
  if (useWaitlist && !isNotYetOpen(res)) {
    return await arboxBookOrWaitlist(ctx, scheduleId);
  }
  return res;
}

async function arboxCancelStandby(ctx, standbyId, scheduleId) {
  const r = await fetch(`${ARBOX_BASE}/api/v2/scheduleStandBy/delete`, {
    method: 'POST',
    headers: authH(ctx.token, ctx.refresh, ctx.whitelabel),
    body: JSON.stringify({ id: standbyId, schedule_id: scheduleId, membership_user_id: ctx.packageId }),
  });
  return { ok: r.ok, status: r.status, text: await r.text() };
}

// Detect "registration not yet open" from the API error.
function isNotYetOpen(res) {
  if (res.status === 400 || res.status === 403 || res.status === 422) {
    const m = ((res.body && res.body.error && (res.body.error.messageToUser || res.body.error.message)) || '').toLowerCase();
    if (m.includes('not yet') || m.includes('not opened') || m.includes('not open') || m.includes('cannot register yet') || m.includes('too early')) return true;
  }
  return false;
}

// =============================================================================
// KV state
// =============================================================================

async function getUser(env, chatId) {
  const raw = await env.ARBOX_KV.get(`users:${chatId}`);
  return raw ? JSON.parse(raw) : null;
}
async function putUser(env, chatId, user) {
  await env.ARBOX_KV.put(`users:${chatId}`, JSON.stringify(user));
  const idxRaw = await env.ARBOX_KV.get('index:users');
  const idx = idxRaw ? JSON.parse(idxRaw) : [];
  if (!idx.includes(String(chatId))) {
    idx.push(String(chatId));
    await env.ARBOX_KV.put('index:users', JSON.stringify(idx));
  }
}
async function deleteUser(env, chatId) {
  await env.ARBOX_KV.delete(`users:${chatId}`);
  await env.ARBOX_KV.delete(`rules:${chatId}`);
  await env.ARBOX_KV.delete(`pending:${chatId}`);
  const idxRaw = await env.ARBOX_KV.get('index:users');
  const idx = idxRaw ? JSON.parse(idxRaw) : [];
  await env.ARBOX_KV.put('index:users', JSON.stringify(idx.filter(id => String(id) !== String(chatId))));
}
async function listUserChatIds(env) {
  const raw = await env.ARBOX_KV.get('index:users');
  return raw ? JSON.parse(raw) : [];
}

async function getPending(env, chatId) {
  const raw = await env.ARBOX_KV.get(`pending:${chatId}`);
  return raw ? JSON.parse(raw) : null;
}
async function putPending(env, chatId, p) { await env.ARBOX_KV.put(`pending:${chatId}`, JSON.stringify(p)); }
async function clearPending(env, chatId) { await env.ARBOX_KV.delete(`pending:${chatId}`); }

async function getRules(env, chatId) {
  const raw = await env.ARBOX_KV.get(`rules:${chatId}`);
  return raw ? JSON.parse(raw) : [];
}
async function putRules(env, chatId, rules) { await env.ARBOX_KV.put(`rules:${chatId}`, JSON.stringify(rules)); }

// =============================================================================
// Access control — only the admin can authorize new users into the bot.
// =============================================================================

async function getAcl(env) {
  const raw = await env.ARBOX_KV.get('acl');
  if (raw) return JSON.parse(raw);
  // Bootstrap: Jonathan is admin, plus the two seed accounts are allowed.
  return { admin: '8545107937', allowed: ['8545107937', '8319543322'], pending: {} };
}
async function putAcl(env, acl) { await env.ARBOX_KV.put('acl', JSON.stringify(acl)); }
const isAllowed = (acl, chatId) => String(chatId) === acl.admin || acl.allowed.includes(String(chatId));
const isAdmin = (acl, chatId) => String(chatId) === acl.admin;

// Returns the rule's slot list, normalizing legacy single-slot rules.
function ruleSlots(rule) {
  if (Array.isArray(rule.slots) && rule.slots.length) return rule.slots;
  if (rule.time) return [{ time: rule.time, class: rule.class || null }];
  return [];
}

async function getReminders(env, chatId) {
  const raw = await env.ARBOX_KV.get(`reminders:${chatId}`);
  return raw ? JSON.parse(raw) : [];
}
async function putReminders(env, chatId, list) { await env.ARBOX_KV.put(`reminders:${chatId}`, JSON.stringify(list)); }

// Watches: one-shot pre-book entries for a specific future class.
// Each watch: { id, date, time, class, waitlistIfFull, reminderHours, createdMs }
async function getWatches(env, chatId) {
  const raw = await env.ARBOX_KV.get(`watches:${chatId}`);
  return raw ? JSON.parse(raw) : [];
}
async function putWatches(env, chatId, list) { await env.ARBOX_KV.put(`watches:${chatId}`, JSON.stringify(list)); }

// =============================================================================
// Formatters
// =============================================================================

function findClassByTime(schedule, time, classNameSubstr) {
  const matches = schedule.filter(c => (c.time || '').startsWith(time));
  if (classNameSubstr) {
    const lc = classNameSubstr.toLowerCase();
    const refined = matches.filter(c => {
      const n = (c.box_categories && c.box_categories.name) || '';
      return n.toLowerCase().includes(lc);
    });
    if (refined.length) return refined[0];
  }
  return matches[0] || null;
}

function classOneLine(c) {
  const name = (c.box_categories && c.box_categories.name) || '?';
  const time = c.time || '?';
  const reg = c.registered ?? '?';
  const max = (c.series && c.series.max_users) || c.max_users || '?';
  const standby = c.stand_by ?? 0;
  const coach = c.coach ? `${c.coach.first_name || ''} ${c.coach.last_name || ''}`.trim() : '';
  let mark = '';
  if (c.user_booked) mark = '  <i>(you ✅)</i>';
  else if (c.user_in_standby) mark = `  <i>(you 📋 wl#${c.stand_by_position || '?'})</i>`;
  return `${time} <b>${escape(name)}</b> ${reg}/${max}${standby ? ` +${standby}wl` : ''}${coach ? ` · ${escape(coach)}` : ''}${mark}`;
}

function classFullDetail(c, dateStr) {
  const name = (c.box_categories && c.box_categories.name) || '?';
  const time = c.time || '?';
  const end = c.end_time || '?';
  const reg = c.registered ?? '?';
  const max = (c.series && c.series.max_users) || c.max_users || '?';
  const standbyCount = c.stand_by ?? 0;
  const coach = c.coach ? `${c.coach.first_name || ''} ${c.coach.last_name || ''}`.trim() : '—';
  const cancelMin = (c.series && c.series.cancel_limit_min) ?? '—';
  const booked = (c.schedule_user || c.booked_users || []).map(u => u.full_name || `${u.first_name || ''} ${u.last_name || ''}`.trim()).filter(Boolean);
  const wlPeople = (c.schedule_stand_by || []).map(u => u.full_name || `${u.first_name || ''} ${u.last_name || ''}`.trim()).filter(Boolean);
  const lines = [
    `<b>${escape(name)}</b>`,
    `${dateStr} ${time}–${end}`,
    `Coach: ${escape(coach)}`,
    `Booked: ${reg}/${max}` + (standbyCount ? ` · Waitlist: ${standbyCount}` : ''),
    `Cancel cutoff: ${cancelMin} min before start`,
  ];
  if (booked.length) {
    lines.push('', '<b>Attendees:</b>', booked.map(n => '• ' + escape(n)).join('\n'));
  }
  if (wlPeople.length) {
    lines.push('', '<b>Waitlist:</b>', wlPeople.map((n, i) => `${i + 1}. ${escape(n)}`).join('\n'));
  }
  return lines.join('\n');
}

// =============================================================================
// Onboarding state machine
// =============================================================================

const HELP_LOGGED_IN = [
  '<b>Commands</b>',
  '/next — your next booking with full details',
  '/upcoming — your bookings in the next 14 days',
  '/today — today\'s schedule',
  '/schedule [YYYY-MM-DD] — full schedule for a date (default tomorrow)',
  '/cancel — pick a booking to cancel',
  '/book YYYY-MM-DD HH:MM [class] — manual book',
  '',
  '<b>One-shot</b>',
  '/grab — pre-book a single future class (fires the moment registration opens)',
  '/watches — list/cancel pending grab watches',
  '',
  '<b>Recurring rules</b>',
  '/recurring — list rules + buttons to manage them',
  '/add — interactive wizard to add a new rule (recommended)',
  '/recurring remove &lt;n&gt; / pause &lt;n&gt; / resume &lt;n&gt;',
  '',
  '/window — show how many hours before class registration opens',
  '/whoami — show logged-in account',
  '/logout — forget my credentials',
  '/help — this message',
].join('\n');

async function startOnboarding(env, chatId) {
  await putPending(env, chatId, { step: 'email' });
  await send(env, chatId,
    'Welcome to Arbox bot. Let\'s connect your account.\n\n' +
    'Send me your <b>Arbox email</b>.\n\n' +
    '<i>Heads-up: your password will be stored encrypted-at-rest in Cloudflare KV. Send /logout anytime to wipe it. Never use this bot with shared accounts.</i>'
  );
}

async function handleOnboardingMessage(env, chatId, text, messageId) {
  const p = await getPending(env, chatId);
  if (!p) return false;

  // Always let ANY slash command break out of a pending wizard.
  // Onboarding (email/password) is the only exception — those steps own all input.
  const trimmed = text.trim();
  const isSlashCmd = trimmed.startsWith('/');
  const isOnboarding = p && (p.step === 'email' || p.step === 'password' || p.step === 'gym');
  if (isSlashCmd && !isOnboarding) {
    await clearPending(env, chatId);
    return false; // hand off to the main router
  }

  // Grab wizard text input
  if (p.type === 'grab') {
    const user = await getUser(env, chatId);
    if (p.step === 'date-custom') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) { await send(env, chatId, 'Format: <code>YYYY-MM-DD</code>. Try again.'); return true; }
      p.date = text.trim();
      await gwAdvanceToClass(env, chatId, user, p);
      return true;
    }
    if (p.step === 'slot-custom') {
      const m = text.trim().match(/^(\d{2}:\d{2})(?:\s+(.+))?$/);
      if (!m) { await send(env, chatId, 'Format: <code>HH:MM</code> or <code>HH:MM ClassName</code>. Try again.'); return true; }
      p.time = m[1];
      p.class = (m[2] || '').trim() || null;
      await gwAdvanceToWindow(env, chatId, user, p);
      return true;
    }
    if (p.step === 'window-custom') {
      const h = parseFloat(text.trim());
      if (isNaN(h) || h < 0.05 || h > 720) { await send(env, chatId, 'Send a number between 0.05 and 720. Try again.'); return true; }
      p.openHoursBefore = h;
      await gwAdvanceToWaitlist(env, chatId, p);
      return true;
    }
    if (p.step === 'reminder-custom') {
      const h = parseFloat(text.trim());
      if (isNaN(h) || h < 0 || h > 168) { await send(env, chatId, 'Send a number between 0 and 168.'); return true; }
      p.reminderHours = h;
      await gwAdvanceToConfirm(env, chatId, p);
      return true;
    }
    return true;
  }

  // Recurring wizard text input
  if (p.type === 'rwiz') {
    const user = await getUser(env, chatId);
    if (p.step === 'slot-custom') {
      // Accept one or more lines: "HH:MM" or "HH:MM ClassName".
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const slots = [];
      for (const line of lines) {
        const m = line.match(/^(\d{2}:\d{2})(?:\s+(.+))?$/);
        if (!m) { await send(env, chatId, `Could not parse line: <code>${escape(line)}</code>\nUse <code>HH:MM</code> or <code>HH:MM ClassName</code>, one per line.`); return true; }
        slots.push({ time: m[1], class: (m[2] || '').trim() || null });
      }
      if (!slots.length) { await send(env, chatId, 'Send at least one slot.'); return true; }
      p.chosenSlots = slots;
      p.time = slots[0].time;
      p.class = slots[0].class;
      delete p.slots; delete p.slotPicks;
      await rwAdvanceToWindow(env, chatId, user, p);
      return true;
    }
    if (p.step === 'window-custom') {
      const h = parseFloat(text.trim());
      if (isNaN(h) || h < 0.05 || h > 720) { await send(env, chatId, 'Send a number between 0.05 and 720. Try again.'); return true; }
      p.openHours = h;
      await rwAdvanceToCycles(env, chatId, p);
      return true;
    }
    if (p.step === 'reminder-custom') {
      const h = parseFloat(text.trim());
      if (isNaN(h) || h < 0 || h > 168) { await send(env, chatId, 'Send a number between 0 and 168. Try again.'); return true; }
      p.reminderHours = h;
      await rwAdvanceToConfirm(env, chatId, p);
      return true;
    }
    return true; // ignore any other text inside wizard
  }

  if (p.step === 'email') {
    const email = text.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      await send(env, chatId, 'That doesn\'t look like an email. Send your Arbox email again, or /cancel_setup to abort.');
      return true;
    }
    await putPending(env, chatId, { step: 'password', email });
    await send(env, chatId, 'Got it. Now send me your <b>Arbox password</b>. I\'ll delete the message from chat as soon as I verify it.');
    return true;
  }

  if (p.step === 'password') {
    const password = text;
    if (messageId) deleteMessage(env, chatId, messageId).catch(() => {});
    await send(env, chatId, '🔐 Logging in (checking all known apps)...');

    // Try login against every known whitelabel in parallel and aggregate gym options.
    const attempts = await Promise.all(KNOWN_WHITELABELS.map(wl => arboxLogin(p.email, password, wl)));
    const successful = attempts.filter(a => a.ok);
    if (!successful.length) {
      await clearPending(env, chatId);
      const first = attempts[0];
      const reason = (first.body && first.body.error && (first.body.error.messageToUser || first.body.error.message)) || `HTTP ${first.status}`;
      await send(env, chatId, `❌ Login failed on every app: ${escape(reason)}\n\nSend /start to try again.`);
      return true;
    }

    // Aggregate gyms from each successful login, tagging with whitelabel.
    const allOptions = [];
    for (const att of successful) {
      try {
        const prof = await arboxFetchProfile(att.token, att.refresh, att.whitelabel);
        const memberships = prof.users_boxes || [];
        for (const m of memberships) {
          const key = `${att.whitelabel}|${m.box_fk}`;
          if (allOptions.some(o => o.key === key)) continue;
          allOptions.push({
            key,
            whitelabel: att.whitelabel,
            external_url_id: m.box && m.box.external_url_id,
            box_fk: m.box_fk,
            locations_box_fk: m.locations_box_fk,
            name: (m.box && m.box.name) || 'Unnamed',
          });
        }
      } catch (e) { /* skip */ }
    }

    if (!allOptions.length) {
      await clearPending(env, chatId);
      await send(env, chatId, '❌ Login worked but you have no active gym memberships in any known app. /start to try again.');
      return true;
    }

    if (allOptions.length === 1) {
      const opt = allOptions[0];
      await finalizeUserFromOption(env, chatId, p.email, password, opt);
      return true;
    }

    await putPending(env, chatId, { step: 'gym', email: p.email, password, options: allOptions });
    const buttons = allOptions.map((opt, i) => [{
      text: `${opt.name}${opt.whitelabel !== 'arbox' ? ` (${opt.whitelabel})` : ''}`.slice(0, 60),
      callback_data: `gympick:${i}`,
    }]);
    await send(env, chatId, 'Which gym do you want to control with this bot?', { reply_markup: { inline_keyboard: buttons } });
    return true;
  }

  return false;
}

async function finalizeUserFromOption(env, chatId, email, password, opt) {
  const user = {
    email, password,
    whitelabel: opt.whitelabel,
    boxId: opt.box_fk,
    locationsBoxId: opt.locations_box_fk,
    boxName: opt.name,
    externalGymId: opt.external_url_id,
    created: new Date().toISOString(),
  };
  await putUser(env, chatId, user);
  await clearPending(env, chatId);
  await send(env, chatId,
    `✅ Connected to <b>${escape(user.boxName)}</b>${opt.whitelabel !== 'arbox' ? ` <i>(${escape(opt.whitelabel)} app)</i>` : ''}.\n\n` +
    `Try /today, /next, /schedule, or set up a recurring rule with /recurring.\n` +
    `Send /help for the full list.`
  );
}

// =============================================================================
// Command handlers (require logged-in user)
// =============================================================================

async function cmdNext(env, chatId, user) {
  const ctx = await arboxContext(user);
  const today = dateInTz(new Date());
  const horizon = dateInTz(new Date(Date.now() + HORIZON_DAYS * 86400000));
  const items = await arboxScheduleRange(ctx, today, horizon);
  const mine = items.filter(c => c.user_booked || c.user_in_standby).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  if (!mine.length) return send(env, chatId, 'No upcoming bookings or waitlist entries.');
  const c = mine[0];
  const heading = c.user_in_standby ? `📋 <b>On waitlist</b> (position #${c.stand_by_position || '?'})\n\n` : '';
  await send(env, chatId, heading + classFullDetail(c, c.date));
}

async function cmdUpcoming(env, chatId, user) {
  const ctx = await arboxContext(user);
  const today = dateInTz(new Date());
  const horizon = dateInTz(new Date(Date.now() + HORIZON_DAYS * 86400000));
  const items = await arboxScheduleRange(ctx, today, horizon);
  const mine = items.filter(c => c.user_booked || c.user_in_standby).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  if (!mine.length) return send(env, chatId, 'No upcoming bookings or waitlist entries.');
  const lines = ['<b>Your upcoming:</b>', ''];
  for (const c of mine) {
    const name = (c.box_categories && c.box_categories.name) || '?';
    const coach = c.coach ? ` · ${escape(c.coach.first_name || '')} ${escape(c.coach.last_name || '')}` : '';
    const tag = c.user_booked ? '✅' : `📋wl#${c.stand_by_position || '?'}`;
    lines.push(`• ${tag} ${c.date} ${c.time} — ${escape(name)}${coach}`);
  }
  await send(env, chatId, lines.join('\n'));
}

async function cmdToday(env, chatId, user) {
  const ctx = await arboxContext(user);
  const today = dateInTz(new Date());
  const items = await arboxSchedule(ctx, today);
  if (!items.length) return send(env, chatId, `No classes today (${today}).`);
  const lines = [`<b>Today's schedule (${today})</b>`, ''];
  for (const c of items) lines.push('• ' + classOneLine(c));
  await send(env, chatId, lines.join('\n'));
}

async function cmdSchedule(env, chatId, user, args) {
  const ctx = await arboxContext(user);
  const date = (args[0] && /^\d{4}-\d{2}-\d{2}$/.test(args[0]))
    ? args[0]
    : dateInTz(new Date(Date.now() + 86400000));
  const items = await arboxSchedule(ctx, date);
  if (!items.length) return send(env, chatId, `No classes on ${date}.`);
  const lines = [`<b>Schedule for ${date}</b>`, ''];
  for (const c of items) lines.push('• ' + classOneLine(c));
  await send(env, chatId, lines.join('\n'));
}

async function cmdCancel(env, chatId, user) {
  const ctx = await arboxContext(user);
  const today = dateInTz(new Date());
  const horizon = dateInTz(new Date(Date.now() + HORIZON_DAYS * 86400000));
  const items = await arboxScheduleRange(ctx, today, horizon);
  const sorted = items.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  const booked = sorted.filter(c => c.user_booked);
  const waitlisted = sorted.filter(c => c.user_in_standby);
  if (!booked.length && !waitlisted.length) return send(env, chatId, 'Nothing to cancel.');

  const buttons = [];
  for (const c of booked) {
    const name = (c.box_categories && c.box_categories.name) || '';
    buttons.push([{
      text: `${c.date} ${c.time} ${name}`.slice(0, 60),
      callback_data: `cancel:${c.user_booked}:${c.id}`,
    }]);
  }
  for (const c of waitlisted) {
    const name = (c.box_categories && c.box_categories.name) || '';
    const pos = c.stand_by_position ? `#${c.stand_by_position}` : 'wl';
    buttons.push([{
      text: `${c.date} ${c.time} ${name} (waitlist ${pos})`.slice(0, 60),
      callback_data: `wlcncl:${c.user_in_standby}:${c.id}`,
    }]);
  }
  await send(env, chatId, 'Tap an entry to cancel:', { reply_markup: { inline_keyboard: buttons } });
}

async function cmdBook(env, chatId, user, args) {
  if (args.length < 2 || !/^\d{4}-\d{2}-\d{2}$/.test(args[0]) || !/^\d{2}:\d{2}$/.test(args[1])) {
    return send(env, chatId, 'Usage: <code>/book YYYY-MM-DD HH:MM [class]</code>');
  }
  const date = args[0], time = args[1], cls = args.slice(2).join(' ').trim() || null;
  const ctx = await arboxContext(user);
  const items = await arboxSchedule(ctx, date);
  const klass = findClassByTime(items, time, cls);
  if (!klass) return send(env, chatId, `No class found at ${time} on ${date}${cls ? ` matching "${cls}"` : ''}.`);
  if (klass.user_booked) return send(env, chatId, 'You are already booked.');
  if (klass.user_in_standby) return send(env, chatId, `You are already on the waitlist (#${klass.stand_by_position || '?'}).`);
  // Try regular booking first; fall back to waitlist if full.
  const res = await bookWithFallback(ctx, klass.id, true);
  if (res.ok) {
    const refreshed = await arboxSchedule(ctx, date);
    const updated = refreshed.find(c => c.id === klass.id) || klass;
    const heading = res.mode === 'waitlist'
      ? `📋 Joined waitlist (position #${updated.stand_by_position || '?'}).`
      : '✅ Booked.';
    await send(env, chatId, heading + '\n\n' + classFullDetail(updated, date));
    if (res.mode === 'book') {
      try { await scheduleFlairReminder(env, chatId, updated, date); } catch {}
    }
  } else {
    const msg = (res.body && res.body.error && (res.body.error.messageToUser || res.body.error.message)) || res.text.slice(0, 200);
    await send(env, chatId, `❌ Booking failed (HTTP ${res.status}): ${escape(msg)}`);
  }
}

// =============================================================================
// /grab — one-shot pre-book wizard
// =============================================================================

async function startGrabWizard(env, chatId, user) {
  await putPending(env, chatId, { type: 'grab', step: 'date' });
  // Show next 14 days as buttons.
  const rows = [];
  for (let d = 0; d < 14; d += 2) {
    const row = [];
    for (let off = 0; off < 2 && d + off < 14; off++) {
      const date = dateInTz(new Date(Date.now() + (d + off) * 86400000));
      const wd = weekdayShortInTz(date);
      const label = `${wd[0].toUpperCase() + wd.slice(1)} ${date.slice(5)}`;
      row.push({ text: label, callback_data: `gw:date:${date}` });
    }
    rows.push(row);
  }
  rows.push([{ text: '⌨ Type a date (YYYY-MM-DD)', callback_data: 'gw:date:_custom' }, { text: '❌ Cancel', callback_data: 'gw:cancel' }]);
  await send(env, chatId, '<b>Grab a single class</b>\n\nWhich day is the class on?', { reply_markup: { inline_keyboard: rows } });
}

async function gwAdvanceToClass(env, chatId, user, p) {
  p.step = 'class';
  await putPending(env, chatId, p);
  await send(env, chatId, `Date: <b>${p.date}</b>\n\nFetching that day's classes...`);
  let slots = [];
  try {
    const ctx = await arboxContext(user);
    const items = await arboxSchedule(ctx, p.date);
    slots = items
      .filter(c => c.date && c.time)
      .sort((a, b) => a.time.localeCompare(b.time))
      .map(c => ({ time: c.time, name: (c.box_categories && c.box_categories.name) || '' }));
  } catch (e) {
    await send(env, chatId, `⚠️ Couldn't fetch: ${escape(e.message)}`);
  }
  if (!slots.length) {
    await send(env, chatId, 'No classes returned for that day. They may not be in the schedule yet.', {
      reply_markup: { inline_keyboard: [
        [{ text: '⌨ Type time + class manually', callback_data: 'gw:slot:_custom' }],
        [{ text: '❌ Cancel', callback_data: 'gw:cancel' }],
      ]}
    });
    return;
  }
  p.slots = slots;
  await putPending(env, chatId, p);
  const rows = slots.slice(0, 30).map((s, i) => [{ text: `${s.time} — ${s.name}`.slice(0, 60), callback_data: `gw:slot:${i}` }]);
  rows.push([{ text: '⌨ Type time + class manually', callback_data: 'gw:slot:_custom' }, { text: '❌ Cancel', callback_data: 'gw:cancel' }]);
  await send(env, chatId, `Pick the class to grab on ${p.date}:`, { reply_markup: { inline_keyboard: rows } });
}

async function gwAdvanceToWindow(env, chatId, user, p) {
  p.step = 'window';
  await putPending(env, chatId, p);
  let detected = user.detectedHoursBefore || null;
  if (detected) {
    await send(env, chatId,
      `Class: <b>${p.time} ${escape(p.class || 'any')}</b>\n\nI know this gym opens registration <b>${detected}h</b> before each class.\n\nUse that, or override:`,
      { reply_markup: { inline_keyboard: windowKeyboard(detected) } }
    );
    return;
  }
  await send(env, chatId, '🔎 Detecting when this gym opens registration (one-time probe)...');
  try {
    const ctx = await arboxContext(user);
    const r = await detectBookingWindow(ctx);
    if (r.ok && r.detectedHoursBefore != null) {
      user.detectedHoursBefore = r.detectedHoursBefore;
      user.detectedAt = new Date().toISOString();
      await putUser(env, chatId, user);
      detected = r.detectedHoursBefore;
      await send(env, chatId, `📅 Detected: <b>${detected}h before</b> each class.\n\nConfirm or override:`, {
        reply_markup: { inline_keyboard: windowKeyboard(detected) }
      });
      return;
    }
    await send(env, chatId, `⚠️ Couldn't auto-detect (${escape(r.note || r.reason || 'no signal')}).\n\nPlease pick the window — how many hours <b>before class start</b> does registration open?`, {
      reply_markup: { inline_keyboard: windowKeyboard(null) }
    });
  } catch (e) {
    await send(env, chatId, `⚠️ Probe failed: ${escape(e.message)}\n\nPlease pick the window manually:`, {
      reply_markup: { inline_keyboard: windowKeyboard(null) }
    });
  }
}

async function gwAdvanceToWaitlist(env, chatId, p) {
  p.step = 'waitlist';
  await putPending(env, chatId, p);
  await send(env, chatId, 'If the class is <b>full</b> when registration opens, what should I do?', {
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Join the waitlist', callback_data: 'gw:wl:1' }],
      [{ text: '⏭ Skip — only book if there\'s a spot', callback_data: 'gw:wl:0' }],
      [{ text: '❌ Cancel', callback_data: 'gw:cancel' }],
    ]}
  });
}

async function gwAdvanceToReminder(env, chatId, p) {
  p.step = 'reminder';
  await putPending(env, chatId, p);
  await send(env, chatId, 'Want a cancellation reminder before the class? I\'ll send a notification with a one-tap cancel button.', {
    reply_markup: { inline_keyboard: reminderKeyboard() }
  });
}

async function gwAdvanceToConfirm(env, chatId, p) {
  p.step = 'confirm';
  await putPending(env, chatId, p);
  const cls = p.class ? `"${p.class}"` : '<i>any class at that time</i>';
  const opensAtMs = israelDateTimeToUtcMs(p.date, p.time) - p.openHoursBefore * 3_600_000;
  const opensAtLocal = formatLocalIL(opensAtMs);
  const inDelta = humanDuration(opensAtMs - Date.now());
  const lines = [
    '<b>Review your one-shot grab</b>', '',
    `Date: <b>${p.date}</b>`,
    `Time: <b>${p.time}</b>`,
    `Class: ${cls}`,
    `Booking opens: <b>${p.openHoursBefore}h before class</b>`,
    `If full: <b>${p.waitlistIfFull ? 'join waitlist' : 'skip'}</b>`,
    `Reminder: <b>${p.reminderHours ? `${p.reminderHours}h before class` : 'none'}</b>`,
    '',
    `🏁 Will fire at <b>${opensAtLocal}</b> (Israel time, in ${escape(inDelta)}). No API calls before then.`,
  ];
  await send(env, chatId, lines.join('\n'), { reply_markup: { inline_keyboard: [
    [{ text: '✅ Save', callback_data: 'gw:save' }],
    [{ text: '❌ Cancel', callback_data: 'gw:cancel' }],
  ]}});
}

async function gwSave(env, chatId, p) {
  const watches = await getWatches(env, chatId);
  const id = (watches.length ? Math.max(...watches.map(w => w.id)) : 0) + 1;
  const watch = {
    id, date: p.date, time: p.time, class: p.class || null,
    openHoursBefore: p.openHoursBefore,
    waitlistIfFull: p.waitlistIfFull !== false,
    reminderHours: p.reminderHours || 0,
    createdMs: Date.now(),
  };
  watches.push(watch);
  await putWatches(env, chatId, watches);
  await clearPending(env, chatId);
  const cls = watch.class ? ` "${watch.class}"` : '';
  const opensAtMs = israelDateTimeToUtcMs(watch.date, watch.time) - watch.openHoursBefore * 3_600_000;
  return send(env, chatId, `✅ Watching: ${watch.date} ${watch.time}${cls}\n\n🏁 Will fire at <b>${formatLocalIL(opensAtMs)}</b>. No pings to Arbox until then. Use /watches to see/cancel.`);
}

async function startRecurringWizard(env, chatId) {
  // Race is the only supported mode; skip the mode-pick screen and jump to days.
  await putPending(env, chatId, { type: 'rwiz', step: 'days', mode: 'race', days: [] });
  await send(env, chatId, '<b>Add a recurring booking</b>\n\nWhich days of the week?', {
    reply_markup: { inline_keyboard: dayKeyboard([]) }
  });
}

function dayKeyboard(selected) {
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  const labels = { sun:'Sun', mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat' };
  const row1 = days.slice(0, 4).map(d => ({ text: (selected.includes(d) ? '✅ ' : '') + labels[d], callback_data: `rw:dtog:${d}` }));
  const row2 = days.slice(4).map(d => ({ text: (selected.includes(d) ? '✅ ' : '') + labels[d], callback_data: `rw:dtog:${d}` }));
  return [
    row1, row2,
    [{ text: 'All days (Sun-Sat)', callback_data: 'rw:dpre:all' },
     { text: 'Sun-Fri (no Sat)', callback_data: 'rw:dpre:sunfri' }],
    [{ text: 'Mon-Fri', callback_data: 'rw:dpre:monfri' },
     { text: 'Weekends (Fri,Sat)', callback_data: 'rw:dpre:wknd' }],
    [{ text: '✅ Done — pick time next', callback_data: 'rw:ddone' },
     { text: '❌ Cancel', callback_data: 'rw:cancel' }],
  ];
}

function classListKeyboardMulti(slots, picks) {
  // slots: [{ time, name }] indexed; picks: Set of indices currently selected
  const rows = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const checked = picks.has(i) ? '✅ ' : '';
    rows.push([{ text: (checked + `${s.time} — ${s.name}`).slice(0, 60), callback_data: `rw:stog:${i}` }]);
  }
  rows.push([
    { text: '⌨ Type time + class manually', callback_data: 'rw:slot:_custom' },
    { text: '❌ Cancel', callback_data: 'rw:cancel' },
  ]);
  rows.push([{ text: `✅ Done — use ${picks.size} class${picks.size === 1 ? '' : 'es'}`, callback_data: 'rw:sdone' }]);
  return rows;
}

// Single-button keyboard kept for the /grab one-shot wizard (single-select).
function classListKeyboard(slots) {
  const rows = [];
  for (const s of slots) {
    rows.push([{ text: `${s.time} — ${s.name}`.slice(0, 60), callback_data: `gw:slot:${s.key}` }]);
  }
  rows.push([{ text: '⌨ Type time + class manually', callback_data: 'gw:slot:_custom' }, { text: '❌ Cancel', callback_data: 'gw:cancel' }]);
  return rows;
}

function windowKeyboard(detected) {
  const presets = [1, 6, 12, 24, 48, 72, 168];
  const rows = [];
  if (detected) rows.push([{ text: `✅ Use detected: ${detected}h before`, callback_data: `rw:win:${detected}` }]);
  for (let i = 0; i < presets.length; i += 4) {
    rows.push(presets.slice(i, i + 4).map(h => ({ text: `${h}h`, callback_data: `rw:win:${h}` })));
  }
  rows.push([{ text: '⌨ Type custom hours', callback_data: 'rw:win:_custom' }, { text: '❌ Cancel', callback_data: 'rw:cancel' }]);
  return rows;
}

function cyclesKeyboard() {
  return [
    [{ text: '1 week', callback_data: 'rw:cyc:1' }, { text: '2 weeks', callback_data: 'rw:cyc:2' }],
    [{ text: '4 weeks', callback_data: 'rw:cyc:4' }, { text: '8 weeks', callback_data: 'rw:cyc:8' }],
    [{ text: '12 weeks', callback_data: 'rw:cyc:12' }, { text: 'Forever', callback_data: 'rw:cyc:0' }],
    [{ text: '❌ Cancel', callback_data: 'rw:cancel' }],
  ];
}

function reminderKeyboard() {
  return [
    [{ text: 'No reminder', callback_data: 'rw:rem:0' }],
    [{ text: '1h before', callback_data: 'rw:rem:1' }, { text: '3h before', callback_data: 'rw:rem:3' }],
    [{ text: '6h before', callback_data: 'rw:rem:6' }, { text: '12h before', callback_data: 'rw:rem:12' }],
    [{ text: '24h before', callback_data: 'rw:rem:24' }, { text: '48h before', callback_data: 'rw:rem:48' }],
    [{ text: '⌨ Custom hours', callback_data: 'rw:rem:_custom' }, { text: '❌ Cancel', callback_data: 'rw:cancel' }],
  ];
}

// After days are picked: show per-day breakdown (text headers per day with that day's
// classes), then send a deduplicated button list of (time, class) slots — labels show
// which days the slot exists on if it's not on all picked days.
async function rwAdvanceToSlots(env, chatId, user, p) {
  p.step = 'slot';
  await putPending(env, chatId, p);
  await send(env, chatId, `Days: <b>${fmtDays(p.days)}</b>\n\nFetching classes for each picked day...`);

  let items = [];
  try {
    const ctx = await arboxContext(user);
    const today = dateInTz(new Date());
    const horizon = dateInTz(new Date(Date.now() + 14 * 86400000));
    items = await arboxScheduleRange(ctx, today, horizon);
  } catch (e) {
    await send(env, chatId, `⚠️ Couldn't fetch classes: ${escape(e.message)}`);
  }

  const dayLabels = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };
  const dayOrder = ['sun','mon','tue','wed','thu','fri','sat'];

  // wd -> Map(key -> {time, name})
  const perDay = new Map();
  for (const wd of p.days) perDay.set(wd, new Map());
  for (const c of items) {
    if (!c.date || !c.time) continue;
    const wd = weekdayShortInTz(c.date);
    if (!perDay.has(wd)) continue;
    const name = (c.box_categories && c.box_categories.name) || '';
    const key = `${c.time}|${name}`;
    if (perDay.get(wd).has(key)) continue;
    perDay.get(wd).set(key, { time: c.time, name });
  }

  // Per-day text breakdown (split across messages if it gets long).
  const sortedPickedDays = p.days.slice().sort((a, b) => dayOrder.indexOf(a) - dayOrder.indexOf(b));
  const dayBlocks = [];
  for (const wd of sortedPickedDays) {
    const m = perDay.get(wd);
    if (!m || !m.size) {
      dayBlocks.push(`<b>${dayLabels[wd]}</b>\n  <i>(no classes published yet)</i>`);
      continue;
    }
    const daySlots = [...m.values()].sort((a, b) => a.time.localeCompare(b.time));
    dayBlocks.push(`<b>${dayLabels[wd]}</b>\n` + daySlots.map(s => `  • ${s.time} — ${escape(s.name || '?')}`).join('\n'));
  }
  // Chunk to stay under Telegram's 4096-char limit.
  let buf = '';
  for (const block of dayBlocks) {
    const candidate = buf ? buf + '\n\n' + block : block;
    if (candidate.length > 3500) {
      if (buf) await send(env, chatId, buf);
      buf = block;
    } else {
      buf = candidate;
    }
  }
  if (buf) await send(env, chatId, buf);

  // Build dedup'd selectable slots, tracking which picked days each slot appears on.
  const slotInfo = new Map(); // key -> { time, name, daysSet }
  for (const wd of p.days) {
    for (const s of (perDay.get(wd) || new Map()).values()) {
      const k = `${s.time}|${s.name}`;
      if (!slotInfo.has(k)) slotInfo.set(k, { time: s.time, name: s.name, daysSet: new Set() });
      slotInfo.get(k).daysSet.add(wd);
    }
  }
  const slotList = [...slotInfo.values()].sort((a, b) => a.time.localeCompare(b.time) || a.name.localeCompare(b.name));

  if (!slotList.length) {
    await send(env, chatId, 'No classes found on those days. Falling back to manual entry.', {
      reply_markup: { inline_keyboard: [
        [{ text: '⌨ Type time + class manually', callback_data: 'rw:slot:_custom' }],
        [{ text: '❌ Cancel', callback_data: 'rw:cancel' }],
      ]}
    });
    return;
  }

  // Stash a flat slot list for selection (callback_data is index-based).
  p.slots = slotList.map(s => ({ time: s.time, name: s.name }));
  await putPending(env, chatId, p);

  // Each button: "HH:MM — Name" plus a day-badge if the slot doesn't exist on every picked day.
  const labeled = slotList.slice(0, 30).map(s => {
    const daysHere = [...s.daysSet].sort((a, b) => dayOrder.indexOf(a) - dayOrder.indexOf(b));
    const isAllDays = daysHere.length === p.days.length;
    const badge = isAllDays ? '' : ` (${daysHere.map(d => d[0].toUpperCase() + d.slice(1)).join(',')})`;
    return { time: s.time, name: (s.name || '?') + badge, rawName: s.name };
  });
  // Persist the labeled list AND raw {time, class} pairs for save.
  p.slots = labeled;
  p.slotPicks = [];
  await putPending(env, chatId, p);

  const picksSet = new Set();
  await send(env, chatId,
    `Tap one or more classes (each tap toggles), then tap <b>Done</b>.\n\nThe rule will fire on whichever of <b>${fmtDays(p.days)}</b> each class actually runs.`,
    { reply_markup: { inline_keyboard: classListKeyboardMulti(labeled, picksSet) } }
  );
}

async function rwAdvanceToWindow(env, chatId, user, p) {
  // Race mode only: ask for/confirm the booking window.
  p.step = 'window';
  await putPending(env, chatId, p);
  const detected = user.detectedHoursBefore || null;
  let header = `Class: <b>${p.time} ${escape(p.class || 'any')}</b>\n\n`;
  if (detected) {
    header += `I previously detected <b>${detected}h</b> as this gym's booking window.\n`;
  } else {
    header += `🔎 Probing the gym for its booking window...\n`;
  }
  await send(env, chatId, header + 'Pick when registration opens before each class:', {
    reply_markup: { inline_keyboard: windowKeyboard(detected) }
  });

  // Try to detect in the background if we don't have it.
  if (!detected) {
    try {
      const ctx = await arboxContext(user);
      const r = await detectBookingWindow(ctx);
      if (r.ok && r.detectedHoursBefore != null) {
        user.detectedHoursBefore = r.detectedHoursBefore;
        user.detectedAt = new Date().toISOString();
        await putUser(env, chatId, user);
        await send(env, chatId, `📅 Detected: <b>${r.detectedHoursBefore}h before</b> each class. Tap to use it, or override.`, {
          reply_markup: { inline_keyboard: windowKeyboard(r.detectedHoursBefore) }
        });
      } else {
        await send(env, chatId, `⚠️ Couldn't auto-detect: ${escape(r.note || r.reason || 'unknown')}\n\nPlease pick the window manually.`);
      }
    } catch (e) {
      await send(env, chatId, `⚠️ Probe failed: ${escape(e.message)}\n\nPlease pick the window manually.`);
    }
  }
}

async function rwAdvanceToCycles(env, chatId, p) {
  p.step = 'cycles';
  await putPending(env, chatId, p);
  await send(env, chatId, 'How many <b>weeks</b> should this rule run? (After that, it auto-pauses.)', {
    reply_markup: { inline_keyboard: cyclesKeyboard() }
  });
}

async function rwAdvanceToWaitlist(env, chatId, p) {
  p.step = 'waitlist';
  await putPending(env, chatId, p);
  await send(env, chatId, 'If the class is <b>full</b> when I try to book, what should I do?', {
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Join the waitlist', callback_data: 'rw:wl:1' }],
      [{ text: '⏭ Skip — only book if there\'s a spot', callback_data: 'rw:wl:0' }],
      [{ text: '❌ Cancel', callback_data: 'rw:cancel' }],
    ]}
  });
}

async function rwAdvanceToReminder(env, chatId, p) {
  p.step = 'reminder';
  await putPending(env, chatId, p);
  await send(env, chatId, 'Want a cancellation reminder before each class? I\'ll send a notification with a one-tap cancel button.', {
    reply_markup: { inline_keyboard: reminderKeyboard() }
  });
}

async function rwAdvanceToConfirm(env, chatId, p) {
  p.step = 'confirm';
  await putPending(env, chatId, p);
  const slots = p.chosenSlots && p.chosenSlots.length ? p.chosenSlots : [{ time: p.time, class: p.class }];
  const cycles = p.weeks === 0 ? 'forever' : `${p.weeks} week(s)`;
  const reminder = p.reminderHours ? `${p.reminderHours}h before each class` : 'no reminder';
  const lines = [
    '<b>Review your rule</b>', '',
    `Mode: <b>${p.mode}</b>`,
    `Days: <b>${fmtDays(p.days)}</b>`,
    `Classes (${slots.length}):`,
    ...slots.map(s => `  • ${s.time} — ${escape(s.class || 'any')}`),
  ];
  lines.push(`Booking opens: <b>${p.openHours}h before each class</b>`);
  lines.push(`Repeat for: <b>${cycles}</b>`);
  lines.push(`If full: <b>${p.waitlistIfFull ? 'join waitlist' : 'skip'}</b>`);
  lines.push(`Cancellation reminder: <b>${reminder}</b>`);
  lines.push('', '<i>Fires at exactly the moment registration opens, for every matching slot.</i>');
  await send(env, chatId, lines.join('\n'), { reply_markup: { inline_keyboard: [
    [{ text: '✅ Save rule', callback_data: 'rw:save' }],
    [{ text: '❌ Cancel', callback_data: 'rw:cancel' }],
  ]}});
}

async function rwSave(env, chatId, p) {
  const rules = await getRules(env, chatId);
  const id = (rules.length ? Math.max(...rules.map(r => r.id)) : 0) + 1;
  const slots = p.chosenSlots && p.chosenSlots.length ? p.chosenSlots : [{ time: p.time, class: p.class || null }];
  const rule = {
    id, mode: 'race', days: p.days,
    slots, // [{time, class}] — multi-slot
    // Legacy scalar mirrors of the first slot, kept for /recurring list back-compat.
    time: slots[0].time, class: slots[0].class,
    weeks: p.weeks || 0,
    endsAtMs: p.weeks ? Date.now() + p.weeks * 7 * 86400000 : null,
    reminderHours: p.reminderHours || 0,
    waitlistIfFull: p.waitlistIfFull !== false,
    openHoursBefore: p.openHours || null,
    paused: false,
    created: new Date().toISOString(),
  };
  rules.push(rule);
  await putRules(env, chatId, rules);
  await clearPending(env, chatId);
  const cls = rule.class ? ` "${rule.class}"` : '';
  await send(env, chatId, `✅ Rule ${rules.length} saved: [race] ${fmtDays(rule.days)} @ ${rule.time}${cls}`);

  if (rule.openHoursBefore) {
    const next = computeNextRaceFire(rule, rule.openHoursBefore);
    if (next) {
      const fmtLocal = formatLocalIL(next.opensAtMs);
      const inDelta = humanDuration(next.opensAtMs - Date.now());
      await send(env, chatId, `🏁 Next race attempt: <b>${fmtLocal}</b> (Israel time, in ${escape(inDelta)})\nfor class on ${escape(next.classDate)} ${escape(rule.time)}.`);
    }
  }
  if (rule.endsAtMs) {
    await send(env, chatId, `Rule expires <b>${formatLocalIL(rule.endsAtMs)}</b> (Israel time).`);
  }

  await send(env, chatId, 'Use /recurring to list, or /add to add another.');
}

function computeNextRaceFire(rule, hoursBefore) {
  const nowMs = Date.now();
  for (let d = 0; d <= 14; d++) {
    const date = dateInTz(new Date(nowMs + d * 86400000));
    const wd = weekdayShortInTz(date);
    if (!rule.days.includes(wd)) continue;
    const classStartMs = israelDateTimeToUtcMs(date, rule.time);
    if (classStartMs <= nowMs) continue;
    const opensAtMs = classStartMs - hoursBefore * 3_600_000;
    return { classDate: date, classStartMs, opensAtMs };
  }
  return null;
}

function formatLocalIL(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms));
}

function humanDuration(ms) {
  if (ms < 0) return 'now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (!d && m) parts.push(`${m}m`);
  return parts.join(' ') || 'less than 1m';
}

async function cmdRecurring(env, chatId, user, args) {
  const sub = (args[0] || '').toLowerCase();
  const rules = await getRules(env, chatId);

  // /recurring or /recurring add (no extras) → list + management buttons; empty → launch wizard.
  if (!sub || (sub === 'add' && args.length === 1)) {
    if (!rules.length) {
      await send(env, chatId, 'No recurring rules yet.');
      return startRecurringWizard(env, chatId);
    }
    const lines = ['<b>Recurring rules</b>', ''];
    rules.forEach((r, i) => {
      const status = r.paused ? ' [PAUSED]' : '';
      const winLabel = r.openHoursBefore ? `opens ${r.openHoursBefore}h before`
        : r.detectedHoursBefore ? `~${r.detectedHoursBefore}h before (detected)`
        : 'auto-detect';
      const slots = ruleSlots(r);
      const slotsLine = slots.length === 1
        ? `${slots[0].time}${slots[0].class ? ` · "${escape(slots[0].class)}"` : ''}`
        : `${slots.length} slots: ` + slots.map(s => `${s.time}${s.class ? ` "${escape(s.class)}"` : ''}`).join(', ');
      lines.push(`${i + 1}. [race ${winLabel}] ${fmtDays(r.days)} — ${slotsLine}${status}`);
    });
    lines.push('', 'Tap a button to manage or add a new rule:');
    return send(env, chatId, lines.join('\n'), { reply_markup: { inline_keyboard: [
      [{ text: '➕ Add new rule', callback_data: 'rw:start' }],
      ...rules.map((r, i) => [
        { text: `🗑 Remove ${i + 1}`, callback_data: `rmgr:rm:${r.id}` },
        { text: r.paused ? `▶️ Resume ${i + 1}` : `⏸ Pause ${i + 1}`, callback_data: `rmgr:tog:${r.id}` },
      ]),
    ]}});
  }

  if (sub === 'remove') {
    const n = parseInt(args[1], 10);
    if (!n || n < 1 || n > rules.length) return send(env, chatId, 'Invalid rule number.');
    const removed = rules.splice(n - 1, 1)[0];
    await putRules(env, chatId, rules);
    return send(env, chatId, `🗑 Removed: ${fmtDays(removed.days)} @ ${removed.time}`);
  }

  if (sub === 'pause' || sub === 'resume') {
    const n = parseInt(args[1], 10);
    if (!n || n < 1 || n > rules.length) return send(env, chatId, 'Invalid rule number.');
    rules[n - 1].paused = (sub === 'pause');
    await putRules(env, chatId, rules);
    return send(env, chatId, `${sub === 'pause' ? '⏸' : '▶️'} Rule ${n} ${sub}d.`);
  }

  return send(env, chatId, `Unknown subcommand: ${escape(sub)}. Try /help.`);
}

// Inspect classes over the next 14 days to figure out the gym's booking window.
// Strategy: each class object carries a `booking_option` field. When it equals
// "registerToSchedule" (or similar "you can register now"), the window is open.
// When it's something else (or absent / "registerLater" style), it's not yet open.
// We find the boundary: latest "open" class vs earliest "not-yet-open" class.
async function detectBookingWindow(ctx) {
  const today = dateInTz(new Date());
  const horizon = dateInTz(new Date(Date.now() + 14 * 86400000));
  const items = await arboxScheduleRange(ctx, today, horizon);
  if (!items.length) return { ok: false, reason: 'no classes returned' };

  const nowMs = Date.now();
  const classified = items
    .filter(c => c.date && c.time)
    .map(c => {
      const startMs = israelDateTimeToUtcMs(c.date, c.time);
      const opt = (c.booking_option || '').toLowerCase();
      // ONLY 'registerToSchedule' means "you can register right now".
      // Exclude user_booked classes — already-booked classes don't tell us the window.
      // 'cancelscheduleuser' = you're booked, 'standby' = full+waitlist (different signal).
      const open = opt === 'registertoschedule';
      return { c, startMs, opt, open, userBooked: !!c.user_booked };
    })
    .filter(x => x.startMs > nowMs && !x.userBooked)
    .sort((a, b) => a.startMs - b.startMs);

  if (!classified.length) return { ok: false, reason: 'no eligible future classes (all booked or none returned)' };

  // Collect distinct booking_option values for transparency
  const optionCounts = {};
  for (const x of classified) optionCounts[x.opt || '(empty)'] = (optionCounts[x.opt || '(empty)'] || 0) + 1;

  const openOnes = classified.filter(x => x.open);
  const closedOnes = classified.filter(x => !x.open);

  const result = { ok: true, totalLooked: classified.length, openCount: openOnes.length, closedCount: closedOnes.length };

  if (openOnes.length) {
    const latestOpen = openOnes[openOnes.length - 1];
    result.latestOpenHoursAhead = Math.round(((latestOpen.startMs - nowMs) / 3_600_000) * 10) / 10;
    result.latestOpenSample = `${latestOpen.c.date} ${latestOpen.c.time}`;
  }
  if (closedOnes.length) {
    const earliestClosed = closedOnes[0];
    result.earliestClosedHoursAhead = Math.round(((earliestClosed.startMs - nowMs) / 3_600_000) * 10) / 10;
    result.earliestClosedSample = `${earliestClosed.c.date} ${earliestClosed.c.time}`;
    result.earliestClosedOption = earliestClosed.opt;
  }

  // Window = the gap between latest-open and earliest-closed gives the booking window.
  if (openOnes.length && closedOnes.length) {
    // The boundary lies between latestOpen and earliestClosed.
    // Conservative answer: booking opens (earliestClosedHoursAhead) hours before class start.
    result.detectedHoursBefore = result.earliestClosedHoursAhead;
  } else if (openOnes.length && !closedOnes.length) {
    // All future classes open → window is at least the furthest one
    result.detectedHoursBefore = null; // unknown upper bound
    result.note = `All classes through ${result.latestOpenSample} are bookable — window is at least ${result.latestOpenHoursAhead}h.`;
  } else {
    result.detectedHoursBefore = null;
    result.note = 'No currently-bookable classes in the next 14 days. Try again later.';
  }
  result.optionCounts = optionCounts;
  return result;
}

async function cmdWindow(env, chatId, user) {
  await send(env, chatId, '🔎 Probing gym booking window...');
  const ctx = await arboxContext(user);
  const r = await detectBookingWindow(ctx);
  if (!r.ok) return send(env, chatId, `Could not detect: ${r.reason}`);
  const lines = [`<b>Booking window for ${escape(user.boxName)}</b>`, ''];
  if (r.detectedHoursBefore != null) {
    lines.push(`📅 Registration opens <b>${r.detectedHoursBefore}h before</b> each class starts.`);
  } else if (r.note) {
    lines.push(`ℹ️ ${escape(r.note)}`);
  }
  lines.push('');
  if (r.latestOpenSample) lines.push(`Latest currently-bookable: <code>${r.latestOpenSample}</code> (${r.latestOpenHoursAhead}h ahead)`);
  if (r.earliestClosedSample) lines.push(`Earliest still-locked: <code>${r.earliestClosedSample}</code> (${r.earliestClosedHoursAhead}h ahead, status: ${escape(r.earliestClosedOption || 'unknown')})`);
  lines.push('', `Looked at ${r.totalLooked} classes (${r.openCount} open / ${r.closedCount} closed).`);
  if (r.optionCounts) {
    const counts = Object.entries(r.optionCounts).map(([k, v]) => `${k}: ${v}`).join(', ');
    lines.push(`<i>booking_option breakdown: ${escape(counts)}</i>`);
  }

  // Cache the detected window on the user record so race rules can use it.
  if (r.detectedHoursBefore != null) {
    user.detectedHoursBefore = r.detectedHoursBefore;
    user.detectedAt = new Date().toISOString();
    await putUser(env, chatId, user);
    lines.push('', '<i>Saved. Future race rules without an explicit hours_before will use this.</i>');
  }
  await send(env, chatId, lines.join('\n'));
}

async function cmdWatches(env, chatId, user) {
  const watches = await getWatches(env, chatId);
  if (!watches.length) return send(env, chatId, 'No active watches.\n\nUse /grab to set one up.');
  const lines = ['<b>Active watches</b>', ''];
  watches.forEach((w, i) => {
    const cls = w.class ? ` "${w.class}"` : '';
    const wl = w.waitlistIfFull ? ' (will waitlist if full)' : '';
    const hours = w.openHoursBefore || user.detectedHoursBefore;
    let timing = '';
    if (hours) {
      const opensAtMs = israelDateTimeToUtcMs(w.date, w.time) - hours * 3_600_000;
      timing = `\n   ⏰ Fires at ${formatLocalIL(opensAtMs)} (in ${humanDuration(opensAtMs - Date.now())})`;
    } else {
      timing = '\n   ⚠️ No window set — won\'t fire until you specify one';
    }
    lines.push(`${i + 1}. ${w.date} ${w.time}${cls}${wl}${timing}`);
  });
  await send(env, chatId, lines.join('\n'), {
    reply_markup: { inline_keyboard: watches.map(w => [{ text: `🗑 Remove ${w.date} ${w.time}`, callback_data: `wmgr:rm:${w.id}` }]) }
  });
}

async function cmdWhoami(env, chatId, user) {
  const lines = [
    `Logged in as <b>${escape(user.email)}</b>`,
    `Gym: <b>${escape(user.boxName)}</b> (${escape(user.externalGymId || '?')})`,
    `App: ${escape(user.whitelabel || 'arbox')}`,
    `Connected: ${escape(user.created.slice(0, 16).replace('T', ' '))}`,
  ];
  if (user.detectedHoursBefore) lines.push(`Booking window: opens <b>${user.detectedHoursBefore}h</b> before class (detected ${escape((user.detectedAt || '').slice(0, 10))})`);
  else lines.push('Booking window: unknown — run /window to detect it.');
  await send(env, chatId, lines.join('\n'));
}

async function cmdLogout(env, chatId) {
  await deleteUser(env, chatId);
  await send(env, chatId, '🗑 Forgot your credentials. Send /start to set up again.');
}

// =============================================================================
// Callback queries (inline button handlers)
// =============================================================================

async function handleCallback(env, cq) {
  const chatId = cq.message.chat.id;
  const data = cq.data || '';

  // Grab wizard
  if (data.startsWith('gw:')) {
    const [, kind, ...rest] = data.split(':');
    const arg = rest.join(':');
    const user = await getUser(env, chatId);
    if (!user) return answerCallback(env, cq.id, 'Not logged in');
    if (kind === 'cancel') {
      await clearPending(env, chatId);
      await answerCallback(env, cq.id, 'Cancelled');
      return send(env, chatId, '❌ Cancelled.');
    }
    let p = await getPending(env, chatId);
    if (!p || p.type !== 'grab') return answerCallback(env, cq.id, 'Wizard expired');
    if (kind === 'date') {
      if (arg === '_custom') {
        p.step = 'date-custom';
        await putPending(env, chatId, p);
        await answerCallback(env, cq.id, '');
        return send(env, chatId, 'Send the date as <code>YYYY-MM-DD</code>:');
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(arg)) return answerCallback(env, cq.id, 'Bad date');
      p.date = arg;
      await answerCallback(env, cq.id, arg);
      return gwAdvanceToClass(env, chatId, user, p);
    }
    if (kind === 'slot') {
      if (arg === '_custom') {
        p.step = 'slot-custom';
        await putPending(env, chatId, p);
        await answerCallback(env, cq.id, '');
        return send(env, chatId, 'Send time + class as: <code>HH:MM ClassName</code> or just <code>HH:MM</code>.');
      }
      const idx = parseInt(arg, 10);
      if (isNaN(idx) || !p.slots || idx >= p.slots.length) return answerCallback(env, cq.id, 'Slot expired');
      p.time = p.slots[idx].time;
      p.class = p.slots[idx].name || null;
      delete p.slots;
      await answerCallback(env, cq.id, `${p.time} ${p.class || ''}`);
      return gwAdvanceToWindow(env, chatId, user, p);
    }
    if (kind === 'win') {
      if (arg === '_custom') {
        p.step = 'window-custom';
        await putPending(env, chatId, p);
        await answerCallback(env, cq.id, '');
        return send(env, chatId, 'Send the number of hours before class (e.g. <code>24</code> or <code>1.5</code>):');
      }
      const h = parseFloat(arg);
      if (isNaN(h) || h < 0.05 || h > 720) return answerCallback(env, cq.id, 'Bad value');
      p.openHoursBefore = h;
      await answerCallback(env, cq.id, `${h}h`);
      return gwAdvanceToWaitlist(env, chatId, p);
    }
    if (kind === 'wl') {
      p.waitlistIfFull = arg === '1';
      await answerCallback(env, cq.id, p.waitlistIfFull ? 'will waitlist' : 'will skip');
      return gwAdvanceToReminder(env, chatId, p);
    }
    if (kind === 'rem') {
      if (arg === '_custom') {
        p.step = 'reminder-custom';
        await putPending(env, chatId, p);
        await answerCallback(env, cq.id, '');
        return send(env, chatId, 'Send hours before class for the reminder (e.g. <code>4</code>). 0 = no reminder.');
      }
      const h = parseFloat(arg);
      if (isNaN(h) || h < 0 || h > 168) return answerCallback(env, cq.id, 'Bad value');
      p.reminderHours = h;
      await answerCallback(env, cq.id, '');
      return gwAdvanceToConfirm(env, chatId, p);
    }
    if (kind === 'save') {
      await answerCallback(env, cq.id, 'Saved');
      return gwSave(env, chatId, p);
    }
    return answerCallback(env, cq.id, 'unknown');
  }

  // Watch management buttons
  if (data.startsWith('wmgr:')) {
    const [, action, idStr] = data.split(':');
    const wid = parseInt(idStr, 10);
    const watches = await getWatches(env, chatId);
    const idx = watches.findIndex(w => w.id === wid);
    if (idx < 0) return answerCallback(env, cq.id, 'Watch gone');
    if (action === 'rm') {
      const w = watches.splice(idx, 1)[0];
      await putWatches(env, chatId, watches);
      await answerCallback(env, cq.id, 'Removed');
      return send(env, chatId, `🗑 Removed watch: ${w.date} ${w.time}`);
    }
  }

  // Recurring wizard
  if (data.startsWith('rw:')) {
    const [, kind, ...rest] = data.split(':');
    const arg = rest.join(':');
    const user = await getUser(env, chatId);
    if (!user) return answerCallback(env, cq.id, 'Not logged in');

    if (kind === 'start') {
      await answerCallback(env, cq.id, '');
      return startRecurringWizard(env, chatId);
    }
    if (kind === 'cancel') {
      await clearPending(env, chatId);
      await answerCallback(env, cq.id, 'Cancelled');
      return send(env, chatId, '❌ Cancelled.');
    }

    let p = await getPending(env, chatId);
    if (!p || p.type !== 'rwiz') return answerCallback(env, cq.id, 'Wizard expired — start over with /recurring');

    if (kind === 'dtog') {
      const idx = p.days.indexOf(arg);
      if (idx >= 0) p.days.splice(idx, 1); else p.days.push(arg);
      // Sort to canonical order
      const ord = ['sun','mon','tue','wed','thu','fri','sat'];
      p.days.sort((a, b) => ord.indexOf(a) - ord.indexOf(b));
      await putPending(env, chatId, p);
      await answerCallback(env, cq.id, '');
      return tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: dayKeyboard(p.days) } });
    }
    if (kind === 'dpre') {
      const presets = {
        all: ['sun','mon','tue','wed','thu','fri','sat'],
        sunfri: ['sun','mon','tue','wed','thu','fri'],
        monfri: ['mon','tue','wed','thu','fri'],
        wknd: ['fri','sat'],
      };
      p.days = presets[arg] || p.days;
      await putPending(env, chatId, p);
      await answerCallback(env, cq.id, '');
      return tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: dayKeyboard(p.days) } });
    }
    if (kind === 'ddone') {
      if (!p.days.length) return answerCallback(env, cq.id, 'Pick at least one day');
      await answerCallback(env, cq.id, '');
      return rwAdvanceToSlots(env, chatId, user, p);
    }
    if (kind === 'slot') {
      if (arg === '_custom') {
        p.step = 'slot-custom';
        await putPending(env, chatId, p);
        await answerCallback(env, cq.id, '');
        return send(env, chatId, 'Send one slot per line as: <code>HH:MM ClassName</code> (or just <code>HH:MM</code> for any). Example:\n<code>08:20 BEAST MODE\n18:30 Pilates</code>');
      }
      return answerCallback(env, cq.id, 'unknown slot kind');
    }
    if (kind === 'stog') {
      const idx = parseInt(arg, 10);
      if (isNaN(idx) || !p.slots || idx >= p.slots.length) return answerCallback(env, cq.id, 'Slot expired');
      p.slotPicks = p.slotPicks || [];
      const pos = p.slotPicks.indexOf(idx);
      if (pos >= 0) p.slotPicks.splice(pos, 1); else p.slotPicks.push(idx);
      await putPending(env, chatId, p);
      await answerCallback(env, cq.id, '');
      const picksSet = new Set(p.slotPicks);
      return tg(env, 'editMessageReplyMarkup', {
        chat_id: chatId, message_id: cq.message.message_id,
        reply_markup: { inline_keyboard: classListKeyboardMulti(p.slots, picksSet) },
      });
    }
    if (kind === 'sdone') {
      if (!p.slotPicks || !p.slotPicks.length) return answerCallback(env, cq.id, 'Pick at least one class');
      // Materialize chosen slots into the rule's slot list.
      p.chosenSlots = p.slotPicks.map(i => ({ time: p.slots[i].time, class: p.slots[i].rawName || null }));
      // Free KV space for the rest of the wizard.
      delete p.slots;
      delete p.slotPicks;
      // Use the first slot's time as the headline display value.
      p.time = p.chosenSlots[0].time;
      p.class = p.chosenSlots[0].class;
      await answerCallback(env, cq.id, `${p.chosenSlots.length} class${p.chosenSlots.length === 1 ? '' : 'es'} picked`);
      return rwAdvanceToWindow(env, chatId, user, p);
    }
    if (kind === 'win') {
      if (arg === '_custom') {
        p.step = 'window-custom';
        await putPending(env, chatId, p);
        await answerCallback(env, cq.id, '');
        return send(env, chatId, 'Send the number of hours (e.g. <code>24</code> or <code>1.5</code>):');
      }
      const h = parseFloat(arg);
      if (isNaN(h) || h < 0.05 || h > 720) return answerCallback(env, cq.id, 'Bad value');
      p.openHours = h;
      await answerCallback(env, cq.id, `${h}h`);
      return rwAdvanceToCycles(env, chatId, p);
    }
    if (kind === 'cyc') {
      const w = parseInt(arg, 10);
      if (isNaN(w) || w < 0 || w > 520) return answerCallback(env, cq.id, 'Bad value');
      p.weeks = w;
      await answerCallback(env, cq.id, w === 0 ? 'forever' : `${w} weeks`);
      return rwAdvanceToWaitlist(env, chatId, p);
    }
    if (kind === 'wl') {
      p.waitlistIfFull = arg === '1';
      await answerCallback(env, cq.id, p.waitlistIfFull ? 'will waitlist' : 'will skip');
      return rwAdvanceToReminder(env, chatId, p);
    }
    if (kind === 'rem') {
      if (arg === '_custom') {
        p.step = 'reminder-custom';
        await putPending(env, chatId, p);
        await answerCallback(env, cq.id, '');
        return send(env, chatId, 'Send hours before class for the reminder (e.g. <code>4</code>). 0 = no reminder.');
      }
      const h = parseFloat(arg);
      if (isNaN(h) || h < 0 || h > 168) return answerCallback(env, cq.id, 'Bad value');
      p.reminderHours = h;
      await answerCallback(env, cq.id, h === 0 ? 'no reminder' : `${h}h before`);
      return rwAdvanceToConfirm(env, chatId, p);
    }
    if (kind === 'save') {
      await answerCallback(env, cq.id, 'Saved');
      return rwSave(env, chatId, p);
    }
    return answerCallback(env, cq.id, 'unknown');
  }

  // Rule management buttons (remove / pause / resume from /recurring list view)
  if (data.startsWith('rmgr:')) {
    const [, action, ruleIdStr] = data.split(':');
    const ruleId = parseInt(ruleIdStr, 10);
    const rules = await getRules(env, chatId);
    const idx = rules.findIndex(r => r.id === ruleId);
    if (idx < 0) return answerCallback(env, cq.id, 'Rule gone');
    if (action === 'rm') {
      const removed = rules.splice(idx, 1)[0];
      await putRules(env, chatId, rules);
      await answerCallback(env, cq.id, 'Removed');
      return send(env, chatId, `🗑 Removed: ${fmtDays(removed.days)} @ ${removed.time}`);
    }
    if (action === 'tog') {
      rules[idx].paused = !rules[idx].paused;
      await putRules(env, chatId, rules);
      await answerCallback(env, cq.id, rules[idx].paused ? 'Paused' : 'Resumed');
      return send(env, chatId, `${rules[idx].paused ? '⏸ Paused' : '▶️ Resumed'}: rule ${idx + 1}`);
    }
  }

  if (data.startsWith('gympick:')) {
    const idx = parseInt(data.slice(8), 10);
    const p = await getPending(env, chatId);
    if (!p || p.step !== 'gym' || !p.options || idx >= p.options.length) {
      return answerCallback(env, cq.id, 'Expired');
    }
    await finalizeUserFromOption(env, chatId, p.email, p.password, p.options[idx]);
    return answerCallback(env, cq.id, 'Selected');
  }

  if (data.startsWith('cancel:') || data.startsWith('rcncl:')) {
    const user = await getUser(env, chatId);
    if (!user) return answerCallback(env, cq.id, 'Not logged in');
    const parts = data.split(':');
    const scheduleUserId = parseInt(parts[1], 10);
    const scheduleId = parseInt(parts[2], 10);
    if (!scheduleId) {
      // Older callback format without schedule_id — look it up.
      try {
        const ctx0 = await arboxContext(user);
        const today = dateInTz(new Date());
        const horizon = dateInTz(new Date(Date.now() + HORIZON_DAYS * 86400000));
        const items = await arboxScheduleRange(ctx0, today, horizon);
        const found = items.find(c => c.user_booked === scheduleUserId);
        if (!found) {
          await answerCallback(env, cq.id, 'Booking not found');
          return send(env, chatId, '❌ Could not locate that booking. Run /cancel again.');
        }
        const ctx = ctx0;
        const res = await arboxCancel(ctx, scheduleUserId, found.id);
        await answerCallback(env, cq.id, res.ok ? 'Cancelled' : `Failed: ${res.status}`);
        if (res.ok) await send(env, chatId, '✅ Cancelled.');
        else await send(env, chatId, `❌ Cancel failed (HTTP ${res.status}): ${escape(res.text.slice(0, 200))}`);
      } catch (e) {
        await send(env, chatId, `❌ Cancel error: ${escape(e.message)}`);
      }
      return;
    }
    const ctx = await arboxContext(user);
    const res = await arboxCancel(ctx, scheduleUserId, scheduleId);
    await answerCallback(env, cq.id, res.ok ? 'Cancelled' : `Failed: ${res.status}`);
    if (res.ok) await send(env, chatId, '✅ Cancelled.');
    else await send(env, chatId, `❌ Cancel failed (HTTP ${res.status}): ${escape(res.text.slice(0, 200))}`);
    return;
  }
  if (data.startsWith('wlcncl:')) {
    const user = await getUser(env, chatId);
    if (!user) return answerCallback(env, cq.id, 'Not logged in');
    const [, sbIdStr, schedIdStr] = data.split(':');
    const standbyId = parseInt(sbIdStr, 10);
    const scheduleId = parseInt(schedIdStr, 10);
    const ctx = await arboxContext(user);
    const res = await arboxCancelStandby(ctx, standbyId, scheduleId);
    await answerCallback(env, cq.id, res.ok ? 'Removed from waitlist' : `Failed: ${res.status}`);
    if (res.ok) await send(env, chatId, '✅ Removed from waitlist.');
    else await send(env, chatId, `❌ Failed (HTTP ${res.status}): ${escape(res.text.slice(0, 200))}`);
    return;
  }
  if (data === 'rkeep') {
    return answerCallback(env, cq.id, 'Keeping it');
  }

  if (data.startsWith('acl:')) {
    const acl = await getAcl(env);
    if (!isAdmin(acl, chatId)) return answerCallback(env, cq.id, 'Admin only');
    const [, action, targetIdStr] = data.split(':');
    const targetId = String(targetIdStr);
    const pending = acl.pending[targetId];
    if (!pending) { await answerCallback(env, cq.id, 'Not pending'); return; }
    if (action === 'ap') {
      if (!acl.allowed.includes(targetId)) acl.allowed.push(targetId);
      delete acl.pending[targetId];
      await putAcl(env, acl);
      await answerCallback(env, cq.id, 'אושר');
      await send(env, chatId, `✅ אושר: <b>${escape(pending.name)}</b> ${escape(pending.username || '')} (chat ${escape(targetId)})`);
      try { await send(env, parseInt(targetId, 10), '✅ הגישה שלך לבוט אושרה. שלח /start כדי להתחיל.'); } catch {}
      return;
    }
    if (action === 'dn') {
      delete acl.pending[targetId];
      await putAcl(env, acl);
      await answerCallback(env, cq.id, 'נדחה');
      await send(env, chatId, `🚫 נדחה: <b>${escape(pending.name)}</b> (chat ${escape(targetId)})`);
      try { await send(env, parseInt(targetId, 10), '🚫 בקשת הגישה שלך נדחתה.'); } catch {}
      return;
    }
    return answerCallback(env, cq.id, 'unknown acl action');
  }
}

// =============================================================================
// Main message router
// =============================================================================

async function handleUpdate(env, update) {
  if (update.callback_query) return handleCallback(env, update.callback_query);
  const msg = update.message || update.edited_message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const messageId = msg.message_id;

  if (!text) return;

  // Access control gate — only the admin and explicitly-allowed users get through.
  // First contact: ask them for their full name. After they reply, queue the
  // approval request with both the name they typed AND their Telegram identity.
  const acl = await getAcl(env);
  if (!isAllowed(acl, chatId)) {
    const cidStr = String(chatId);
    const p = acl.pending[cidStr];
    const tgFirst = (msg.from && msg.from.first_name) || '';
    const tgLast = (msg.from && msg.from.last_name) || '';
    const tgUsername = msg.from && msg.from.username ? `@${msg.from.username}` : '';

    if (!p) {
      acl.pending[cidStr] = {
        stage: 'awaiting_name',
        telegramFirstName: tgFirst,
        telegramLastName: tgLast,
        username: tgUsername,
        requestedAt: new Date().toISOString(),
      };
      await putAcl(env, acl);
      await send(env, chatId, '🔒 הבוט סגור. כדי לבקש גישה, כתוב לי בבקשה את <b>השם המלא שלך</b>:');
      return;
    }

    if (p.stage === 'awaiting_name') {
      if (text.startsWith('/')) {
        await send(env, chatId, 'בבקשה כתוב את השם שלך (לא פקודה):');
        return;
      }
      const claimedName = text.trim().slice(0, 100);
      if (claimedName.length < 2) {
        await send(env, chatId, 'השם נראה קצר מדי. כתוב שם מלא:');
        return;
      }
      p.name = claimedName;
      p.stage = 'pending_approval';
      await putAcl(env, acl);
      await send(env, chatId, '✅ תודה. בקשת הגישה שלך נשלחה לבעלים — תקבל הודעה כשהיא תאושר.');
      const tgDisplay = [p.telegramFirstName, p.telegramLastName].filter(Boolean).join(' ') || '(ריק)';
      await send(env, acl.admin,
        `🔒 בקשת גישה חדשה לבוט\n\n` +
        `<b>שם שהוא כתב:</b> ${escape(claimedName)}\n` +
        `<b>שם בטלגרם:</b> ${escape(tgDisplay)}\n` +
        (p.username ? `<b>username:</b> ${escape(p.username)}\n` : '') +
        `<b>chat_id:</b> <code>${escape(cidStr)}</code>`,
        { reply_markup: { inline_keyboard: [
          [{ text: '✅ אישור', callback_data: `acl:ap:${cidStr}` },
           { text: '❌ דחייה', callback_data: `acl:dn:${cidStr}` }],
        ]}}
      );
      return;
    }

    // pending_approval
    await send(env, chatId, '⏳ הבקשה שלך עדיין בהמתנה לאישור הבעלים של הבוט.');
    return;
  }

  // Onboarding flow takes precedence
  const handledByPending = await handleOnboardingMessage(env, chatId, text, messageId);
  if (handledByPending) return;

  // Slash commands
  if (text.startsWith('/')) {
    const [cmdRaw, ...args] = text.split(/\s+/);
    const cmd = cmdRaw.split('@')[0].toLowerCase();

    if (cmd === '/start') {
      const u = await getUser(env, chatId);
      if (u) return send(env, chatId, `Already connected to <b>${escape(u.boxName)}</b>.\n\nSend /help for commands. /logout to forget.`);
      return startOnboarding(env, chatId);
    }
    if (cmd === '/cancel_setup') {
      await clearPending(env, chatId);
      return send(env, chatId, 'Setup cancelled.');
    }
    if (cmd === '/help') {
      const u = await getUser(env, chatId);
      if (!u) return send(env, chatId, 'Not connected yet. Send /start to link your Arbox account.');
      return send(env, chatId, HELP_LOGGED_IN);
    }

    // All remaining commands require an account
    const user = await getUser(env, chatId);
    if (!user) return send(env, chatId, 'Not connected yet. Send /start to link your Arbox account.');

    try {
      switch (cmd) {
        case '/whoami': return cmdWhoami(env, chatId, user);
        case '/logout': return cmdLogout(env, chatId);
        case '/next': return cmdNext(env, chatId, user);
        case '/upcoming': return cmdUpcoming(env, chatId, user);
        case '/today': return cmdToday(env, chatId, user);
        case '/schedule': return cmdSchedule(env, chatId, user, args);
        case '/cancel': return cmdCancel(env, chatId, user);
        case '/book': return cmdBook(env, chatId, user, args);
        case '/recurring': return cmdRecurring(env, chatId, user, args);
        case '/add': return startRecurringWizard(env, chatId);
        case '/grab': return startGrabWizard(env, chatId, user);
        case '/watches': return cmdWatches(env, chatId, user);
        case '/window': return cmdWindow(env, chatId, user);
        default: return send(env, chatId, `Unknown command: ${escape(cmd)}. Try /help.`);
      }
    } catch (e) {
      await send(env, chatId, `❌ Error: ${escape(e.message)}`);
    }
    return;
  }

  // Plain text from configured user
  const u = await getUser(env, chatId);
  if (!u) return send(env, chatId, 'Send /start to link your Arbox account.');
  return send(env, chatId, 'Send /help to see commands.');
}

// =============================================================================
// Cron handlers
// =============================================================================

// Per-rule helper: schedule a cancellation reminder for a freshly-booked class.
async function maybeScheduleReminder(env, chatId, rule, klass, dateStr) {
  if (!rule.reminderHours || rule.reminderHours <= 0) return;
  const classStartMs = israelDateTimeToUtcMs(dateStr, rule.time);
  const fireAtMs = classStartMs - rule.reminderHours * 3_600_000;
  if (fireAtMs <= Date.now()) return;
  const list = await getReminders(env, chatId);
  list.push({
    kind: 'cancel',
    fireAtMs, classStartMs, dateStr, time: rule.time,
    className: (klass.box_categories && klass.box_categories.name) || rule.class || '?',
    scheduleUserId: klass.user_booked || null,
    scheduleId: klass.id,
    ruleId: rule.id,
  });
  await putReminders(env, chatId, list);
}

// Always-on flair reminder fired 30 min before class start, reporting live waitlist size.
async function scheduleFlairReminder(env, chatId, klass, dateStr) {
  const time = klass.time;
  if (!time) return;
  const classStartMs = israelDateTimeToUtcMs(dateStr, time);
  const fireAtMs = classStartMs - 30 * 60_000;
  if (fireAtMs <= Date.now()) return;
  const list = await getReminders(env, chatId);
  list.push({
    kind: 'flair',
    fireAtMs, classStartMs, dateStr, time,
    className: (klass.box_categories && klass.box_categories.name) || '?',
    scheduleId: klass.id,
  });
  await putReminders(env, chatId, list);
}

async function runWatchesForUser(env, chatId, user, nowMs) {
  const watches = await getWatches(env, chatId);
  if (!watches.length) return null;

  const out = [];
  let changed = false;
  const remaining = [];

  for (const w of watches) {
    const classStartMs = israelDateTimeToUtcMs(w.date, w.time);
    if (classStartMs <= nowMs) {
      // Class already started or passed — drop the watch.
      out.push(`⏭ Watch dropped (class passed): ${w.date} ${w.time}`);
      changed = true;
      continue;
    }

    // Strict gating: NEVER ping Arbox until we know exactly when the window opens.
    const knownHours = w.openHoursBefore || user.detectedHoursBefore;
    if (!knownHours) {
      remaining.push(w);
      continue;
    }
    const opensAtMs = classStartMs - knownHours * 3_600_000;
    // Don't fire on cron passes that are too far from T=0 (no API call).
    // 28s = our budget for precision wait inside one cron invocation.
    if (nowMs < opensAtMs - 28_000) {
      remaining.push(w);
      continue;
    }

    // Pre-warm: fetch auth + schedule BEFORE T=0 so they're not on the critical path.
    let ctx;
    try { ctx = await arboxContext(user); }
    catch (e) { out.push(`❌ Watch ${w.date} ${w.time}: login failed — ${e.message}`); remaining.push(w); changed = true; continue; }

    let items;
    try { items = await arboxSchedule(ctx, w.date); }
    catch (e) { out.push(`❌ Watch ${w.date} ${w.time}: schedule fetch failed — ${e.message}`); remaining.push(w); changed = true; continue; }

    const klass = findClassByTime(items, w.time, w.class);
    if (!klass) {
      remaining.push(w);
      continue;
    }
    if (klass.user_booked) {
      out.push(`✓ Watch satisfied (already booked): ${w.date} ${w.time}`);
      changed = true; continue;
    }
    if (klass.user_in_standby) {
      out.push(`✓ Watch satisfied (already on waitlist): ${w.date} ${w.time}`);
      changed = true; continue;
    }

    const useWaitlist = w.waitlistIfFull !== false;
    const name = (klass.box_categories && klass.box_categories.name) || w.class || '?';

    // Burst-fire 5 staggered regular-booking requests around T=0.
    let res = await burstFire(ctx, klass.id, opensAtMs);
    if (!res.ok && useWaitlist && !isNotYetOpen(res)) {
      res = await arboxBookOrWaitlist(ctx, klass.id);
    }
    if (res.ok) {
      const tag = res.mode === 'waitlist' ? '📋 WAITLISTED' : '🏁 BOOKED';
      out.push(`${tag} ${w.date} ${w.time} ${name}`);
      changed = true;
      // Schedule reminder + record detected window if not yet known.
      try {
        const refreshed = await arboxSchedule(ctx, w.date);
        const fresh = refreshed.find(c => c.id === klass.id) || klass;
        const fakeRule = { reminderHours: w.reminderHours, time: w.time, class: w.class };
        await maybeScheduleReminder(env, chatId, fakeRule, fresh, w.date);
        if (res.mode === 'book') await scheduleFlairReminder(env, chatId, fresh, w.date);
      } catch {}
      if (!user.detectedHoursBefore) {
        const detected = Math.round(((classStartMs - nowMs) / 3_600_000) * 10) / 10;
        user.detectedHoursBefore = Math.ceil(detected);
        user.detectedAt = new Date().toISOString();
        await putUser(env, chatId, user);
      }
      continue; // remove from watches
    }
    if (isNotYetOpen(res)) {
      // Keep waiting; suppress the "still not yet open" notification.
      remaining.push(w);
      continue;
    }
    // Hard error (full+no waitlist, or other) — drop the watch and notify.
    const m = (res.body && res.body.error && (res.body.error.messageToUser || res.body.error.message)) || res.text.slice(0, 150);
    out.push(`❌ Watch ${w.date} ${w.time} ${name} — ${m}`);
    changed = true;
  }

  if (changed) await putWatches(env, chatId, remaining);
  return out.length ? out : null;
}

async function runRemindersForUser(env, chatId, user, nowMs) {
  const list = await getReminders(env, chatId);
  if (!list.length) return null;
  const due = list.filter(r => r.fireAtMs <= nowMs + 60_000 && r.fireAtMs >= nowMs - 24 * 3_600_000);
  if (!due.length) {
    const fresh = list.filter(r => r.fireAtMs > nowMs - 24 * 3_600_000);
    if (fresh.length !== list.length) await putReminders(env, chatId, fresh);
    return null;
  }

  // Cache one ctx per user across the batch.
  let ctx = null;

  for (const r of due) {
    if (r.kind === 'flair') {
      // Fetch fresh class state for the live waitlist count.
      let waitlist = 0, registered = '?', max = '?', stillBooked = false;
      try {
        if (!ctx) ctx = await arboxContext(user);
        const items = await arboxSchedule(ctx, r.dateStr);
        const k = items.find(c => c.id === r.scheduleId) || items.find(c => (c.time || '').startsWith(r.time));
        if (k) {
          waitlist = k.stand_by || 0;
          registered = k.registered ?? '?';
          max = (k.series && k.series.max_users) || k.max_users || '?';
          stillBooked = !!k.user_booked;
        }
      } catch {}
      if (!stillBooked) continue; // user cancelled — no flair
      const human = `${r.dateStr} ${r.time} <b>${escape(r.className)}</b>`;
      const tail = waitlist > 0
        ? `${waitlist} ${waitlist === 1 ? 'person is' : 'people are'} on the waitlist. Sucks for them. 😎`
        : `Class isn't even full (${registered}/${max}). Easy day.`;
      await send(env, chatId, `🏆 Class in 30 min: ${human}\n\nYou're <b>in</b>. ${tail}`);
      continue;
    }

    // 'cancel' kind (default for legacy entries with no kind field)
    let scheduleUserId = r.scheduleUserId;
    let resolvedScheduleId = r.scheduleId;
    if (!scheduleUserId || !resolvedScheduleId) {
      try {
        if (!ctx) ctx = await arboxContext(user);
        const items = await arboxSchedule(ctx, r.dateStr);
        const k = items.find(c => (c.time || '').startsWith(r.time));
        if (k && k.user_booked) {
          scheduleUserId = k.user_booked;
          resolvedScheduleId = k.id;
        }
      } catch {}
    }
    const human = `${r.dateStr} ${r.time} <b>${escape(r.className)}</b>`;
    const buttons = [];
    if (scheduleUserId && resolvedScheduleId) buttons.push([
      { text: '❌ Cancel this booking', callback_data: `cancel:${scheduleUserId}:${resolvedScheduleId}` },
      { text: '✅ Keep it', callback_data: 'rkeep' },
    ]);
    await send(env, chatId, `🔔 Reminder: you're booked for ${human} (in ${humanDuration(r.classStartMs - nowMs)}).\n\nWant to cancel?`, {
      reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
    });
  }

  const remaining = list.filter(r => !due.includes(r));
  await putReminders(env, chatId, remaining);
  return null;
}

async function runRaceForUser(env, chatId, user, nowMs) {
  const rules = (await getRules(env, chatId)).filter(r => !r.paused && r.mode === 'race' && (!r.endsAtMs || r.endsAtMs > nowMs));
  if (!rules.length) return null;

  // For each rule, find the next class instance to attempt right now.
  // We only act if we KNOW when registration opens (rule-level, rule-level detected,
  // or user-level detected window). If we don't know, skip — the wizard will have
  // probed at rule-add time, so this should be rare. No more brute-force polling.
  const candidates = [];
  for (const rule of rules) {
    const knownHours = rule.openHoursBefore || rule.detectedHoursBefore || user.detectedHoursBefore;
    if (!knownHours) continue;
    // Each rule has one or more (time, class) slots. Each slot gets its own opensAtMs.
    // Walk forward through eligible weekdays until we find an opens_at that's either
    // currently firing or still in the future. Skip past instances we've missed.
    for (const slot of ruleSlots(rule)) {
      for (let d = 0; d <= 21; d++) {
        const date = dateInTz(new Date(nowMs + d * 86400000));
        const wd = weekdayShortInTz(date);
        if (!rule.days.includes(wd)) continue;
        const classStartMs = israelDateTimeToUtcMs(date, slot.time);
        if (classStartMs <= nowMs) continue;
        const opensAtMs = classStartMs - knownHours * 3_600_000;
        // Catch-up window: extend up to 6 hours past opens_at to survive cron skips
        // / outages. For non-competitive classes this still books; for competitive
        // ones we at least join the waitlist instead of doing nothing.
        if (opensAtMs + 6 * 3_600_000 < nowMs) {
          continue; // window long-gone, try next instance
        }
        if (opensAtMs > nowMs + 28_000) {
          break; // not yet — stop scanning, later instances are even further out
        }
        candidates.push({ rule, slot, date, classStartMs, opensAtMs, knownHours });
        break;
      }
    }
  }
  if (!candidates.length) return null;

  let ctx;
  try { ctx = await arboxContext(user); }
  catch (e) { return [`❌ ${user.email}: race login failed — ${e.message}`]; }

  // Re-load rules so we can both write back the detected window AND track which
  // instances we've already reported to the user (to enforce "one message per attempt").
  const rulesAll = await getRules(env, chatId);
  // Prune stale reportedFor entries (anything more than 14 days old).
  const cutoffMs = nowMs - 14 * 86400000;
  for (const r of rulesAll) {
    if (!Array.isArray(r.reportedFor)) continue;
    r.reportedFor = r.reportedFor.filter(e => {
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(e);
      if (!m) return false;
      return new Date(m[1] + 'T00:00:00Z').getTime() >= cutoffMs;
    });
  }
  const out = [];
  let rulesChanged = false;

  for (const cand of candidates) {
    const useWaitlist = cand.rule.waitlistIfFull !== false;
    const ruleObj = rulesAll.find(r => r.id === cand.rule.id);
    const reportedFor = (ruleObj && ruleObj.reportedFor) || [];
    const instanceKey = `${cand.date}:${cand.slot.time}:${cand.slot.class || ''}`;
    if (reportedFor.includes(instanceKey)) continue; // already handled — silent skip
    // Multi-slot rules at the same time all resolve to whatever class the gym
    // scheduled at that time. Mark every same-time slot as reported so we emit
    // exactly one message per (rule, date, time).
    const markReported = () => {
      if (!ruleObj) return;
      const next = ruleObj.reportedFor ? [...ruleObj.reportedFor] : [];
      for (const s of ruleSlots(cand.rule)) {
        if (s.time !== cand.slot.time) continue;
        const k = `${cand.date}:${s.time}:${s.class || ''}`;
        if (!next.includes(k)) next.push(k);
      }
      ruleObj.reportedFor = next;
      rulesChanged = true;
    };
    let klass = null;
    try {
      const items = await arboxSchedule(ctx, cand.date);
      klass = findClassByTime(items, cand.slot.time, cand.slot.class);
    } catch (e) {
      continue; // transient, retry next cron
    }
    if (!klass) {
      if (nowMs > cand.opensAtMs + 4 * 60_000) {
        out.push(`❌ [race] ${cand.date} ${cand.slot.time} — class not found`);
        markReported();
      }
      continue;
    }

    const name = (klass.box_categories && klass.box_categories.name) || cand.slot.class || '?';

    if (klass.user_booked) {
      out.push(`🏁 [race] ${cand.date} ${cand.slot.time} ${name} — BOOKED`);
      markReported();
      continue;
    }
    if (klass.user_in_standby) {
      out.push(`📋 [race] ${cand.date} ${cand.slot.time} ${name} — WAITLISTED`);
      markReported();
      continue;
    }

    // Burst-fire 5 staggered regular-booking requests around the exact opening moment.
    const tagPrefix = `[race ${cand.date} ${cand.slot.time} "${cand.slot.class || '*'}" user=${chatId}]`;
    const msUntilOpen = cand.opensAtMs - Date.now();
    console.log(`${tagPrefix} burst-fire begins; ms_until_open=${msUntilOpen} klass.id=${klass.id} reg=${klass.registered}/${(klass.series||{}).max_users} stand_by=${klass.stand_by}`);
    let res = await burstFire(ctx, klass.id, cand.opensAtMs);
    console.log(`${tagPrefix} burst result: ok=${res.ok} status=${res.status} mode=${res.mode} body=${(res.text||'').slice(0,300)}`);
    if (!res.ok && useWaitlist && !isNotYetOpen(res)) {
      console.log(`${tagPrefix} falling back to standby (arboxBookOrWaitlist)`);
      res = await arboxBookOrWaitlist(ctx, klass.id);
      console.log(`${tagPrefix} fallback result: ok=${res.ok} status=${res.status} mode=${res.mode} body=${(res.text||'').slice(0,300)}`);
    } else if (!res.ok && isNotYetOpen(res)) {
      console.log(`${tagPrefix} response classified as not-yet-open; will retry next cron`);
    }

    if (res.ok) {
      const successMode = res.mode || 'book';
      out.push(`${successMode === 'waitlist' ? '📋 [race] WAITLISTED' : '🏁 [race] BOOKED'} ${cand.date} ${cand.slot.time} ${name}`);
      markReported();
      // Auto-detect window write-back.
      const detected = Math.round(((cand.classStartMs - Date.now()) / 3_600_000) * 10) / 10;
      if (ruleObj && !ruleObj.openHoursBefore) {
        ruleObj.detectedHoursBefore = Math.ceil(detected);
        rulesChanged = true;
      }
      try {
        const refreshed = await arboxSchedule(ctx, cand.date);
        const fresh = refreshed.find(c => c.id === klass.id) || klass;
        await maybeScheduleReminder(env, chatId, { ...cand.rule, time: cand.slot.time, class: cand.slot.class }, fresh, cand.date);
        if (res.mode === 'book') await scheduleFlairReminder(env, chatId, fresh, cand.date);
      } catch {}
    } else if (!isNotYetOpen(res)) {
      // Real failure — emit only at end of catch-up window so we don't spam each minute.
      if (nowMs > cand.opensAtMs + 5.5 * 3_600_000) {
        const m = (res.body && res.body.error && (res.body.error.messageToUser || res.body.error.message)) || `HTTP ${res.status}`;
        out.push(`❌ [race] ${cand.date} ${cand.slot.time} ${name} — ${m}`);
        markReported();
      }
    }
  }

  if (rulesChanged) await putRules(env, chatId, rulesAll);
  return out.length ? out : null;
}

// ponytail: daily self-audit. Walks every active race rule for the next 14 days,
// detects classes that should have been booked but weren't, attempts to recover
// (book / waitlist), and ships one report to the admin.
async function auditUser(env, chatId, user) {
  const rules = (await getRules(env, chatId)).filter(r => !r.paused && r.mode === 'race');
  if (!rules.length) return null;

  let ctx;
  try { ctx = await arboxContext(user); }
  catch (e) { return `<b>${escape(user.email)}</b>\n❌ Login failed: ${escape(e.message)}`; }

  const today = dateInTz(new Date());
  const horizon = dateInTz(new Date(Date.now() + HORIZON_DAYS * 86400000));
  const items = await arboxScheduleRange(ctx, today, horizon);
  const nowMs = Date.now();

  const fixes = [], issues = [], onTrack = [];

  for (const rule of rules) {
    const knownHours = rule.openHoursBefore || rule.detectedHoursBefore || user.detectedHoursBefore;
    if (!knownHours) continue;

    for (const slot of ruleSlots(rule)) {
      // Earliest matching future date whose window has already opened.
      for (let d = 0; d < HORIZON_DAYS; d++) {
        const date = dateInTz(new Date(nowMs + d * 86400000));
        if (!rule.days.includes(weekdayShortInTz(date))) continue;
        const classStartMs = israelDateTimeToUtcMs(date, slot.time);
        if (classStartMs < nowMs) continue; // class already happened
        const opensAtMs = classStartMs - knownHours * 3_600_000;
        if (opensAtMs > nowMs) break; // window not open yet → nothing to audit further out

        const klass = findClassByTime(items.filter(c => c.date === date), slot.time, slot.class);
        const label = `${date} ${slot.time}`;
        if (!klass) { issues.push(`⚠️ ${label} — gym hasn't published the class`); continue; }
        const className = (klass.box_categories && klass.box_categories.name) || slot.class || '?';
        if (klass.user_booked) { onTrack.push(`✓ ${label} ${className} — booked`); continue; }
        if (klass.user_in_standby) { onTrack.push(`✓ ${label} ${className} — waitlist #${klass.stand_by_position || '?'}`); continue; }

        // Missed — try to recover.
        const useWaitlist = rule.waitlistIfFull !== false;
        const res = await bookWithFallback(ctx, klass.id, useWaitlist);
        if (res.ok) {
          const tag = res.mode === 'waitlist' ? '📋 added to waitlist' : '🏁 booked';
          fixes.push(`✅ ${label} ${className} — ${tag}`);
        } else {
          const m = (res.body && res.body.error && (res.body.error.messageToUser || res.body.error.message)) || `HTTP ${res.status}`;
          issues.push(`❌ ${label} ${className} — could not recover: ${escape(m)}`);
        }
        break; // first missed instance per slot is enough; rest gets caught next day
      }
    }
  }

  if (!fixes.length && !issues.length && !onTrack.length) return null;
  const lines = [`<b>${escape(user.email)}</b>`];
  if (fixes.length) { lines.push('', '<b>Fixed:</b>', ...fixes); }
  if (issues.length) { lines.push('', '<b>Issues:</b>', ...issues); }
  if (!fixes.length && !issues.length) {
    lines.push(`✅ ${onTrack.length} upcoming booking${onTrack.length === 1 ? '' : 's'} on track.`);
  }
  return lines.join('\n');
}

async function maybeRunDailyAudit(env) {
  // Fire once per 23h. Gate via a single KV key so cron drift / restarts can't double-fire.
  const lastMs = parseInt((await env.ARBOX_KV.get('audit:last_ms')) || '0', 10);
  if (Date.now() - lastMs < 23 * 3_600_000) return;
  await env.ARBOX_KV.put('audit:last_ms', String(Date.now()));

  const acl = await getAcl(env);
  const userIds = await listUserChatIds(env);
  const sections = [];
  for (const chatId of userIds) {
    const user = await getUser(env, chatId);
    if (!user) continue;
    try {
      const s = await auditUser(env, chatId, user);
      if (s) sections.push(s);
    } catch (e) {
      sections.push(`<b>${escape(user.email || chatId)}</b>\n❌ Audit crashed: ${escape(e.message)}`);
    }
  }
  const header = `<b>📊 Daily booking audit</b> — ${formatLocalIL(Date.now())} Israel`;
  const body = sections.length ? sections.join('\n\n') : 'No active rules across any user.';
  await send(env, acl.admin, `${header}\n\n${body}`);
}

async function runScheduled(env, scheduledTime) {
  const nowMs = Date.parse(scheduledTime) || Date.now();
  const userIds = await listUserChatIds(env);
  // Admin always goes first — when multiple users race for the same opens_at
  // moment, the admin's burst-fire is dispatched before anyone else's.
  const acl = await getAcl(env);
  userIds.sort((a, b) => {
    if (String(a) === String(acl.admin)) return -1;
    if (String(b) === String(acl.admin)) return 1;
    return String(a).localeCompare(String(b));
  });
  for (const chatId of userIds) {
    const user = await getUser(env, chatId);
    if (!user) continue;
    const summaries = [];
    const r2 = await runRaceForUser(env, chatId, user, nowMs);
    if (r2) summaries.push(...r2);
    const r3 = await runWatchesForUser(env, chatId, user, nowMs);
    if (r3) summaries.push(...r3);
    if (summaries.length) await send(env, chatId, summaries.join('\n'));
    await runRemindersForUser(env, chatId, user, nowMs);
  }
  await maybeRunDailyAudit(env);
}

// =============================================================================
// Worker entry points
// =============================================================================

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('ok');
    const url = new URL(request.url);
    if (url.pathname !== `/webhook/${env.WEBHOOK_SECRET}`) return new Response('not found', { status: 404 });
    const update = await request.json();
    try {
      await handleUpdate(env, update);
    } catch (e) {
      console.log('handleUpdate error', e.message, e.stack);
    }
    return new Response('ok');
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env, event.scheduledTime).catch(e => {
      console.log('scheduled error', e.message, e.stack);
    }));
  },
};
