# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`arbox-bot` is a single-file Cloudflare Worker that runs a multi-tenant Telegram bot for booking classes against the Arbox gym-management API (`apiappv2.arboxapp.com`). All logic — Telegram webhook routing, Arbox API client, KV state, onboarding wizard, recurring-rule engine, cron handlers — lives in `src/worker.js` (~1650 LOC, plain JS ES modules, no build step). State is persisted in a single Cloudflare KV namespace (`ARBOX_KV`).

There is no test suite, no lint config, no `package-lock.json`/`pnpm-lock.yaml`, and no separate Node-side tooling. Wrangler is invoked via `npx`.

## Common commands

```bash
npx wrangler dev        # local dev server (also: npm run dev)
npx wrangler deploy     # ship to Cloudflare (also: npm run deploy)
npx wrangler tail       # live-tail prod logs (also: npm run tail)
```

Secrets are managed via Wrangler, not in source:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

The Telegram webhook must point at `https://<worker>/webhook/<WEBHOOK_SECRET>` — the path-segment secret is the only auth on the fetch handler.

KV inspection (useful when debugging a user's state):

```bash
npx wrangler kv key list   --binding=ARBOX_KV
npx wrangler kv key get    --binding=ARBOX_KV "users:<chat_id>"
npx wrangler kv key delete --binding=ARBOX_KV "users:<chat_id>"
```

## Cron model

`wrangler.jsonc` declares a single cron trigger:

- `* * * * *` — every minute. Runs race rules, watches, and reminders.

Race-only by design: there is no `mode: 'daily'` path. If you reintroduce one, add a matching cron entry and dispatch on `event.scheduledTime` inside `runScheduled`.

## KV key layout

All state lives under these prefixes in `ARBOX_KV`:

```
users:<chat_id>     → { email, password, boxId, locationsBoxId, boxName,
                        externalGymId, whitelabel, detectedHoursBefore?, ... }
pending:<chat_id>   → onboarding / wizard state machine
rules:<chat_id>     → [ { id, mode, days, time, class?, openHoursBefore?,
                          detectedHoursBefore?, weeks, endsAtMs, reminderHours,
                          waitlistIfFull, paused, ... } ]
reminders:<chat_id> → [ { fireAtMs, classStartMs, dateStr, time,
                          className, scheduleUserId, ruleId } ]
index:users         → [ chat_id, ... ]   ← MUST be kept in sync; cron iterates this
ratemark:<rule_key> → ISO timestamp (rate-limit guard, currently unused but reserved)
```

`index:users` is the only way the cron handler knows who exists. If you write to `users:<id>` directly, also push to `index:users` (or `putUser` will do both for you). `deleteUser` also unhooks the index — preserve this in any new flow that removes a user.

Passwords are stored in plaintext in KV (encrypted at rest by Cloudflare, but readable by anyone with KV access). The onboarding flow tells the user this and offers `/logout` to wipe. Don't add features that print or log the password.

## Arbox API quirks

- Arbox runs multiple white-labelled apps (`arbox`, `wondare`, …). The `whitelabel` HTTP header selects which gym pool the credentials are valid for. The constant `KNOWN_WHITELABELS` is the discovery list — extend it when a new whitelabel appears, then onboarding will probe it automatically.
- Login returns short-lived `accesstoken` + `refreshtoken`. The bot doesn't refresh — it just re-logs in on every cron tick / command via `arboxContext`. That's intentional given Worker statelessness; do not "optimize" by caching tokens in a module-level variable (Workers may reuse isolates across requests but it's not guaranteed, and the token will expire anyway).
- `/api/v2/scheduleStandBy/insert` is the "smart" booking endpoint: it auto-books if there's room, otherwise waitlists. Inspect `body.data.user_booked` vs `body.data.user_in_standby` to know which happened.
- "Registration not yet open" surfaces as HTTP 400/403/422 with a localised message. `isNotYetOpen()` does substring matching on common phrases — extend it if you see new variants in `npx wrangler tail`.
- Booking-window detection: each class object has a `booking_option` field. `'registerToSchedule'` means *open right now*; anything else (or empty) means closed. `detectBookingWindow()` finds the boundary between latest-open and earliest-closed in the next 14 days. Cached per-user as `user.detectedHoursBefore`.

## The race loop

`runRaceForUser` is the trickiest part. It fires every minute and checks each `mode: 'race'` rule against its known opening time (`rule.openHoursBefore` ∥ `rule.detectedHoursBefore` ∥ `user.detectedHoursBefore`). When `now` is in the catch-up window `[opensAt - 28s, opensAt + 6h]`, it pre-fetches the schedule, sleeps to within ~150ms of `opensAt`, and burst-fires 5 staggered booking requests via `burstFire`. If that loses the race, falls back to `arboxBookOrWaitlist` to join the waitlist.

Constraints to preserve:

- "not yet open" responses must NOT notify the user — only success / hard error at the end of the catch-up window produces Telegram output. Otherwise the user gets pinged every minute leading up to a class.
- On first successful booking, the rule auto-learns and writes back `detectedHoursBefore` for next time.
- `rule.reportedFor` tracks which (date, slot) pairs already produced a Telegram message; pruned to a 14-day rolling window.

## Wizard / pending-state machine

Onboarding and `/add` both use the same `pending:<chat_id>` slot but with different shapes — onboarding has flat `step` strings (`email`, `password`, `gym`); the recurring wizard sets `type: 'rwiz'` and progresses through `days → slot → window → cycles → waitlist → reminder → confirm`. Don't conflate them: `handleOnboardingMessage` checks `p.type === 'rwiz'` to route into the wizard branch.

Telegram callback_data is capped at 64 bytes. When you need to ship larger payloads (e.g. a list of class slots), stash it in `pending` and reference by index — see `rwAdvanceToSlots` and the `rw:slot:<idx>` callback.

## Timezone

Everything user-facing is `Asia/Jerusalem` (`TZ` constant). The bot speaks Israeli class times; Arbox API dates are UTC. `israelDateTimeToUtcMs` does the wall-clock-to-UTC conversion via `Intl.DateTimeFormat` shortOffset probing — kept inline because Workers don't ship `tzdb`-aware libraries by default. If you change this, test around DST boundaries (late March / late October).

## Conventions when editing `worker.js`

- The file is intentionally one module. Don't split it into multiple files unless the user asks — Wrangler's main is `src/worker.js` and there's no bundler beyond what Wrangler does.
- Match existing style: 2-space indent, single quotes, semicolons, terse helpers, HTML `parse_mode` for Telegram messages (so escape user-supplied strings with `escape()`).
- New Telegram-facing features should: (1) use `escape()` on every interpolated value, (2) gracefully no-op for users without `users:<chat_id>` records, (3) wrap network calls in try/catch and surface errors via `send(...)` rather than throwing into the webhook handler.
- New cron behaviour goes through `runScheduled` and must iterate `index:users`; do not assume any external scheduler.
