import { json, readJSON } from "../lib/http.js";
import { getJSON, putJSON, keys } from "../lib/store.js";

export async function get(request, env) {
  const focus = await getJSON(env.SCHOOL_KV, keys.focus(), { until: null });
  if (focus.until && focus.until < Date.now()) focus.until = null;
  return json({ focus });
}

export async function start(request, env) {
  const body = await readJSON(request);
  const minutes = Number(body.minutes) || 25;
  const until = Date.now() + minutes * 60 * 1000;
  await putJSON(env.SCHOOL_KV, keys.focus(), { until });
  return json({ focus: { until } });
}

export async function stop(request, env) {
  await putJSON(env.SCHOOL_KV, keys.focus(), { until: null });
  return json({ focus: { until: null } });
}
