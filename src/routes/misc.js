import { json, err, readJSON } from "../lib/http.js";
import { getJSON, putJSON, keys, DEFAULT_SETTINGS } from "../lib/store.js";
import { summarizeHistory } from "../lib/points.js";

const THEMES = ["system", "dark", "light"];
const MAX_REMINDER_OFFSETS = 10;

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

  // These feed the reminder sweep directly — bad data here shouldn't be
  // able to silently break every future reminder, so validate up front
  // rather than relying on downstream defensive handling alone.
  if (body.reminderOffsetsMinutes !== undefined) {
    const offsets = body.reminderOffsetsMinutes;
    if (
      !Array.isArray(offsets) ||
      offsets.length === 0 ||
      offsets.length > MAX_REMINDER_OFFSETS ||
      !offsets.every((n) => Number.isFinite(n) && n > 0)
    ) {
      return err(`reminderOffsetsMinutes must be 1-${MAX_REMINDER_OFFSETS} positive numbers.`, 400);
    }
    next.reminderOffsetsMinutes = offsets;
  }

  if (body.theme !== undefined && !THEMES.includes(body.theme)) {
    return err(`theme must be one of: ${THEMES.join(", ")}.`, 400);
  }

  await putJSON(env.SCHOOL_KV, keys.settings(), next);
  return json({ settings: next });
}
