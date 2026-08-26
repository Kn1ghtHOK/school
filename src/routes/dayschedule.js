import { json, err, readJSON } from "../lib/http.js";
import { getJSON, putJSON, keys } from "../lib/store.js";

// Keyed "0".."6" (JS weekday: 0=Sun..6=Sat). Each value is either null
// ("no school that day") or an ordered array of { period, start, end }
// describing that weekday's bell schedule — e.g. Wednesday might only
// have periods WIN/2/4/6 starting later than a normal day.

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export async function get(request, env, termId) {
  const daySchedule = await getJSON(env.SCHOOL_KV, keys.daySchedule(termId), {});
  return json({ daySchedule });
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
  for (const p of body.periods) {
    if (!p.period || !String(p.period).trim()) return err("Each period needs a label.", 400);
    if (!TIME_RE.test(p.start) || !TIME_RE.test(p.end)) {
      return err(`Each period needs valid start/end times (got "${p.start}"–"${p.end}").`, 400);
    }
  }

  const cleaned = body.periods.map((p) => ({ period: String(p.period).trim(), start: p.start, end: p.end }));
  const daySchedule = await getJSON(env.SCHOOL_KV, keys.daySchedule(termId), {});
  daySchedule[String(wd)] = cleaned;
  await putJSON(env.SCHOOL_KV, keys.daySchedule(termId), daySchedule);
  return json({ daySchedule });
}
