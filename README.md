# School

A schedule + assignment tracker you install like an app on your iPhone and
your Mac, with real push notifications for due dates, synced between both
devices. Runs entirely on Cloudflare's free tier — no server to maintain,
no monthly bill.

## What's in it

- **Today view** — a live clock, a **Now / Next** strip (what you're in,
  how long is left, what's next, and passing-period countdowns), today's
  schedule, what's coming up, and a 7-day workload heatmap.
- **Weekly schedule** — a period-based bell schedule (like a real school's
  block/rotating schedule): you define which periods meet on each weekday
  and at what time, then classes just pick a period. A class only shows up
  on the days its period is actually scheduled — so a Wednesday with a
  shorter, later-starting day naturally shows fewer classes than a full
  Tuesday, with no per-day duplicate data entry. Period start/end times are
  entered **once** (Schedule → Period times) and auto-fill everywhere that
  period meets. A **This week** toggle shows the next 7 days as an agenda
  with assignments slotted under their due day.
- **Lunch, WIN, and other blocks** — the bell schedule isn't only class
  periods. Add lunch, a WIN/flex/advisory block, a break, etc.; "**Add a
  block to every school day**" drops one into all your school days at once.
- **Passing periods** — short gaps between slots are shown as passing time
  automatically (threshold configurable in Settings). Longer gaps stay
  "free periods" you can size a focus timer to.
- **Class home pages** — tapping a class anywhere opens its own page:
  when it meets, the next meeting, its assignments (with a quick add),
  editable notes, links (Canvas, textbook, syllabus), and office hours.
  Editing the class is one tap from there.
- **Per-class colors** — each class picks a color, shown as a bar on every
  schedule/Today/calendar row and a band on its home page, so blocks are
  identifiable at a glance.
- **Assignment tracking** — due dates, priority, effort estimate, an
  optional link (Canvas, a doc, etc.), notes, one-tap complete. Filter the
  list by class / this week / overdue and sort by due date, priority, or
  class.
- **`.ics` export** — Settings → Data → Export pulls your assignments and
  recurring class meetings into a calendar file for Apple/Google Calendar.
- **Real push notifications** — configurable reminders (default: 1 day and
  1 hour before due) delivered via the standard Web Push protocol, plus a
  one-time "overdue" nudge.
- **Add anything (natural language)** — the `+` in the top bar, and the
  quick-add field on Tasks, take one line of plain text and figure out
  what you mean:
  - *Assignment* — "essay for bio due Friday 5pm !" (class, due date,
    high priority), "read ch 4 tomorrow ~45m", "pset for calc due
    monday, weekly until dec 12".
  - *To-do* — "bring goggles", "return the field trip form".
  - *Class* — "AP Bio p3 with Dr. Lee in room 214".

  It's a deterministic offline parser (no API key, works offline). When
  it's sure, it creates the item with an undo toast; when it isn't, it
  opens the matching form pre-filled so nothing is lost. If you want more
  flexible understanding you can point it at your own endpoint under
  Settings → Data → Natural-language assist — it's only called when the
  built-in parser is unsure, and nothing is sent unless you set it up. No
  model weights ship with the app.
- **Repeating assignments** — a "Repeat weekly" option creates one
  assignment per week through a chosen end date, for things like weekly
  reading.
- **Snooze** — push a reminder an hour or a day out from the assignment
  itself. (Notification action buttons are a bonus where the browser
  supports them, but the reliable path — especially on Safari — is the
  Snooze buttons inside the assignment sheet.)
- **To-dos** — a separate, simple checklist for things that aren't tied to
  a class — a form to return, something to pack — right alongside your
  assignments.
- **"Do this next"** — one highlighted suggestion on Today, weighing both
  urgency and priority rather than just the soonest due date.
- **Free-period finder** — gaps of 20+ minutes between today's classes are
  called out on Today, tap one to size the focus timer to it.
- **Search** — across class names, instructors, rooms, assignment titles
  and notes, and class notes content.
- **"While you were away"** — a one-time nudge on open summarizing what
  became due or overdue while the app was closed.
- **Points & streaks** — completing something early earns more points than
  completing it late; a running streak resets on a late completion.
- **Focus timer (Pomodoro)** — also pauses push reminders while it runs, and
  tries to keep the screen awake on supported browsers.
- **Month calendar** — assignment due dates plotted against your recurring
  schedule.
- **Multiple terms, with archiving** — keep semesters separate, switch
  anytime, and archive old ones out of the switcher without deleting them.
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
You can deploy it either from the command line (`wrangler deploy`) or by
connecting a GitHub repo to Cloudflare's dashboard and letting it
auto-deploy on every push — no local tooling required for the latter.

```
src/            Worker backend (routes, auth, KV storage, Web Push, cron)
public/         Frontend (HTML/CSS/JS, manifest, service worker, icons)
scripts/        VAPID key generator (browser + CLI versions), icon SVGs
test/           Dev-only tests (not deployed) — see "Testing" below
```

---

# Option A: GitHub + Cloudflare dashboard (no command line)

This is the simplest path if you don't want to touch a terminal at all.

## A1. Get the files into a GitHub repo

1. Unzip the project on your computer (double-click the zip — no
   terminal needed).
2. On [github.com](https://github.com), create a new repository (it can
   be private).
3. On the new repo's page, select **Add file → Upload files**, then drag
   the whole unzipped folder's contents into the browser window. Commit
   the upload.

(If you're comfortable with GitHub Desktop instead, that works too — the
result just needs to be a repo containing these files.)

## A2. Generate your push notification keys

Open `scripts/generate-vapid-keys.html` by double-clicking it — it opens
in your default browser and needs no server or install. Select
**Generate keys**. You'll get two values:

- A **public key** — not secret.
- A **private key** (JSON) — keep this one private; don't commit it
  anywhere.

Keep this browser tab open; you'll paste both values in over the next two
steps.

## A3. Fill in your public settings

Back on GitHub, open `wrangler.jsonc` in your repo and select the pencil
(edit) icon. Paste your public key into `vars.VAPID_PUBLIC_KEY`, and
change `vars.VAPID_SUBJECT` to `mailto:` your own email. Commit the
change directly to the main branch.

## A4. Connect the repo to Cloudflare

1. In the [Cloudflare dashboard](https://dash.cloudflare.com), go to
   **Workers & Pages → Create application → Import a repository**.
2. Connect your GitHub account if you haven't already, and select the
   repo you just created.
3. Leave the build settings as detected (this project needs no build
   command) and select **Save and Deploy**.

Cloudflare will read `wrangler.jsonc`, automatically create the KV
namespace this app needs (no manual setup — it's provisioned for you on
first deploy), set up the 15-minute reminder check, and deploy. You'll
get a live URL like `https://school-app.<your-subdomain>.workers.dev`.

*If a deploy ever fails complaining about the KV binding*, automatic
provisioning didn't kick in — fall back to creating it yourself: **Workers
& Pages → KV → Create a namespace**, then edit `wrangler.jsonc` on GitHub
to add `"id": "the-id-you-were-given"` next to the `SCHOOL_KV` binding.

## A5. Add your private key as a secret

Once the first deploy succeeds:

1. Go to your Worker in the dashboard (**Workers & Pages → your Worker**).
2. **Settings → Variables and Secrets → Add**.
3. Type: **Secret**. Name: `VAPID_PRIVATE_JWK`. Value: paste the private
   key JSON from step A2.
4. Select **Deploy** to apply it.

This only needs to be done once — secrets you set here aren't stored in
your repo, so they survive every future automatic deploy triggered by a
git push.

## A6. First run

Open your live URL. You'll be asked to set a passcode (4+ characters) —
that's the only "login" the app has. From now on, any change you commit
on GitHub (even editing a file right in the browser) automatically
redeploys.

---

# Option B: Command line (wrangler)

If you'd rather use a terminal, this is faster for iterating on changes.

## B1. Prerequisites

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up).
- [Node.js](https://nodejs.org) 18+ installed locally.

## B2. Install dependencies

```bash
cd school-app
npm install
npx wrangler login
```

`wrangler login` opens a browser tab to connect your Cloudflare account.

## B3. Set up push notifications (VAPID keys)

```bash
npm run generate-vapid-keys
```

(Or use `scripts/generate-vapid-keys.html` in a browser — same result.)
This prints two things:

1. A **public key** — paste it into `wrangler.jsonc` as
   `vars.VAPID_PUBLIC_KEY`. It's not secret.
2. A **private key** (JSON) — keep this one secret. Run:

   ```bash
   npx wrangler secret put VAPID_PRIVATE_JWK
   ```

   and paste the JSON when prompted.

Also update `vars.VAPID_SUBJECT` in `wrangler.jsonc` to `mailto:` your own
email.

## B4. Deploy

```bash
npx wrangler deploy
```

The KV namespace this app needs is created automatically on this first
deploy (no separate `wrangler kv namespace create` step required).
Wrangler prints your live URL, something like
`https://school-app.<your-subdomain>.workers.dev`.

## B5. First run

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
- **Set your period times once**, in the Schedule tab → **Period times**
  (e.g. "1" = 08:00–08:50). The bell-schedule editor fills these in
  automatically so you never re-type them.
- **Set up your bell schedule next**, in the Schedule tab → **Bell
  schedule**. For each weekday, list the class periods that meet plus any
  blocks (lunch, WIN, advisory…), or mark it "no school". This is what
  makes a rotating/block schedule work — e.g. a normal day might have
  periods 1–7 plus a WIN block, while Wednesday only has WIN/2/4/6
  starting later. There's a "copy from another day" shortcut, and an
  "**Add a block to every school day**" button for things like a daily
  WIN or lunch.
- **Then add classes**, from the top-bar `+` ("Chemistry p3 with Mr. Ruiz
  in 302") or the schedule's empty period rows: each one just picks a
  period (e.g. "3" or "WIN") and a color — which days and times it meets
  comes from the bell schedule automatically.
- **Add assignments and to-dos** from the top-bar `+` or the Tasks tab in
  plain language, or paste a syllabus schedule block with **Paste
  syllabus** and review what it finds before importing.
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
npm install              # installs jsdom, dev-only
npm test                 # runs everything below in sequence
node e2e-test.mjs         # backend API tests against an in-memory KV mock
node cron-test.mjs        # reminder-sweep failure isolation (bad data, bad subscriptions)
node date-parse-test.mjs  # natural-language date parsing ("Friday", "in 3 days", etc.)
node nl-parse-test.mjs    # the "add anything" parser (assignment / to-do / class routing + fields)
node dom-smoke.mjs        # full frontend flow against the real backend logic
```

Worth re-running these after making changes, especially to `src/` or
`public/js/app.js`.

## Extending it

A few things that were left out on purpose to keep scope focused, in case
future-you wants them:

- **Grades/GPA** — the data model doesn't have grade weights yet; would
  need a `grades:<termId>` KV key and a small calculator UI.
- **Smarter natural-language / syllabus parsing** — `public/js/nl-parse.js`
  has a `parseWithAssist` hook that POSTs to an endpoint you configure
  (Settings → Data) and is only called when the offline parser is unsure.
  Pointing it at an LLM is a self-contained addition; no key ships with
  the app on purpose.
- **"Class starting" reminders** — the cron sweep (`src/cron.js`) only
  looks at assignment due dates today; a "next class in 5 min" nudge would
  slot in alongside.
- **Per-assignment reminder overrides** — reminders currently use one
  global offset list; `assignment.remindersSent` already exists per item,
  so overrides would mainly be a UI + one field addition.
- **Notification action buttons for snoozing** — wired up in `sw.js` as a
  progressive enhancement, but as of this writing notification `actions`
  aren't reliably supported across browsers (notably not on Safari) — the
  primary, always-available way to snooze is the buttons inside the
  assignment sheet itself.
