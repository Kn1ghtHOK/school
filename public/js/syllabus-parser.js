// Heuristic syllabus-paste parser.
// Takes raw pasted text and returns candidate rows: { date, time, type, title, raw }.
// Never auto-imports — the caller always shows these for the user to confirm/edit.
// This is intentionally simple regex/keyword matching, not NLP: it will miss
// unusual formats, and that's fine because everything is reviewed before saving.

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

// "Jan 15", "January 15th", "Jan. 15, 2026"
const MONTH_DAY_RE =
  /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i;

// "1/15", "1/15/26", "01/15/2026"
const SLASH_DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;

// "3:00 pm", "15:00", "11:59pm"
const TIME_RE = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i;

const TYPE_KEYWORDS = [
  { re: /\b(final exam|final)\b/i, type: "exam" },
  { re: /\b(midterm|exam|test)\b/i, type: "exam" },
  { re: /\bquiz\b/i, type: "quiz" },
  { re: /\b(project|presentation)\b/i, type: "project" },
  { re: /\b(paper|essay|report)\b/i, type: "paper" },
  { re: /\b(reading|read ch|chapter)\b/i, type: "reading" },
  { re: /\b(due|submit|deadline|homework|hw|assignment|worksheet|lab)\b/i, type: "assignment" },
];

const NOISE_RE = /\b(no class|cancell?ed|holiday|break|office hours?)\b/i;

function guessType(line) {
  for (const { re, type } of TYPE_KEYWORDS) {
    if (re.test(line)) return type;
  }
  return null;
}

function cleanTitle(line, dateMatchText, timeMatchText) {
  let t = line;
  if (dateMatchText) t = t.replace(dateMatchText, " ");
  if (timeMatchText) t = t.replace(timeMatchText, " ");
  t = t.replace(/^[\s\-–—:.,]+|[\s\-–—:.,]+$/g, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t || "(untitled)";
}

/**
 * Pick a year for a month/day pair given a term's date range, so
 * "Sep 3" resolves correctly for a term that spans e.g. Aug 2026–May 2027.
 */
function resolveYear(month, day, termStart, termEnd) {
  if (!termStart || !termEnd) return new Date().getFullYear();
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

/**
 * @param {string} text - raw pasted syllabus text
 * @param {{startDate?: string, endDate?: string}} term - used to infer missing years
 * @returns {Array<{date: string, time: string, type: string, title: string, raw: string}>}
 */
export function parseSyllabusText(text, term = {}) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const results = [];

  for (const line of lines) {
    let year, month, day, dateMatchText;

    const md = line.match(MONTH_DAY_RE);
    if (md) {
      month = MONTHS[md[1].toLowerCase()];
      day = parseInt(md[2], 10);
      year = md[3] ? parseInt(md[3], 10) : resolveYear(month, day, term.startDate, term.endDate);
      dateMatchText = md[0];
    } else {
      const sd = line.match(SLASH_DATE_RE);
      if (sd) {
        month = parseInt(sd[1], 10) - 1;
        day = parseInt(sd[2], 10);
        if (sd[3]) {
          year = sd[3].length === 2 ? 2000 + parseInt(sd[3], 10) : parseInt(sd[3], 10);
        } else {
          year = resolveYear(month, day, term.startDate, term.endDate);
        }
        dateMatchText = sd[0];
      }
    }

    if (month === undefined || Number.isNaN(day) || day < 1 || day > 31) continue;

    const explicitType = guessType(line);
    if (!explicitType && NOISE_RE.test(line)) continue; // e.g. "No class Oct 15 (break)"

    const tm = line.match(TIME_RE);
    let hour = 23, minute = 59;
    if (tm) {
      hour = parseInt(tm[1], 10);
      minute = parseInt(tm[2], 10);
      const ampm = (tm[3] || "").toLowerCase();
      if (ampm === "pm" && hour < 12) hour += 12;
      if (ampm === "am" && hour === 12) hour = 0;
    }

    const dateObj = new Date(year, month, day, hour, minute);
    if (Number.isNaN(dateObj.getTime())) continue;

    results.push({
      date: dateObj.toISOString(),
      hasExplicitTime: Boolean(tm),
      type: explicitType || "assignment",
      title: cleanTitle(line, dateMatchText, tm ? tm[0] : ""),
      raw: line,
    });
  }

  return results;
}
