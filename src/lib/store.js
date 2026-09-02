// Thin helpers over Workers KV. This is a single-user app, so keys are
// fixed names (or fixed-name-per-term), not per-account namespaces.

export async function getJSON(kv, key, fallback) {
  const raw = await kv.get(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function putJSON(kv, key, value) {
  await kv.put(key, JSON.stringify(value));
}

export function newId() {
  return crypto.randomUUID();
}

// --- Key builders -----------------------------------------------------
export const keys = {
  config: () => "config",
  terms: () => "terms",
  activeTermId: () => "activeTermId",
  schedule: (termId) => `schedule:${termId}`,
  daySchedule: (termId) => `dayschedule:${termId}`,
  // Term-level default start/end for each period label, so a period's time
  // is entered once rather than re-typed on every weekday it meets.
  periodTimes: (termId) => `periodtimes:${termId}`,
  assignments: (termId) => `assignments:${termId}`,
  notes: (classId) => `notes:${classId}`,
  pushSubs: () => "pushSubs",
  focus: () => "focus",
  points: () => "points",
  settings: () => "settings",
  todos: () => "todos",
};

export const DEFAULT_SETTINGS = {
  reminderOffsetsMinutes: [1440, 60], // 1 day before, 1 hour before
  theme: "system",
  // A gap shorter than this between two slots is a passing period (shown as
  // a thin strip, not offered as a focus-timer slot). Longer gaps stay
  // "free periods".
  passingPeriodMaxMinutes: 15,
  // How the Assignments list is ordered: "due" | "priority" | "class".
  assignmentSort: "due",
  // Optional bring-your-own natural-language assist. null, or
  // { url: "https://…", key?: "…" } — called only when the offline parser
  // is unsure. No model weights ship with the app.
  nlAssist: null,
};
