import { json, err, readJSON } from "../lib/http.js";
import { getJSON, putJSON, keys } from "../lib/store.js";
import { normalizePeriodTimes } from "../lib/validate.js";

// Term-level default start/end for each period label:
//   { "1": { start: "08:00", end: "08:50" }, "WIN": { ... } }
// The bell-schedule editor pre-fills a period's times from here so they're
// entered once, not re-typed on every weekday the period meets.

export async function get(request, env, termId) {
  const periodTimes = await getJSON(env.SCHOOL_KV, keys.periodTimes(termId), {});
  return json({ periodTimes });
}

export async function put(request, env, termId) {
  const body = await readJSON(request);
  const result = normalizePeriodTimes(body.periodTimes);
  if (typeof result === "string") return err(result, 400);
  await putJSON(env.SCHOOL_KV, keys.periodTimes(termId), result);
  return json({ periodTimes: result });
}
