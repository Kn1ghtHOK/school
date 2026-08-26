# School

A schedule + assignment tracker you install like an app on your iPhone and
your Mac, with real push notifications for due dates, synced between both
devices. Runs entirely on Cloudflare's free tier — no server to maintain,
no monthly bill.

## What's in it

- **Today view** — a live clock, today's classes, what's coming up, and a
  7-day workload heatmap.
- **Weekly schedule** — a period-based bell schedule (like a real school's
  block/rotating schedule): you define which periods meet on each weekday
  and at what time, then classes just pick a period. A class only shows up
  on the days its period is actually scheduled — so a Wednesday with a
  shorter, later-starting day naturally shows fewer classes than a full
  Tuesday, with no per-day duplicate data entry.
- **Assignment tracking** — due dates, priority, notes, one-tap complete.
- **Real push notifications** — configurable reminders (default: 1 day and
  1 hour before due) delivered via the standard Web Push protocol, plus a
  one-time "overdue" nudge.
- **Points & streaks** — completing something early earns more points than
  completing it late; a running streak resets on a late completion.
- **Focus timer (Pomodoro)** — also pauses push reminders while it runs, and
  tries to keep the screen awake on supported browsers.
- **Month calendar** — assignment due dates plotted against your recurring
  schedule.
- **Multiple terms** — keep Fall/Spring semesters separate, switch anytime.
- **Syllabus paste-in** — paste a schedule block from a syllabus and it
  pulls out dated items (exams, quizzes, readings, due dates) for you to
  review and import — nothing is added without your OK.
- **Synced across devices** — one passcode, no email or account. Log in
  with the same passcode on your iPhone and Mac and you're looking at the
  same data.
- **Offline-capable** — the app shell is cached by a service worker, so it
  still opens without a connection (though editing needs one).

## How it's built

Cloudflare Workers (API + cron) + Workers KV (storage) + a static
Workers Assets frontend — plain HTML/CSS/JS, no framework, no build step.
`wrangler deploy` is the entire build pipeline.

```
src/            Worker backend (routes, auth, KV storage, Web Push, cron)
public/         Frontend (HTML/CSS/JS, manifest, service worker, icons)
scripts/        One-time VAPID key generator + icon source SVGs
test/           Dev-only tests (not deployed) — see "Testing" below
```

---

