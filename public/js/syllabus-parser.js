// Heuristic syllabus-paste parser.
// Takes raw pasted text and returns candidate rows: { date, time, type, title, raw }.
// Never auto-imports — the caller always shows these for the user to confirm/edit.
// This is intentionally simple regex/keyword matching, not NLP: it will miss
// unusual formats, and that's fine because everything is reviewed before saving.
import { MONTHS, MONTH_DAY_RE, SLASH_DATE_RE, TIME_RE, parseTimeMatch, resolveYear } from "./date-parse.js";

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
      ({ hour, minute } = parseTimeMatch(tm));
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
