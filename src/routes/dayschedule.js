import { json, err, readJSON } from "../lib/http.js";
import { getJSON, putJSON, keys } from "../lib/store.js";
import { TIME_RE, SLOT_KINDS, clampText } from "../lib/validate.js";

// Keyed "0".."6" (JS weekday: 0=Sun..6=Sat). Each value is either null
// ("no school that day") or an ordered array of
// { period, start, end, kind, label } describing that weekday's bell
// schedule — e.g. Wednesday might only have periods WIN/2/4/6 starting
// later than a normal day.
//
// `kind` is one of SLOT_KINDS; a slot with no kind is a normal "class"
// slot (matched to a class by its `period` label). Non-class slots
// (lunch, WIN, advisory, …) carry a display `label` and don't need a
// unique period label.

const MAX_LABEL_LEN = 40;

export async function get(request, env, termId) {
  const [daySchedule, periodTimes] = await Promise.all([
    getJSON(env.SCHOOL_KV, keys.daySchedule(termId), {}),
    getJSON(env.SCHOOL_KV, keys.periodTimes(termId), {}),
  ]);
  return json({ daySchedule, periodTimes });
}

export async function setDay(request, env, termId, weekday) {
  const wd = Number(weekday);
  if (!Number.isInteger(wd) || wd < 0 || wd > 6) return err("weekday must be 0-6.", 400);

  const body = await readJSON(request);

  if (body.periods === null) {
    const daySchedule = await getJSON(env.SCHOOL_KV, keys.daySchedule(termId), {});
    daySchedule[String(wd)] = null;
    await putJSON(env.SCHOOL_KV, keys.daySchedule(termId), daySchedule);
    return json({ daySchedule });
  }

  if (!Array.isArray(body.periods) || body.periods.length === 0) {
    return err("periods must be a non-empty array, or null for no school.", 400);
  }

  const seenClassLabels = new Set();
  const cleaned = [];
  let synthCounter = 0;

  for (const p of body.periods) {
    const kind = p.kind === undefined || p.kind === null || p.kind === "" ? "class" : p.kind;
    if (!SLOT_KINDS.includes(kind)) {
      return err(`Unknown block type "${kind}".`, 400);
    }

    let label = String(p.period ?? "").trim();
    if (kind === "class") {
      if (!label) return err("Each class period needs a label.", 400);
      if (label.length > 20) return err("Period labels should be short (20 characters or fewer).", 400);
      if (seenClassLabels.has(label)) {
        return err(`Period "${label}" is listed more than once for this day.`, 400);
      }
      seenClassLabels.add(label);
    } else if (!label) {
      // Non-class blocks don't require a period label — give them a stable
      // synthetic key so the client can still address the row.
      label = `_${kind}${synthCounter++}`;
    }

    if (!TIME_RE.test(p.start) || !TIME_RE.test(p.end)) {
      return err(`Each block needs valid start/end times (got "${p.start}"–"${p.end}").`, 400);
    }
    if (p.start >= p.end) {
      return err(`Block "${clampText(p.label, MAX_LABEL_LEN).trim() || label}" must end after it starts.`, 400);
    }

    const slot = { period: label, start: p.start, end: p.end, kind };
    if (kind !== "class") slot.label = clampText(p.label, MAX_LABEL_LEN).trim() || defaultLabel(kind);
    cleaned.push(slot);
  }

  cleaned.sort((a, b) => a.start.localeCompare(b.start));

  const daySchedule = await getJSON(env.SCHOOL_KV, keys.daySchedule(termId), {});
  daySchedule[String(wd)] = cleaned;
  await putJSON(env.SCHOOL_KV, keys.daySchedule(termId), daySchedule);
  return json({ daySchedule });
}

function defaultLabel(kind) {
  return { lunch: "Lunch", win: "WIN", advisory: "Advisory", break: "Break", activity: "Activity" }[kind] || "Block";
}
