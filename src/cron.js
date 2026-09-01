import { getJSON, putJSON, keys, DEFAULT_SETTINGS } from "./lib/store.js";
import { sendWebPush } from "./lib/webpush.js";

function relativeLabel(dueDate, now) {
  const diffMin = Math.round((new Date(dueDate).getTime() - now) / 60000);
  if (diffMin <= 0) return "now";
  if (diffMin < 60) return `in ${diffMin} min`;
  if (diffMin < 24 * 60) return `in ${Math.round(diffMin / 60)} hr`;
  return `in ${Math.round(diffMin / (60 * 24))} days`;
}

/** Sends one payload to every subscription, isolating failures per-device. */
async function broadcast(subs, payload, vapidKeys, subject, expiredEndpoints, context) {
  for (const sub of subs) {
    try {
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) continue; // skip malformed subscriptions
      const result = await sendWebPush(sub, payload, vapidKeys, subject);
      if (result.expired) expiredEndpoints.add(sub.endpoint);
    } catch (e) {
      // A single unreachable device (offline, network blip, bad endpoint)
      // should never stop the reminder from reaching other devices.
      console.error(`Push send failed for ${context}:`, e);
    }
  }
}

/**
 * Runs on a schedule (see wrangler.jsonc triggers.crons). Every failure
 * boundary below is intentionally isolated — a bad subscription, a
 * malformed assignment, or one term's bad data should never prevent
 * reminders for everything else from going out. This function should
 * never throw; anything unexpected is logged and skipped.
 */
export async function runReminderSweep(env) {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY) return; // push not configured yet

  let vapidKeys;
  try {
    vapidKeys = { privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), publicKeyB64url: env.VAPID_PUBLIC_KEY };
  } catch (e) {
    console.error("VAPID_PRIVATE_JWK is not valid JSON — reminders are disabled until this is fixed.", e);
    return;
  }

  const focus = await getJSON(env.SCHOOL_KV, keys.focus(), { until: null });
  const now = Date.now();
  if (focus.until && focus.until > now) return; // do-not-disturb during focus sessions

  let subs = await getJSON(env.SCHOOL_KV, keys.pushSubs(), []);
  if (!Array.isArray(subs) || subs.length === 0) return;

  const settings = await getJSON(env.SCHOOL_KV, keys.settings(), DEFAULT_SETTINGS);
  const offsets = Array.isArray(settings.reminderOffsetsMinutes) && settings.reminderOffsetsMinutes.length
    ? settings.reminderOffsetsMinutes
    : DEFAULT_SETTINGS.reminderOffsetsMinutes;
  const subject = env.VAPID_SUBJECT || "mailto:you@example.com";

  const terms = await getJSON(env.SCHOOL_KV, keys.terms(), []);
  const expiredEndpoints = new Set();

  for (const term of terms) {
    try {
      await sweepTerm({ env, term, offsets, vapidKeys, subject, subs, now, expiredEndpoints });
    } catch (e) {
      // One term's bad data (or a KV hiccup) should never block the rest.
      console.error(`Reminder sweep failed for term ${term?.id}:`, e);
    }
  }

  if (expiredEndpoints.size > 0) {
    try {
      subs = subs.filter((s) => !expiredEndpoints.has(s.endpoint));
      await putJSON(env.SCHOOL_KV, keys.pushSubs(), subs);
    } catch (e) {
      console.error("Failed to prune expired push subscriptions:", e);
    }
  }
}

async function sweepTerm({ env, term, offsets, vapidKeys, subject, subs, now, expiredEndpoints }) {
  const classesKey = keys.schedule(term.id);
  const classes = await getJSON(env.SCHOOL_KV, classesKey, []);
  const classTitleById = Object.fromEntries(classes.map((c) => [c.id, c.title]));

  const assignmentsKey = keys.assignments(term.id);
  const assignments = await getJSON(env.SCHOOL_KV, assignmentsKey, []);
  let changed = false;

  for (const a of assignments) {
    try {
      if (!a || a.status === "done") continue;
      const due = new Date(a.dueDate).getTime();
      if (Number.isNaN(due)) continue; // defensively skip any corrupt record rather than crash the sweep
      a.remindersSent = Array.isArray(a.remindersSent) ? a.remindersSent : [];
      const classLabel = a.classId && classTitleById[a.classId] ? `${classTitleById[a.classId]} — ` : "";

      // A snoozed assignment is fully suppressed until its wake time, then
      // gets one fresh nudge (independent of the normal offset schedule)
      // before falling back to normal handling on the next cycle.
      if (a.snoozedUntil) {
        const snoozeTime = new Date(a.snoozedUntil).getTime();
        if (!Number.isNaN(snoozeTime)) {
          if (now < snoozeTime) continue;
          if (!a.remindersSent.includes("snoozed")) {
            const body =
              due > now
                ? `${classLabel}${a.title} is due ${relativeLabel(a.dueDate, now)}.`
                : `${classLabel}${a.title} was due ${relativeLabel(a.dueDate, now)} ago.`;
            await broadcast(
              subs,
              { title: "Reminder", body, tag: `assignment-${a.id}-snoozed-${snoozeTime}`, data: { assignmentId: a.id, termId: term.id } },
              vapidKeys,
              subject,
              expiredEndpoints,
              `assignment ${a.id} (snooze wake-up)`
            );
            a.remindersSent.push("snoozed");
            a.snoozedUntil = null;
            changed = true;
          }
          continue; // don't also evaluate normal offset reminders in this same cycle
        }
      }

      const dueNotifications = [];
      for (const offsetMin of offsets) {
        if (a.remindersSent.includes(offsetMin)) continue;
        const triggerAt = due - offsetMin * 60000;
        if (now >= triggerAt && now < due) dueNotifications.push({ key: offsetMin });
      }
      if (now >= due && !a.remindersSent.includes("overdue")) {
        dueNotifications.push({ key: "overdue" });
      }

      for (const notif of dueNotifications) {
        const body =
          notif.key === "overdue"
            ? `${classLabel}${a.title} was due ${relativeLabel(a.dueDate, now)} ago.`
            : `${classLabel}${a.title} is due ${relativeLabel(a.dueDate, now)}.`;

        await broadcast(
          subs,
          {
            title: notif.key === "overdue" ? "Overdue assignment" : "Assignment due soon",
            body,
            tag: `assignment-${a.id}-${notif.key}`,
            data: { assignmentId: a.id, termId: term.id, snoozable: true },
          },
          vapidKeys,
          subject,
          expiredEndpoints,
          `assignment ${a.id}`
        );
        a.remindersSent.push(notif.key);
        changed = true;
      }
    } catch (e) {
      console.error(`Reminder sweep failed for assignment ${a?.id}:`, e);
    }
  }

  if (changed) await putJSON(env.SCHOOL_KV, assignmentsKey, assignments);
}
