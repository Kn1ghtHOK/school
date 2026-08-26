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
  assignments: (termId) => `assignments:${termId}`,
  notes: (classId) => `notes:${classId}`,
  pushSubs: () => "pushSubs",
  focus: () => "focus",
  points: () => "points",
  settings: () => "settings",
};

export const DEFAULT_SETTINGS = {
  reminderOffsetsMinutes: [1440, 60], // 1 day before, 1 hour before
  theme: "system",
};
