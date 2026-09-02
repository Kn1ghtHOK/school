// Small, dependency-free validation helpers shared by route handlers.
// The goal: reject genuinely bad input with a clear 400 rather than
// either crashing (uncaught exception -> 500) or silently storing
// something malformed that breaks rendering or the reminder sweep later.

export const PRIORITIES = ["low", "medium", "high"];
export const MAX_TITLE_LEN = 300;
export const MAX_TEXT_LEN = 20000; // notes / free text fields

// HH:MM, 24-hour. Shared by the bell-schedule and period-times routes.
export const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Fixed palette — classes pick a token name, never a raw hex value, so the
// look stays coherent in both themes (the CSS maps each to a bg + fg pair).
export const CLASS_COLORS = [
  "class-1", "class-2", "class-3", "class-4", "class-5",
  "class-6", "class-7", "class-8", "class-9", "class-10",
];

// Non-class bell-schedule blocks. A slot with no kind is treated as "class".
export const SLOT_KINDS = ["class", "lunch", "win", "advisory", "break", "activity"];

export function isValidDate(value) {
  if (!value) return false;
  const t = new Date(value).getTime();
  return Number.isFinite(t);
}

/**
 * Resolve a class color. Returns a valid token, or — when none was supplied —
 * the lowest-numbered token not already in `used`, cycling once the palette
 * is exhausted. Returns false if a value was given but isn't a known token.
 */
export function normalizeClassColor(value, used = []) {
  if (value === undefined || value === null || value === "") {
    const free = CLASS_COLORS.find((c) => !used.includes(c));
    return free || CLASS_COLORS[used.length % CLASS_COLORS.length];
  }
  return CLASS_COLORS.includes(value) ? value : false;
}

/**
 * Validate/clean a class's links array. Returns a cleaned array, or false if
 * the shape is wrong or a URL doesn't validate. `undefined` in → `undefined`
 * out (field untouched).
 */
export function normalizeLinks(value) {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value)) return false;
  if (value.length > 12) return false;
  const cleaned = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return false;
    const url = normalizeUrl(raw.url);
    if (!url) return false; // false (bad) or null (empty) are both rejected here
    cleaned.push({ label: clampText(raw.label, 40).trim() || url, url });
  }
  return cleaned;
}

/** Validate a { "<label>": { start, end } } period-times map. Returns cleaned map or an error string. */
export function normalizePeriodTimes(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return "periodTimes must be an object.";
  const out = {};
  for (const [label, times] of Object.entries(value)) {
    const key = String(label).trim();
    if (!key) continue;
    if (key.length > 20) return `Period label "${key}" is too long (20 characters max).`;
    if (!times || !TIME_RE.test(times.start) || !TIME_RE.test(times.end)) {
      return `Period "${key}" needs valid HH:MM start and end times.`;
    }
    if (times.start >= times.end) return `Period "${key}" must end after it starts.`;
    out[key] = { start: times.start, end: times.end };
  }
  return out;
}

/** Returns a valid priority, or null if one was supplied but isn't recognized. */
export function normalizePriority(value, fallback = "medium") {
  if (value === undefined || value === null || value === "") return fallback;
  return PRIORITIES.includes(value) ? value : null;
}

export function clampText(value, max = MAX_TEXT_LEN) {
  const str = String(value ?? "");
  return str.length > max ? str.slice(0, max) : str;
}

const MAX_ESTIMATE_MINUTES = 1000; // ~16 hours — generous ceiling, catches fat-finger typos

/** Returns a valid minutes value, null (cleared), or undefined (field wasn't touched at all). */
export function normalizeEstimateMinutes(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_ESTIMATE_MINUTES) return false; // signals "invalid"
  return Math.round(n);
}

/** Loosely validates a URL, adding an https:// scheme if one was left off. Returns null if empty/absent. */
export function normalizeUrl(value) {
  const str = String(value ?? "").trim();
  if (!str) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(str) ? str : `https://${str}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.toString();
  } catch {
    return false;
  }
}
