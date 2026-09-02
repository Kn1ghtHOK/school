// ===========================================================
// Universal natural-language capture.
//
// Turns one line of text into a draft for ONE of:
//   - assignment  ("essay for bio due friday 5pm !", "read ch 4 tomorrow ~2h")
//   - todo        ("bring goggles", "return the field trip form")
//   - class       ("AP Bio p3 with Dr. Lee in room 214")
//
// Same spirit as date-parse.js: deliberate regex/keyword matching, not NLP.
// It never has to be perfect — a low-confidence result just means the app
// opens the matching sheet pre-filled instead of creating something outright.
//
// Pure and dependency-free apart from the date primitive it builds on.
// ===========================================================
import { parseNaturalDueDate } from "./date-parse.js";

const MAX_ESTIMATE_MINUTES = 1000; // keep in step with src/lib/validate.js

// Verbs that, with no date in the text, mean "personal errand" rather than schoolwork.
const TODO_VERBS =
  /^(buy|bring|pack|grab|get|pick up|drop off|return|print|email|text|call|ask|charge|wash|fill out|sign|find|order|book|renew|refill|water|feed|clean|register|rsvp)\b/i;

const ASSIGNMENT_NOUNS =
  /\b(essay|paper|report|draft|quiz|test|exam|midterm|final|hw|homework|assignment|worksheet|problem set|pset|lab|reading|read|chapter|ch\.?\s*\d|project|presentation|slides|deck|study|review|outline|thesis|proposal|annotation|response)\b/i;

const CLASS_INTENT = /^\s*(?:add|new|create)\s+class\b/i;

// ---- little helpers ------------------------------------------------

function stripSpans(text, spans) {
  let out = text;
  for (const s of spans) {
    if (s) out = out.split(s).join(" ");
  }
  return out;
}