## 1. Prerequisites

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up).
- [Node.js](https://nodejs.org) 18+ installed locally.
- That's it — no credit card required for what this app uses.

## 2. Install dependencies

```bash
cd school-app
npm install
npx wrangler login
```

`wrangler login` opens a browser tab to connect your Cloudflare account.

## 3. Create the KV namespace

```bash
npx wrangler kv namespace create SCHOOL_KV
```

This prints an `id`. Open `wrangler.jsonc` and paste it in:

```jsonc
"kv_namespaces": [
  { "binding": "SCHOOL_KV", "id": "PASTE_YOUR_ID_HERE" }
]
```

## 4. Set up push notifications (VAPID keys)

```bash
npm run generate-vapid-keys
```

This prints two things:

1. A **public key** — paste it into `wrangler.jsonc` as
   `vars.VAPID_PUBLIC_KEY`. It's not secret.
2. A **private key** (JSON) — keep this one secret. Run:

   ```bash
   npx wrangler secret put VAPID_PRIVATE_JWK
   ```

   and paste the JSON when prompted.

Also update `vars.VAPID_SUBJECT` in `wrangler.jsonc` to `mailto:` your own
email (this is only shown to push services if they ever need to contact
you about your traffic — it's standard practice, not visible to you day to
day).

## 5. Deploy

```bash
npx wrangler deploy
```

Wrangler prints your live URL, something like
`https://school-app.<your-subdomain>.workers.dev`. You can also attach a
custom domain later from the Cloudflare dashboard if you want one — the
app works fine on the free `workers.dev` URL too.

## 6. First run

Open the URL. You'll be asked to set a passcode (4+ characters) — this is
the only "login" the app has. Use the same passcode on every device you
open the app from; there's no separate account per device.

---

## Installing on your iPhone

1. Open the URL in **Safari** (has to be Safari, not Chrome — iOS routes
   all browsers through Safari's engine for this).
2. Tap the Share icon → **Add to Home Screen**.
3. Open the app from the new home screen icon (not from a Safari tab —
   push notifications only work when launched this way).
4. In the app, go to **Settings → Notifications → Enable** and accept the
   permission prompt.

## Installing on your Mac

1. Open the URL in **Safari**.
2. Safari menu → **File → Add to Dock** (or the Share icon → Add to Dock,
   depending on your macOS version).
3. Open it from the Dock, then enable notifications the same way as above
   under Settings.

Both platforms use the same standard Web Push protocol under the hood, so
the same reminder reaches whichever devices you've enabled notifications
on — no extra setup per device beyond tapping "Enable" once on each.

---

## Using it

- **Add a term first** (Settings → Terms → Add a term) — everything else
  is scoped to a term, so this unlocks the rest of the app.
- **Set up your bell schedule next**, in the Schedule tab → **Edit bell
  schedule**. For each weekday, list the periods that meet and their
  times (or mark it "no school"). This is what makes a rotating/block
  schedule work — e.g. a normal day might have periods 1–7 plus a WIN
  period, while Wednesday only has WIN/2/4/6 starting later. There's a
  "copy from another day" shortcut for days that repeat the same pattern.
- **Then add classes** in the Schedule tab: each one just picks a period
  (e.g. "3" or "WIN") — which days and times it meets comes from the bell
  schedule automatically.
- **Add assignments** from the Tasks tab, or paste a syllabus schedule
  block with **Paste syllabus** and review what it finds before importing.
- **Reminder timing** is set in Settings → Notifications (minutes before
  due, comma-separated — defaults to 1 day and 1 hour). A background job
  checks every 15 minutes and sends any reminders that are due.
- **Focus mode** pauses reminders for the length of the session so you're
  not interrupted — it resumes automatically when the timer ends.

## A note on the syllabus parser

It's a heuristic, not AI — it looks for lines with a recognizable date
(like "Oct 8" or "10/8") and guesses a type (exam, quiz, reading, etc.)
from keywords. It'll miss unusual formats and occasionally flag something
irrelevant. That's why nothing gets imported without you reviewing and
checking it off first.

## Free-tier limits, in practice

Cloudflare's free plan gives you 100,000 Worker requests/day and, on
Workers KV specifically, 100,000 reads/day and **1,000 writes/day** (the
tighter one). Normal day-to-day use — adding a few classes, checking
things off, editing notes — is nowhere close to that. The one thing worth
knowing: every assignment you import counts as a write, so if you ever
paste in an enormous syllabus and import hundreds of items in one sitting,
you could approach the daily cap. Splitting a huge import across two
sessions avoids that; it's not a concern for ordinary use.

---

## Testing

`test/` has Node-based tests that aren't deployed (they're not in
`public/` or `src/`'s dependency graph, so `wrangler deploy` never touches
them):

```bash
cd test
npm install        # installs jsdom, dev-only
node e2e-test.mjs   # backend API tests against an in-memory KV mock
node dom-smoke.mjs  # full frontend flow against the real backend logic
```

Worth re-running these after making changes, especially to `src/` or
`public/js/app.js`.

## Extending it

A few things that were left out on purpose to keep v1 focused, in case
future-you wants them:

- **Grades/GPA** — the data model doesn't have grade weights yet; would
  need a `grades:<termId>` KV key and a small calculator UI.
- **.ics export** — schedule/assignments are plain JS objects, so writing
  an `.ics` string from them is a self-contained addition.
- **Smarter syllabus parsing** — swapping the regex parser for a call to
  an LLM API would need you to bring your own API key (kept out of v1 so
  the app has no required paid dependency).
- **Per-assignment reminder overrides** — reminders currently use one
  global offset list; `assignment.remindersSent` already exists per item,
  so overrides would mainly be a UI + one field addition.
