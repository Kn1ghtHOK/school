// Small, dependency-free validation helpers shared by route handlers.
// The goal: reject genuinely bad input with a clear 400 rather than
// either crashing (uncaught exception -> 500) or silently storing
// something malformed that breaks rendering or the reminder sweep later.

export const PRIORITIES = ["low", "medium", "high"];
export const MAX_TITLE_LEN = 300;
export const MAX_TEXT_LEN = 20000; // notes / free text fields

export function isValidDate(value) {
  if (!value) return false;
  const t = new Date(value).getTime();
  return Number.isFinite(t);
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
