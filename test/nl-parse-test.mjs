// Table-driven tests for the universal natural-language capture parser.
// Run: node nl-parse-test.mjs
import { parse, describeDraft, parseWithAssist } from "../public/js/nl-parse.js";

let pass = 0,
  fail = 0;
function check(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error("FAIL:", msg);
  }
}

// Fixed "now" so weekday math is stable: Wed 2026-09-02, 09:00 local.
const now = new Date(2026, 8, 2, 9, 0, 0);
const term = { startDate: "2026-08-24T00:00:00.000Z", endDate: "2026-12-18T00:00:00.000Z" };
const classes = [
  { id: "c-bio", title: "AP Biology", period: "3" },
  { id: "c-eng", title: "English 11", period: "2" },
  { id: "c-hist", title: "AP US History", period: "5" },
];
const ctx = { now, term, classes };

// ---- intent routing ----
check(parse("bring swim goggles", ctx).kind === "todo", '"bring swim goggles" → todo');
check(parse("return the field trip form", ctx).kind === "todo", '"return the field trip form" → todo');
check(parse("todo: email coach about Friday", ctx).kind === "todo", 'explicit "todo:" prefix → todo');
check(parse("remind me to charge my laptop", ctx).kind === "todo", '"remind me to …" → todo');
check(parse("essay draft due friday 5pm", ctx).kind === "assignment", "assignment noun + date → assignment");
check(parse("read chapter 4 tomorrow", ctx).kind === "assignment", '"read chapter 4 tomorrow" → assignment');
check(parse("AP Bio p3 with Dr. Lee in room 214", ctx).kind === "class", "period + teacher + room → class");
check(parse("add class Ceramics period 6", ctx).kind === "class", 'explicit "add class …" → class');
check(parse("bring the permission slip friday", ctx).kind === "assignment", "a date beats a to-do verb (to-dos have no dates)");

// ---- assignment field extraction ----
let r = parse("Lab report due friday 5pm !", ctx);
check(r.kind === "assignment", "lab report → assignment");
check(r.draft.title === "Lab report", `title cleaned → "${r.draft.title}"`);
check(r.draft.priority === "high", '"!" → high priority');
check(r.draft.dueDate instanceof Date && r.draft.dueDate.getDay() === 5, "due date lands on a Friday");
check(r.draft.dueDate.getHours() === 17, "5pm parsed as 17:00");
check(r.confidence === "high", "complete assignment → high confidence");

r = parse("outline for AP US History due in 3 days ~2h", ctx);
check(r.draft.classId === "c-hist", '"for AP US History" → matched by name');
check(r.draft.estimatedMinutes === 120, '"~2h" → 120 minutes');
check(r.draft.title.toLowerCase() === "outline", `title is just "outline" (got "${r.draft.title}")`);

r = parse("APUSH reading tonight", ctx);
check(r.draft.classId === "c-hist", "acronym APUSH → AP US History");

r = parse("read chapter 4 for english tomorrow ~45m", ctx);
check(r.draft.classId === "c-eng", '"for english" mid-sentence → English 11 by first word');
check(!/english/i.test(r.draft.title), `"for english" stripped from title (got "${r.draft.title}")`);
check(r.draft.estimatedMinutes === 45, "~45m effort parsed");

r = parse("study for bio quiz every week until dec 12", ctx);
check(!!r.draft.repeat && r.draft.repeat.weekly === true, "recurrence detected");
check(r.draft.repeat.until instanceof Date && r.draft.repeat.until.getMonth() === 11, '"until dec 12" parsed');

r = parse("submit problem set https://canvas.example.edu/p/12 tomorrow", ctx);
check(r.draft.link === "https://canvas.example.edu/p/12", "bare https URL pulled into link");
check(!r.draft.title.includes("http"), "URL removed from title");

r = parse("finish the thing", ctx);
check(r.kind === "assignment" && r.confidence === "low", "no date → low confidence (app opens the form)");
check(r.draft.title === "finish the thing", "undated assignment keeps its full title");

// ---- class field extraction ----
r = parse("Chemistry period 4 with Mrs. Alvarez room B12", ctx);
check(r.draft.title === "Chemistry", `class title → "${r.draft.title}"`);
check(r.draft.period === "4", "period 4");
check(/Alvarez/.test(r.draft.instructor), `instructor → "${r.draft.instructor}"`);
check(r.draft.location === "B12", `room → "${r.draft.location}"`);
check(r.confidence === "high", "class with title + period → high confidence");

r = parse("new class Wind Ensemble", ctx);
check(r.kind === "class" && r.confidence === "low", "class with no period → low confidence");
check(r.draft.title === "Wind Ensemble", "class title preserved after stripping 'new class'");

// ---- describeDraft ----
check(/due /.test(describeDraft(parse("essay due tomorrow 9am", ctx))), "describeDraft mentions the due date");
check(/To-do/.test(describeDraft(parse("pack cleats", ctx))), "describeDraft labels a to-do");
check(/Period 4/.test(describeDraft(parse("Art period 4", ctx))), "describeDraft shows the class period");

// ---- assist seam ----
const assisted = await parseWithAssist("anything", ctx, null);
check(assisted === null, "parseWithAssist with no config returns null");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
