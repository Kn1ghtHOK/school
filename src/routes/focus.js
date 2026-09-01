import { json, err, readJSON } from "../lib/http.js";
import { getJSON, putJSON, keys } from "../lib/store.js";

const MAX_FOCUS_MINUTES = 180; // 3 hours — a hard ceiling so a bad value can
// never silently pause reminder delivery indefinitely.

export async function get(request, env) {
  const focus = await getJSON(env.SCHOOL_KV, keys.focus(), { until: null });
  if (focus.until && focus.until < Date.now()) focus.until = null;
  return json({ focus });
}

export async function start(request, env) {
  const body = await readJSON(request);
  const raw = Number(body.minutes);
  if (!Number.isFinite(raw) || raw <= 0) return err("minutes must be a positive number.", 400);
  const minutes = Math.min(raw, MAX_FOCUS_MINUTES);
  const until = Date.now() + minutes * 60 * 1000;
  await putJSON(env.SCHOOL_KV, keys.focus(), { until });
  return json({ focus: { until } });
}

export async function stop(request, env) {
  await putJSON(env.SCHOOL_KV, keys.focus(), { until: null });
  return json({ focus: { until: null } });
}