function tidy(s) {
  return String(s || "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–—:,.]+|[\s\-–—:,.]+$/g, "")
    .trim();
}

function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip connective words ("due", "for", "in", "by"…) left dangling at either end after spans are removed. */
function stripEdgeWords(s) {
  let prev;
  do {
    prev = s;
    s = tidy(s)
      .replace(/^(due on|due by|is due|due|for|to)\b[:,\-\s]*/i, "")
      .replace(/[:,\-\s]*\b(due on|due by|due|for|in|on|by|to|with)$/i, "");
  } while (s !== prev);
  return s;
}

// ---- field extractors -------------------------------------------------

/** { minutes, span } or null — "~2h", "90 min", "takes 1.5 hours", "(45m)" */
function extractEffort(text) {
  const m = text.match(/(?:~|takes\s+|about\s+|approx\.?\s+|est\.?\s+)?\(?\b(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b\)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const isHours = /^h/i.test(m[2]);
  const minutes = Math.round(isHours ? n * 60 : n);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_ESTIMATE_MINUTES) return null;
  return { minutes, span: m[0] };
}

/** { priority, span } — "!", "urgent", "asap", "high/low priority", "whenever" */
function extractPriority(text) {
  if (/\b(low priority|no rush|whenever|someday|eventually)\b/i.test(text)) {
    return { priority: "low", span: (text.match(/\b(low priority|no rush|whenever|someday|eventually)\b/i) || [])[0] };
  }
  const hi = text.match(/(\s!{1,3}$|\s!{1,3}\s|\b(urgent|asap|important|high priority|priority)\b)/i);
  if (hi) return { priority: "high", span: hi[0] };
  return { priority: "medium", span: null };
}

/** { url, span } or null — a bare or full URL anywhere in the text */
function extractLink(text) {
  const m =
    text.match(/\bhttps?:\/\/\S+/i) ||
    text.match(/\b(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+\.(?:com|org|edu|net|io|gov|co|app|dev)(?:\/\S*)?/i);
  if (!m) return null;
  return { url: m[0], span: m[0] };
}

/** { repeat: {weekly, until, weekday}, span } or null */
function extractRecurrence(text, ctx) {
  const m = text.match(/\b(every|each)\s+(week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\bweekly\b/i);
  if (!m) return null;
  let untilSpan = null;
  let until = null;
  const u = text.match(/\b(?:until|through|thru|till)\s+(.+)$/i);
  if (u) {
    const parsedUntil = parseNaturalDueDate(u[1], { now: ctx.now, term: ctx.term });
    if (parsedUntil) {
      until = parsedUntil.date;
      untilSpan = u[0];
    }
  }
  return { repeat: { weekly: true }, until, span: [m[0], untilSpan].filter(Boolean).join(" ") };
}

// words that mark the end of a "for <class>" phrase
const CLASS_PHRASE_STOP =
  /\b(due|by|on|at|tomorrow|today|tonight|tmrw|next|this|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|every|weekly|~|asap|urgent)\b|[!.]|\d/i;

/**
 * Fuzzy-match a class from `ctx.classes` by name mentioned in the text.
 * Tries an explicit "for/in <name>" phrase, then any class title as a
 * word-substring, then the class's first word, then an initials acronym.
 * Returns { classId, span } or null.
 */
function extractClassRef(text, ctx) {
  const classes = ctx.classes || [];
  if (!classes.length) return null;
  const lower = text.toLowerCase();

  // "for <name>" / "in <name>" — grab the words after it, up to a stop word.
  let needle = "";
  let phraseSpan = "";
  const pm = text.match(/\b(?:for|in)\s+([A-Za-z0-9][A-Za-z0-9 .&/-]*)/i);
  if (pm) {
    let tail = pm[1];
    const stop = tail.search(CLASS_PHRASE_STOP);
    if (stop > 0) tail = tail.slice(0, stop);
    needle = tail.trim().toLowerCase().replace(/\s+/g, " ");
    if (needle) phraseSpan = text.slice(pm.index, pm.index + pm[0].indexOf(pm[1]) + tail.length).trim();
  }

  const withPrepSpan = (title) => {
    const wp = text.match(new RegExp("\\b(?:for|in)\\s+" + escapeRe(title), "i"));
    return wp ? wp[0] : title;
  };

  // 1) explicit phrase — exact / prefix / containment against a class title,
  //    preferring the longest title match so "AP US History" wins over "AP Biology"
  if (needle) {
    const scored = classes
      .map((c) => {
        const t = (c.title || "").toLowerCase();
        const ok = t === needle || t.startsWith(needle) || needle.startsWith(t) || t.includes(needle) || (t.split(" ")[0].length >= 4 && needle.includes(t.split(" ")[0]));
        return ok ? { c, len: t.length } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.len - a.len);
    if (scored.length) return { classId: scored[0].c.id, span: phraseSpan || withPrepSpan(scored[0].c.title) };
  }

  // 2) whole class title appears verbatim
  for (const c of classes) {
    const t = (c.title || "").toLowerCase().trim();
    if (t && lower.includes(t)) return { classId: c.id, span: withPrepSpan(c.title) };
  }

  // 3) the class's first word, if distinctive (≥4 chars), as a standalone word
  for (const c of classes) {
    const first = (c.title || "").toLowerCase().trim().split(/\s+/)[0];
    if (first && first.length >= 4 && new RegExp("\\b" + escapeRe(first) + "\\b", "i").test(text)) {
      return { classId: c.id, span: withPrepSpan(first) };
    }
  }

  // 4) initials acronym, keeping short all-caps words whole ("AP US History" → "APUSH")
  for (const c of classes) {
    const t = (c.title || "").toLowerCase().trim();
    const initials = t
      .split(/\s+/)
      .map((w) => (w.length <= 2 ? w : w[0]))
      .join("");
    if (initials.length >= 3 && lower.replace(/[^a-z0-9]/g, "").includes(initials)) {
      return { classId: c.id, span: (text.match(new RegExp("\\b" + escapeRe(initials) + "\\b", "i")) || [initials])[0] };
    }
  }
  return null;
}

/** class-shape fields: { period, instructor, location, spans[] } */
function extractClassFields(text) {
  const spans = [];
  let period = "";
  let instructor = "";
  let location = "";

  let m = text.match(/\bperiod\s+([A-Za-z0-9]{1,10})\b/i) || text.match(/\bper\s+([A-Za-z0-9]{1,10})\b/i) || text.match(/\bp(\d{1,2})\b/i);
  if (m) {
    period = m[1].toUpperCase();
    spans.push(m[0]);
  } else if ((m = text.match(/\b(WIN|advisory|flex|homeroom|seminar)\b/i))) {
    period = m[1].toUpperCase();
    spans.push(m[0]);
  }

  // honorific + name (case-insensitive), else "with <Capitalized name>"
  m = text.match(/\b(?:with|w\/)\s+((?:mr|mrs|ms|mx|dr|prof|professor|coach)\.?\s+[a-z][a-z'’-]+)/i);
  if (!m) m = text.match(/\b(?:with|w\/)\s+([A-Z][A-Za-z'’-]{2,})\b/);
  if (m) {
    instructor = titleCase(tidy(m[1]).toLowerCase());
    spans.push(m[0]);
  }

  m = text.match(/\b(?:room|rm|in|@)\s*#?\s*([A-Za-z]?-?\d{1,4}[A-Za-z]?)\b/i);
  if (m) {
    location = m[1].toUpperCase();
    spans.push(m[0]);
  }

  return { period, instructor, location, spans };
}

// ---- intent ---------------------------------------------------------

function looksLikeClass(text) {
  if (CLASS_INTENT.test(text)) return true;
  // An explicit "period 4" / "per WIN" is a strong class signal on its own —
  // assignments and to-dos don't talk that way.
  if (/\b(period|per)\s+[A-Za-z0-9]/i.test(text) && !ASSIGNMENT_NOUNS.test(text)) return true;
  const hasShortPeriod = /\bp\d{1,2}\b/i.test(text);
  const hasTeacher = /\b(with|w\/)\s+(mr|mrs|ms|mx|dr|prof|professor|coach)\b/i.test(text);
  const hasRoom = /\b(room|rm)\s*#?\s*\w/i.test(text);
  const signals = [hasShortPeriod, hasTeacher, hasRoom].filter(Boolean).length;
  return signals >= 2 || (/\bclass\b/i.test(text) && signals >= 1);
}

// ---- main ----------------------------------------------------------

/**
 * @param {string} text
 * @param {{now?: Date, term?: object, classes?: Array<{id,title,period}>}} [ctx]
 * @returns {{kind: "assignment"|"todo"|"class", draft: object, confidence: "high"|"low", matched: string, source?: string}}
 */
export function parse(text, ctx = {}) {
  const raw = String(text || "").trim();
  ctx = { now: new Date(), ...ctx };
  if (!raw) return { kind: "assignment", draft: { title: "" }, confidence: "low", matched: "" };

  const TODO_PREFIX = /^(todo|to-?do|reminder|remind me to)\b[:\-\s]+/i;

  // ---- explicit TODO prefix wins outright (even if it mentions a day) ----
  if (TODO_PREFIX.test(raw)) {
    const title = tidy(raw.replace(TODO_PREFIX, ""));
    return { kind: "todo", draft: { title }, confidence: title ? "high" : "low", matched: "" };
  }

  // ---- CLASS ----
  if (looksLikeClass(raw)) {
    const body = raw.replace(CLASS_INTENT, "").trim();
    const { period, instructor, location, spans } = extractClassFields(body);
    const title = stripEdgeWords(stripSpans(body, spans));
    const draft = { title, period, instructor, location };
    const complete = Boolean(title && period);
    return {
      kind: "class",
      draft,
      confidence: complete ? "high" : "low",
      matched: spans.join(" "),
    };
  }

  // ---- date drives assignment vs todo ----
  const parsedDate = parseNaturalDueDate(raw, { now: ctx.now, term: ctx.term });

  // ---- TODO (verb-shaped, no date) ----
  if (!parsedDate && TODO_VERBS.test(raw)) {
    return { kind: "todo", draft: { title: tidy(raw) }, confidence: "high", matched: "" };
  }

  // ---- ASSIGNMENT (default) ----
  const spans = [];
  const eff = extractEffort(raw);
  if (eff) spans.push(eff.span);
  const pri = extractPriority(raw);
  if (pri.span) spans.push(pri.span);
  const link = extractLink(raw);
  if (link) spans.push(link.span);
  const rec = extractRecurrence(raw, ctx);
  if (rec) spans.push(rec.span);
  const classRef = extractClassRef(raw, ctx);
  if (classRef) spans.push(classRef.span);
  if (parsedDate) spans.push(parsedDate.matchedText);

  let title = stripEdgeWords(stripSpans(raw, spans));
  if (!title) title = stripEdgeWords(stripSpans(raw, [parsedDate?.matchedText])) || tidy(raw);

  const draft = {
    title,
    dueDate: parsedDate ? parsedDate.date : null,
    priority: pri.priority,
    estimatedMinutes: eff ? eff.minutes : null,
    link: link ? link.url : null,
    classId: classRef ? classRef.classId : null,
  };
  if (rec) draft.repeat = { weekly: true, until: rec.until || null };

  return {
    kind: "assignment",
    draft,
    confidence: parsedDate && title ? "high" : "low",
    matched: spans.filter(Boolean).join(" "),
  };
}

/** One-line human summary of a parse result, for a live preview. */
export function describeDraft(result, ctx = {}) {
  const d = result.draft || {};
  if (result.kind === "todo") return d.title ? `To-do: “${d.title}”` : "To-do";
  if (result.kind === "class") {
    const bits = [d.period && `Period ${d.period}`, d.instructor, d.location && `Room ${d.location}`].filter(Boolean);
    return `New class${d.title ? ` “${d.title}”` : ""}${bits.length ? " · " + bits.join(" · ") : ""}`;
  }
  const bits = [];
  if (d.dueDate) {
    const dt = d.dueDate instanceof Date ? d.dueDate : new Date(d.dueDate);
    bits.push(
      "due " +
        dt.toLocaleDateString([], { month: "short", day: "numeric" }) +
        " " +
        dt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    );
  } else {
    bits.push("no date — will open the form");
  }
  if (d.priority && d.priority !== "medium") bits.push(`${d.priority} priority`);
  if (d.estimatedMinutes) bits.push(d.estimatedMinutes >= 60 ? `~${(d.estimatedMinutes / 60).toFixed(1)}h` : `~${d.estimatedMinutes}m`);
  if (d.classId && ctx.classes) {
    const c = ctx.classes.find((x) => x.id === d.classId);
    if (c) bits.push(c.title);
  }
  if (d.repeat) bits.push("weekly");
  return `New assignment${d.title ? ` “${d.title}”` : ""} · ${bits.join(" · ")}`;
}

/**
 * Optional bring-your-own assist. Only meaningful when the caller has a
 * user-configured endpoint (settings.nlAssist = { url, key? }). Never ships
 * with weights and is only worth calling when `parse()` returned low
 * confidence. Whatever it returns MUST be re-validated by the caller the
 * same way a manual form submission is.
 *
 * @returns {Promise<object|null>} a { kind, draft } shape, or null on any failure
 */
export async function parseWithAssist(text, ctx, nlAssist) {
  if (!nlAssist || !nlAssist.url) return null;
  try {
    const res = await fetch(nlAssist.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(nlAssist.key ? { Authorization: `Bearer ${nlAssist.key}` } : {}),
      },
      body: JSON.stringify({
        text,
        now: (ctx.now || new Date()).toISOString(),
        classes: (ctx.classes || []).map((c) => ({ id: c.id, title: c.title })),
        schema: "school-nl-v1", // { kind: assignment|todo|class, draft: {...} }
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !["assignment", "todo", "class"].includes(data.kind) || typeof data.draft !== "object") return null;
    return { kind: data.kind, draft: data.draft, confidence: "low", matched: "", source: "assist" };
  } catch {
    return null;
  }
}
