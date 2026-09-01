// Shared date/time parsing helpers. Intentionally simple regex matching,
// not a full NLP library — good enough for a personal planner where the
// user can always fall back to picking a date manually.

export const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const WEEKDAYS = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};
const WEEKDAY_RE = /\b(next\s+)?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/i;

// "Jan 15", "January 15th", "Jan. 15, 2026"
export const MONTH_DAY_RE =
  /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i;

// "1/15", "1/15/26", "01/15/2026"
export const SLASH_DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;

// "3:00 pm", "15:00", "11:59pm" (colon form, am/pm optional — 24h implied without it)
// or "5pm", "10 am" (bare-hour form, am/pm required since a lone number is too ambiguous)
export const TIME_RE = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b/i;

export function parseTimeMatch(match) {
  const isColonForm = match[1] !== undefined;
  let hour = parseInt(isColonForm ? match[1] : match[4], 10);
  const minute = isColonForm ? parseInt(match[2], 10) : 0;
  const ampm = (isColonForm ? match[3] : match[5] || "").toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  return { hour, minute };
}

/**
 * Pick a year for a month/day pair given a term's date range, so
 * "Sep 3" resolves correctly for a term that spans e.g. Aug 2026–May 2027.
 * Falls back to `now`'s year if no term range is given.
 */
export function resolveYear(month, day, termStart, termEnd, now = new Date()) {
  if (!termStart || !termEnd) return now.getFullYear();
  const start = new Date(termStart);
  const end = new Date(termEnd);
  for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
    const candidate = new Date(y, month, day);
    if (candidate >= start && candidate <= new Date(end.getTime() + 24 * 60 * 60 * 1000)) {
      return y;
    }
  }
  return start.getFullYear();
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Finds a natural-language date (and optional time) reference anywhere in
 * free text. Supports: "today"/"tonight", "tomorrow", weekday names
 * (optionally prefixed with "next"), "in N day(s)/week(s)", explicit
 * month/day, and slash dates — plus a clock time anywhere in the string.
 *
 * @param {string} text
 * @param {{now?: Date, term?: {startDate?: string, endDate?: string}}} [opts]
 * @returns {{date: Date, matchedText: string, hasExplicitTime: boolean} | null}
 */
export function parseNaturalDueDate(text, { now = new Date(), term } = {}) {
  const lower = text.toLowerCase();
  let dateBase = null;
  let matchedText = "";
  let isTonight = false;

  let m = lower.match(/\bin\s+(\d+)\s+(day|days|week|weeks)\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unitDays = m[2].startsWith("week") ? 7 : 1;
    dateBase = startOfDay(new Date(now.getTime() + n * unitDays * 86400000));
    matchedText = m[0];
  }

  if (!dateBase) {
    m = text.match(MONTH_DAY_RE);
    if (m) {
      const month = MONTHS[m[1].toLowerCase()];
      const day = parseInt(m[2], 10);
      const year = m[3] ? parseInt(m[3], 10) : resolveYear(month, day, term?.startDate, term?.endDate, now);
      const candidate = new Date(year, month, day);
      if (!Number.isNaN(candidate.getTime())) {
        dateBase = candidate;
        matchedText = m[0];
      }
    }
  }

  if (!dateBase) {
    m = text.match(SLASH_DATE_RE);
    if (m) {
      const month = parseInt(m[1], 10) - 1;
      const day = parseInt(m[2], 10);
      const year = m[3]
        ? (m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10))
        : resolveYear(month, day, term?.startDate, term?.endDate, now);
      const candidate = new Date(year, month, day);
      if (!Number.isNaN(candidate.getTime())) {
        dateBase = candidate;
        matchedText = m[0];
      }
    }
  }

  if (!dateBase) {
    m = lower.match(WEEKDAY_RE);
    if (m) {
      const targetDow = WEEKDAYS[m[2]];
      const isNext = Boolean(m[1]);
      const today = now.getDay();
      let delta = (targetDow - today + 7) % 7;
      if (isNext) delta += 7;
      dateBase = startOfDay(new Date(now.getTime() + delta * 86400000));
      matchedText = m[0];
    }
  }

  if (!dateBase) {
    m = lower.match(/\btomorrow\b/);
    if (m) {
      dateBase = startOfDay(new Date(now.getTime() + 86400000));
      matchedText = m[0];
    }
  }

  if (!dateBase) {
    m = lower.match(/\b(today|tonight)\b/);
    if (m) {
      dateBase = startOfDay(now);
      matchedText = m[0];
      isTonight = m[1] === "tonight";
    }
  }

  if (!dateBase) return null;

  const tm = text.match(TIME_RE);
  let hour = 23, minute = 59;
  if (tm) {
    ({ hour, minute } = parseTimeMatch(tm));
  } else if (isTonight) {
    hour = 20;
    minute = 0;
  }

  const date = new Date(dateBase.getFullYear(), dateBase.getMonth(), dateBase.getDate(), hour, minute);
  return {
    date,
    matchedText: tm ? `${matchedText} ${tm[0]}` : matchedText,
    hasExplicitTime: Boolean(tm),
  };
}
