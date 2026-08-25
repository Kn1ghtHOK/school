import { getJSON, putJSON, keys, DEFAULT_SETTINGS } from "./lib/store.js";
import { sendWebPush } from "./lib/webpush.js";

function relativeLabel(dueDate, now) {
  const diffMin = Math.round((new Date(dueDate).getTime() - now) / 60000);
  if (diffMin <= 0) return "now";
  if (diffMin < 60) return `in ${diffMin} min`;
  if (diffMin < 24 * 60) return `in ${Math.round(diffMin / 60)} hr`;
  return `in ${Math.round(diffMin / (60 * 24))} days`;
}

export async function runReminderSweep(env) {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY) return; // push not configured yet

  const focus = await getJSON(env.SCHOOL_KV, keys.focus(), { until: null });
  const now = Date.now();
  if (focus.until && focus.until > now) return; // do-not-disturb during focus sessions

  let subs = await getJSON(env.SCHOOL_KV, keys.pushSubs(), []);
  if (subs.length === 0) return;

  const settings = await getJSON(env.SCHOOL_KV, keys.settings(), DEFAULT_SETTINGS);
  const offsets = settings.reminderOffsetsMinutes || DEFAULT_SETTINGS.reminderOffsetsMinutes;
  const vapidKeys = { privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), publicKeyB64url: env.VAPID_PUBLIC_KEY };
  const subject = env.VAPID_SUBJECT || "mailto:you@example.com";

  const terms = await getJSON(env.SCHOOL_KV, keys.terms(), []);
  const expiredEndpoints = new Set();

  for (const term of terms) {
    const classesKey = keys.schedule(term.id);
    const classes = await getJSON(env.SCHOOL_KV, classesKey, []);
    const classTitleById = Object.fromEntries(classes.map((c) => [c.id, c.title]));

    const assignmentsKey = keys.assignments(term.id);
    const assignments = await getJSON(env.SCHOOL_KV, assignmentsKey, []);
    let changed = false;

    for (const a of assignments) {
      if (a.status === "done") continue;
      const due = new Date(a.dueDate).getTime();
      a.remindersSent = a.remindersSent || [];

      const due_notifications = [];
      for (const offsetMin of offsets) {
        if (a.remindersSent.includes(offsetMin)) continue;
        const triggerAt = due - offsetMin * 60000;
        if (now >= triggerAt && now < due) due_notifications.push({ key: offsetMin, offsetMin });
      }
      // One-time overdue nudge, separate from the configured offsets.
      if (now >= due && !a.remindersSent.includes("overdue")) {
        due_notifications.push({ key: "overdue", offsetMin: null });
      }

      for (const notif of due_notifications) {
        const classLabel = a.classId && classTitleById[a.classId] ? `${classTitleById[a.classId]} — ` : "";
        const body =
          notif.key === "overdue"
            ? `${classLabel}${a.title} was due ${relativeLabel(a.dueDate, now)} ago.`
            : `${classLabel}${a.title} is due ${relativeLabel(a.dueDate, now)}.`;

        for (const sub of subs) {
          const result = await sendWebPush(
            sub,
            {
              title: notif.key === "overdue" ? "Overdue assignment" : "Assignment due soon",
              body,
              tag: `assignment-${a.id}-${notif.key}`,
              data: { assignmentId: a.id, termId: term.id },
            },
            vapidKeys,
            subject
          );
          if (result.expired) expiredEndpoints.add(sub.endpoint);
        }
        a.remindersSent.push(notif.key);
        changed = true;
      }
    }

    if (changed) await putJSON(env.SCHOOL_KV, assignmentsKey, assignments);
  }

  if (expiredEndpoints.size > 0) {
    subs = subs.filter((s) => !expiredEndpoints.has(s.endpoint));
    await putJSON(env.SCHOOL_KV, keys.pushSubs(), subs);
  }
}
