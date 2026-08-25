import { json, readJSON } from "../lib/http.js";
import { getJSON, putJSON, keys, DEFAULT_SETTINGS } from "../lib/store.js";
import { summarizeHistory } from "../lib/points.js";

export async function pointsSummary(request, env) {
  const points = await getJSON(env.SCHOOL_KV, keys.points(), { history: [] });
  const summary = summarizeHistory(points.history);
  return json({ ...summary, recent: points.history.slice(-10).reverse() });
}

export async function getSettings(request, env) {
  const settings = await getJSON(env.SCHOOL_KV, keys.settings(), DEFAULT_SETTINGS);
  return json({ settings: { ...DEFAULT_SETTINGS, ...settings } });
}

export async function putSettings(request, env) {
  const body = await readJSON(request);
  const current = await getJSON(env.SCHOOL_KV, keys.settings(), DEFAULT_SETTINGS);
  const next = { ...current, ...body };
  await putJSON(env.SCHOOL_KV, keys.settings(), next);
  return json({ settings: next });
}
