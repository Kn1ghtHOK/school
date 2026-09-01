import { parseNaturalDueDate } from '../public/js/date-parse.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', msg); }
}

function fmt(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Fixed reference point: Monday, September 7, 2026, 10:00 AM local time.
const NOW = new Date(2026, 8, 7, 10, 0);
assert(NOW.getDay() === 1, 'sanity check: reference date is actually a Monday');

function check(text, expected, label) {
  const r = parseNaturalDueDate(text, { now: NOW });
  assert(r !== null, `${label}: found a match`);
  if (r) assert(fmt(r.date) === expected, `${label}: expected ${expected}, got ${fmt(r.date)}`);
}

// ---- Relative day words ----
check('Essay due today', '2026-09-07 23:59', 'today (default 11:59pm)');
check('Essay due tonight', '2026-09-07 20:00', 'tonight (default 8pm)');
check('Essay due tomorrow', '2026-09-08 23:59', 'tomorrow');
check('Essay due tomorrow at 5pm', '2026-09-08 17:00', 'tomorrow + explicit time');

// ---- Weekday names (NOW is Monday Sep 7) ----
check('Reading due Monday', '2026-09-07 23:59', 'bare "Monday" on a Monday means today');
check('Reading due Friday', '2026-09-11 23:59', 'bare "Friday" = the upcoming Friday (4 days out)');
check('Reading due next Friday', '2026-09-18 23:59', '"next Friday" skips a full week beyond the bare one');
check('Reading due next Monday', '2026-09-14 23:59', '"next Monday" on a Monday = 7 days out, not today');
check('Quiz Wed 2pm', '2026-09-09 14:00', 'abbreviated weekday + time');

// ---- Relative offsets ----
check('Project due in 3 days', '2026-09-10 23:59', '"in 3 days"');
check('Project due in 1 week', '2026-09-14 23:59', '"in 1 week"');
check('Project due in 2 weeks', '2026-09-21 23:59', '"in 2 weeks"');

// ---- Explicit dates ----
check('Midterm on Oct 8, 3:00pm', '2026-10-08 15:00', 'explicit month/day + time');
check('Field trip form due 9/15', '2026-09-15 23:59', 'slash date, no time -> default 11:59pm');
check('Permission slip due 9/15/26', '2026-09-15 23:59', 'slash date with 2-digit year');

// ---- No date present ----
const none = parseNaturalDueDate('Bring calculator to class', { now: NOW });
assert(none === null, 'text with no date reference returns null');

// ---- Year rollover: "Jan 10" relative to a Sept 2026 reference should be 2027 ----
const rollover = parseNaturalDueDate('Essay due Jan 10', { now: NOW });
assert(rollover && rollover.date.getFullYear() === 2026, 'bare "Jan 10" with no term context defaults to the reference year (2026) — resolveYear needs a term range to roll forward');

// ---- Term-aware year resolution (mirrors syllabus-parser behavior) ----
const term = { startDate: '2026-08-24T00:00:00Z', endDate: '2027-05-20T00:00:00Z' };
const withTerm = parseNaturalDueDate('Final project due Jan 10', { now: NOW, term });
assert(withTerm && withTerm.date.getFullYear() === 2027, 'with a term spanning the new year, "Jan 10" resolves to 2027');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
