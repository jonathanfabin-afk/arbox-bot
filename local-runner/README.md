# local-runner

Israel-local race runner. Runs on your laptop, fires booking POSTs to Arbox from ~15ms away instead of ~150ms from CF Frankfurt. Closes the latency gap that lets other bots beat us.

Runs alongside the CF Worker — both fire at `opens_at`, whichever reaches Arbox first books. No coordination needed; the second one just gets "already booked" and no-ops.

## What it does

- Reads users + rules from the same Cloudflare KV the Worker uses (no config drift).
- Keeps an Arbox session warm per user (relogins every 8 min in the background).
- For each `mode:'race'` rule, computes `opens_at` and `setTimeout`s to fire exactly at T=0.
- Precision-waits the final milliseconds with a busy loop (Windows `setTimeout` drifts up to 15ms otherwise).
- POSTs `/api/v2/scheduleStandBy/insert` (same "smart" endpoint the Worker uses).
- Refetches the class to see the result, computes race position (`#N/16`), sends to Telegram tagged `[local]`.

## Scope (deliberately narrow)

- **ONLY** does the race POST. All other features — audits, reminders, waitlist-position watching, `/today`, `/upcoming`, onboarding — stay on the CF Worker.
- No local database. State lives in CF KV; this process is stateless-restartable.
- No web UI, no CLI beyond `node race-runner.mjs`. Console logs are the debugger.

## Setup

Prereqs:
- Node.js 20 or newer (`node -v` to check)
- A Cloudflare API token with **Workers KV Storage: Read** permission
- Your Cloudflare account ID
- The Telegram bot token you're already using (same one as the Worker)

```powershell
cd C:\Users\jonat\arbox-bot\local-runner
npm install
copy .env.example .env
# Edit .env with your CF token, account ID, and TG token
node race-runner.mjs
```

You should see:

```
2026-07-20T13:45:12.123Z local race runner starting…
2026-07-20T13:45:13.456Z loaded 3 user(s), 5 race rule(s)
2026-07-20T13:45:13.789Z   8319543322 · Lironmond@gmail.com · 3 race rules
2026-07-20T13:45:14.012Z [8319543322] session warmed (packageId=…)
2026-07-20T13:45:14.234Z [8319543322][2] next fire: 2026-07-23 08:15 "Pure Power" — in 4321.8min
```

Kill with `Ctrl+C`. Next fire is scheduled in memory — restarting recomputes from KV, so it's safe.

## Running unattended (recommended)

You want this alive 24/7 across Windows updates, reboots, sleep cycles. The lightest path:

### Task Scheduler (built into Windows)

1. Open **Task Scheduler** (Win+R → `taskschd.msc`).
2. Create Task (not Basic Task) → **Triggers**: "At log on" for your user.
3. **Actions**: Program `node`, arguments `race-runner.mjs`, Start in `C:\Users\jonat\arbox-bot\local-runner`.
4. **Conditions**: uncheck "Start the task only if the computer is on AC power" (leave it on battery too).
5. **Settings**: check "Restart the task" every 1 min if it fails, up to 999 times.

Verify by killing your Node process and confirming it restarts, and by rebooting.

### Power management

Your laptop must not sleep. Confirmed earlier: on AC it doesn't sleep, on battery it hibernates in 3 min. Two options:
- Always leave it plugged in.
- Or run `powercfg /change standby-timeout-dc 0` in an admin PowerShell to disable DC sleep. Battery drains fast; only do this if plugged in most of the time.

## Belt & suspenders with the CF Worker

Both fire at `opens_at`. Whichever POST reaches Arbox first wins. The second POST hits with a body like `{"error":{"messageToUser":"you're already booked"}}` and no-ops in our client. Duplicate Telegram messages are the only visible artifact — the local one is tagged `[local]` and arrives first.

If you want to silence the CF Worker's race notifications later, gate on presence of a local-runner `reportedFor` marker. For now, dual messages are the debug signal.

## Failure modes

- **Login fails**: process still runs; each `scheduleRaceFire` retries via `ensureSession` on next fire, or the 8-min refresh interval fixes it. Nothing to do.
- **KV reload fails**: same — logged, retried on next 15-min interval.
- **Fire misses (POST fails)**: message goes to Telegram, next fire is scheduled 1 min later.
- **Laptop asleep / offline**: CF Worker still fires from Frankfurt. Slower, but you'll still likely make the waitlist.

## Security

- `.env` holds a CF API token that can READ your KV (which contains user passwords). Treat it like the KV itself. `.env` is already gitignored.
- The CF token should be scoped to KV read-only. Don't grant edit/deploy scopes.
- Passwords never appear in logs (only Telegram chat IDs and rule identifiers).

## Debugging

- Watch the console for `FIRED — arrived T+XX ms` — that's your latency to Arbox.
- If `T+` is consistently > 200ms, network/system time is off. Sync with `w32tm /resync`.
- Compare with the CF Worker's race message — the local one should arrive earlier.
