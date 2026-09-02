import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import worker from '../src/index.js';
import { createMockKV } from './mock-kv.mjs';
import { generateVapidKeys } from '../src/lib/webpush.js';

const html = fs.readFileSync('../public/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'https://example.com/', pretendToBeVisual: true });
const { window } = dom;

// ---- Backend wired to a real (mocked-KV) worker instance ----
const kv = createMockKV();
const vapid = await generateVapidKeys();
const env = {
  SCHOOL_KV: kv,
  VAPID_PUBLIC_KEY: vapid.publicKeyB64url,
  VAPID_PRIVATE_JWK: JSON.stringify(vapid.privateJwk),
  VAPID_SUBJECT: 'mailto:test@example.com',
  ASSETS: { fetch: async () => new window.Response('asset', { status: 200 }) },
};
const ctx = { waitUntil: (p) => p };

// ---- Globals expected by app.js / api.js / push.js ----
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
defineGlobal('window', window);
defineGlobal('document', window.document);
defineGlobal('navigator', window.navigator);
defineGlobal('localStorage', window.localStorage);
defineGlobal('location', window.location);
defineGlobal('confirm', () => true);
defineGlobal('CustomEvent', window.CustomEvent);

window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

globalThis.fetch = async (url, opts = {}) => {
  const fullUrl = String(url).startsWith('http') ? url : `https://example.com${url}`;
  const req = new Request(fullUrl, opts);
  return worker.fetch(req, env, ctx);
};

let errors = [];
window.addEventListener('error', (e) => errors.push(e.error?.stack || e.message));
process.on('unhandledRejection', (e) => errors.push('unhandledRejection: ' + (e?.stack || e)));

// ---- Boot the app ----
await import('../public/js/app.js');

// give async boot() time to run (auth status fetch, etc.)
await new Promise((r) => setTimeout(r, 300));

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

assert(errors.length === 0, `no runtime errors during boot (got: ${JSON.stringify(errors)})`);
assert(!document.getElementById('auth-screen').classList.contains('hidden'), 'auth screen shown when logged out');
assert(!document.getElementById('auth-setup').classList.contains('hidden'), 'setup form shown (no passcode yet)');

// ---- Simulate setup flow ----
document.getElementById('setup-passcode').value = 'test1234';
document.getElementById('setup-submit').click();
await new Promise((r) => setTimeout(r, 300));

assert(errors.length === 0, `no runtime errors after setup (got: ${JSON.stringify(errors)})`);
assert(document.getElementById('app').classList.contains('hidden') === false, 'app shown after setup');
assert(localStorage.getItem('schoolapp_token') !== null, 'token stored after setup');

// ---- Add a term via the sheet ----
document.getElementById('btn-add-term').click();
await new Promise((r) => setTimeout(r, 50));
document.getElementById('term-name').value = 'Fall 2026';
document.getElementById('term-start').value = '2026-08-24';
document.getElementById('term-end').value = '2026-12-18';
document.getElementById('term-save').click();
await new Promise((r) => setTimeout(r, 300));

assert(errors.length === 0, `no runtime errors after adding term (got: ${JSON.stringify(errors)})`);
assert(document.getElementById('term-switch-label').textContent === 'Fall 2026', 'active term label updated');

// ---- Set up bell schedule (Tuesday: period 3) ----
document.querySelectorAll('.tabbar button')[1].click(); // schedule tab
await new Promise((r) => setTimeout(r, 50));
document.getElementById('btn-edit-dayschedule').click();
await new Promise((r) => setTimeout(r, 50));
assert(errors.length === 0, `no runtime errors opening bell schedule overview (got: ${JSON.stringify(errors)})`);
document.querySelector('[data-edit-day="2"]').click(); // Tuesday
await new Promise((r) => setTimeout(r, 50));
document.getElementById('add-period').click();
await new Promise((r) => setTimeout(r, 50));
let periodRow = document.querySelector('#period-rows [data-idx="0"]');
periodRow.querySelector('[data-field="name"]').value = '3';
periodRow.querySelector('[data-field="name"]').dispatchEvent(new window.Event('input', { bubbles: true }));
periodRow.querySelector('[data-field="start"]').value = '10:25';
periodRow.querySelector('[data-field="start"]').dispatchEvent(new window.Event('input', { bubbles: true }));
periodRow.querySelector('[data-field="end"]').value = '11:15';
periodRow.querySelector('[data-field="end"]').dispatchEvent(new window.Event('input', { bubbles: true }));
document.getElementById('day-save').click();
await new Promise((r) => setTimeout(r, 300));
assert(errors.length === 0, `no runtime errors saving Tuesday bell schedule (got: ${JSON.stringify(errors)})`);
assert(document.querySelector('[data-edit-day="2"] .sub').textContent.includes('1 class'), 'Tuesday shows 1 class after save');
document.getElementById('dayschedule-done').click();
await new Promise((r) => setTimeout(r, 50));

// ---- Add a WIN block to every school day ----
document.getElementById('btn-edit-dayschedule').click();
await new Promise((r) => setTimeout(r, 50));
document.getElementById('add-everyday-block').click();
await new Promise((r) => setTimeout(r, 50));
document.getElementById('eb-kind').value = 'win';
document.getElementById('eb-start').value = '08:00';
document.getElementById('eb-end').value = '08:10';
document.getElementById('eb-save').click();
await new Promise((r) => setTimeout(r, 300));
assert(errors.length === 0, `no runtime errors adding an every-day block (got: ${JSON.stringify(errors)})`);
document.getElementById('dayschedule-done').click();
await new Promise((r) => setTimeout(r, 50));

// ---- Add a class via the omnibox (natural language) ----
document.getElementById('topbar-add').click();
await new Promise((r) => setTimeout(r, 50));
document.getElementById('omni-input').value = 'CS 201 period 3';
document.getElementById('omni-go').click();
await new Promise((r) => setTimeout(r, 300));

assert(errors.length === 0, `no runtime errors after adding class via omnibox (got: ${JSON.stringify(errors)})`);
assert(document.getElementById('schedule-week').textContent.includes('CS 201'), 'class appears in schedule view');

// ---- Add an assignment ----
document.querySelectorAll('.tabbar button')[2].click(); // assignments tab
await new Promise((r) => setTimeout(r, 50));
document.getElementById('topbar-add').click();
await new Promise((r) => setTimeout(r, 50));
document.getElementById('omni-input').value = 'Essay 1';
document.getElementById('omni-go').click();
await new Promise((r) => setTimeout(r, 200));
// no date -> falls through to the full sheet, pre-filled
assert(document.getElementById('asg-title')?.value === 'Essay 1', 'dateless omnibox entry opens the assignment sheet pre-filled');
document.getElementById('asg-save').click();
await new Promise((r) => setTimeout(r, 300));

assert(errors.length === 0, `no runtime errors after adding assignment (got: ${JSON.stringify(errors)})`);
assert(document.getElementById('assignments-pending').textContent.includes('Essay 1'), 'assignment appears in list');

// ---- Quick add (natural-language) ----
document.getElementById('quick-add-input').value = 'Lab report due tomorrow at 5pm';
document.getElementById('quick-add-submit').click();
await new Promise((r) => setTimeout(r, 300));
assert(errors.length === 0, `no runtime errors after quick-add (got: ${JSON.stringify(errors)})`);
assert(document.getElementById('assignments-pending').textContent.includes('Lab report'), 'quick-added assignment appears in list');
assert(document.getElementById('quick-add-input').value === '', 'quick-add input clears after a successful add');

// ---- Snooze from the assignment sheet ----
const labReportRow = [...document.querySelectorAll('[data-assignment-id]')].find((r) => r.textContent.includes('Lab report'));
labReportRow.click();
await new Promise((r) => setTimeout(r, 100));
assert(!!document.getElementById('asg-snooze-1h'), 'snooze buttons appear on a pending assignment');
document.getElementById('asg-snooze-1h').click();
await new Promise((r) => setTimeout(r, 200));
assert(errors.length === 0, `no runtime errors snoozing an assignment (got: ${JSON.stringify(errors)})`);
assert(document.getElementById('sheet-root').innerHTML === '', 'sheet closes after snoozing');

// A dateless, non-assignment-shaped entry with no clear title opens the full sheet.
document.getElementById('quick-add-input').value = 'Finish the history poster';
document.getElementById('quick-add-submit').click();
await new Promise((r) => setTimeout(r, 100));
assert(errors.length === 0, `no runtime errors when quick-add has no date (got: ${JSON.stringify(errors)})`);
assert(document.getElementById('asg-title')?.value === 'Finish the history poster', 'a dateless entry falls back to the full sheet with the title prefilled');
document.getElementById('asg-cancel').click();

// A to-do-shaped phrase becomes a to-do directly from quick-add.
document.getElementById('quick-add-input').value = 'bring a calculator';
document.getElementById('quick-add-submit').click();
await new Promise((r) => setTimeout(r, 200));
assert(errors.length === 0, `no runtime errors on a to-do-shaped quick-add (got: ${JSON.stringify(errors)})`);
const calcTodo = [...document.querySelectorAll('[data-todo-title]')].find((i) => i.value === 'bring a calculator');
assert(!!calcTodo, 'a "bring …" phrase is captured as a to-do');
// clean it back up so the dedicated to-do tests below start from an empty list
calcTodo.closest('[data-todo-id]').querySelector('[data-remove-todo]').click();
await new Promise((r) => setTimeout(r, 100));

// ---- To-dos ----
document.getElementById('todo-add-input').value = 'Add a new pen to my bag';
document.getElementById('todo-add-submit').click();
await new Promise((r) => setTimeout(r, 200));
assert(errors.length === 0, `no runtime errors after adding a todo (got: ${JSON.stringify(errors)})`);
assert(document.querySelector('[data-todo-title]')?.value === 'Add a new pen to my bag', 'todo appears in list');

const todoCheck = document.querySelector('[data-toggle-todo]');
assert(!!todoCheck, 'todo checkbox exists');
todoCheck.click();
await new Promise((r) => setTimeout(r, 200));
assert(errors.length === 0, `no runtime errors toggling a todo (got: ${JSON.stringify(errors)})`);
assert(document.querySelector('.todo-row.done'), 'todo shows as done after toggling');

const todoRemoveBtn = document.querySelector('[data-remove-todo]');
todoRemoveBtn.click();
await new Promise((r) => setTimeout(r, 100));
assert(errors.length === 0, `no runtime errors deleting a todo (got: ${JSON.stringify(errors)})`);
assert(!document.getElementById('todos-list').querySelector('[data-todo-title]'), 'todo removed from list immediately after delete');

// ---- Complete it via checkbox ----
const checkBtn = document.querySelector('[data-toggle-complete]');
assert(!!checkBtn, 'complete checkbox exists');
checkBtn.click();
await new Promise((r) => setTimeout(r, 300));
assert(errors.length === 0, `no runtime errors after completing assignment (got: ${JSON.stringify(errors)})`);
assert(document.getElementById('level-points').textContent !== '0', `points updated (got ${document.getElementById('level-points').textContent})`);

// ---- Visit remaining views ----
for (const view of ['today', 'calendar', 'focus', 'settings']) {
  location.hash = view;
  await new Promise((r) => setTimeout(r, 100));
  assert(errors.length === 0, `no runtime errors rendering ${view} view (got: ${JSON.stringify(errors)})`);
}

location.hash = 'today';
await new Promise((r) => setTimeout(r, 100));
assert(!document.getElementById('do-next-wrap').classList.contains('hidden'), '"Do this next" card shows when pending assignments exist');
assert(document.getElementById('do-next-card').querySelector('[data-assignment-id]'), '"Do this next" card contains an assignment row');

// ---- Search ----
document.getElementById('topbar-search').click();
await new Promise((r) => setTimeout(r, 50));
document.getElementById('search-input').value = 'CS 201';
document.getElementById('search-input').dispatchEvent(new window.Event('input', { bubbles: true }));
await new Promise((r) => setTimeout(r, 400)); // debounce + fetch
assert(errors.length === 0, `no runtime errors searching (got: ${JSON.stringify(errors)})`);
assert(document.getElementById('search-results').textContent.includes('CS 201'), 'search finds the class by name');
document.querySelector('#search-results [data-class-id]').click();
await new Promise((r) => setTimeout(r, 120));
assert(document.getElementById('view-class').classList.contains('active'), 'clicking a search result opens the class home page');
assert(document.getElementById('class-detail').textContent.includes('CS 201'), 'class home page shows the class name');
document.getElementById('cd-edit').click();
await new Promise((r) => setTimeout(r, 80));
assert(document.getElementById('cls-title')?.value === 'CS 201', 'Edit on the class page opens the edit sheet');
document.getElementById('cls-cancel').click();
location.hash = 'today';
await new Promise((r) => setTimeout(r, 60));

// ---- Archive / unarchive a term ----
location.hash = 'settings';
await new Promise((r) => setTimeout(r, 100));
document.querySelector('#settings-terms [data-edit-term]').click();
await new Promise((r) => setTimeout(r, 100));
document.getElementById('term-archive').click();
await new Promise((r) => setTimeout(r, 300));
assert(errors.length === 0, `no runtime errors archiving a term (got: ${JSON.stringify(errors)})`);
assert(!document.getElementById('archived-terms-wrap').classList.contains('hidden'), 'archived section becomes visible after archiving the only term');
assert(document.getElementById('term-switch-label').textContent === 'Add a term', 'topbar shows no active term after archiving it');

document.querySelector('#settings-archived-terms [data-edit-term]').click();
await new Promise((r) => setTimeout(r, 100));
assert(document.getElementById('term-archive').textContent.includes('Unarchive'), 'archived term sheet offers Unarchive');
document.getElementById('term-archive').click();
await new Promise((r) => setTimeout(r, 300));
assert(errors.length === 0, `no runtime errors unarchiving a term (got: ${JSON.stringify(errors)})`);
assert(document.getElementById('archived-terms-wrap').classList.contains('hidden'), 'archived section hides once nothing is archived');
assert(document.getElementById('term-switch-label').textContent === 'Fall 2026', 'unarchiving reactivates the term');

// ---- Syllabus paste-in import ----
document.getElementById('btn-syllabus-import').click();
await new Promise((r) => setTimeout(r, 50));
document.getElementById('syl-text').value = 'Oct 8 - Midterm Exam, 3:00pm\n11/5 - Project proposal due';
document.getElementById('syl-parse').click();
await new Promise((r) => setTimeout(r, 50));
assert(errors.length === 0, `no runtime errors parsing syllabus (got: ${JSON.stringify(errors)})`);
const sylRows = document.querySelectorAll('#syl-rows [data-row]');
assert(sylRows.length === 2, `syllabus parser found 2 rows (got ${sylRows.length})`);
document.getElementById('syl-import').click();
await new Promise((r) => setTimeout(r, 300));
assert(errors.length === 0, `no runtime errors importing syllabus rows (got: ${JSON.stringify(errors)})`);
assert(document.getElementById('assignments-pending').textContent.includes('Midterm Exam'), 'imported syllabus item appears in assignments');

// ---- Calendar day click ----
location.hash = 'calendar';
await new Promise((r) => setTimeout(r, 100));
const calCell = document.querySelector('.month-cell:not(.other-month)');
assert(!!calCell, 'calendar cell exists');
calCell.click();
await new Promise((r) => setTimeout(r, 100));
assert(errors.length === 0, `no runtime errors clicking calendar day (got: ${JSON.stringify(errors)})`);

// ---- Term switcher sheet ----
document.getElementById('term-switch').click();
await new Promise((r) => setTimeout(r, 100));
assert(document.querySelector('[data-pick-term]') !== null, 'term switcher lists the term');
document.getElementById('sheet-backdrop').click();
await new Promise((r) => setTimeout(r, 50));
assert(document.getElementById('sheet-root').innerHTML === '', 'sheet closes on backdrop click');

// ---- Class home page: inline notes persist ----
location.hash = 'schedule';
await new Promise((r) => setTimeout(r, 100));
document.querySelector('#schedule-week [data-class-id]').click();
await new Promise((r) => setTimeout(r, 150));
assert(document.getElementById('view-class').classList.contains('active'), 'tapping a class row opens the class home page');
assert(document.getElementById('class-detail').textContent.includes('CS 201'), 'class home page shows the class name');
const cdNotes = document.getElementById('cd-notes');
cdNotes.value = 'Bring calculator';
cdNotes.dispatchEvent(new window.Event('blur', { bubbles: true }));
await new Promise((r) => setTimeout(r, 250));
location.hash = 'today';
await new Promise((r) => setTimeout(r, 60));
location.hash = 'schedule';
await new Promise((r) => setTimeout(r, 80));
document.querySelector('#schedule-week [data-class-id]').click();
await new Promise((r) => setTimeout(r, 200));
assert(document.getElementById('cd-notes').value === 'Bring calculator', 'class notes persisted (inline on the class page)');

// ---- Delete-with-undo: class disappears immediately, Undo brings it back ----
document.getElementById('cd-edit').click();
await new Promise((r) => setTimeout(r, 80));
document.getElementById('cls-delete').click();
await new Promise((r) => setTimeout(r, 100));
assert(errors.length === 0, `no runtime errors after optimistic class delete (got: ${JSON.stringify(errors)})`);
assert(document.getElementById('view-schedule').classList.contains('active'), 'deleting from the class page returns to the schedule');
assert(!document.getElementById('schedule-week').textContent.includes('CS 201'), 'class removed from schedule immediately after delete');
// Pick the toast that actually belongs to this delete — other undo toasts
// (e.g. from the earlier todo deletion) may still be on screen too.
const classToast = [...document.querySelectorAll('.toast')].find((t) => t.textContent.includes('CS 201'));
const undoBtn = classToast?.querySelector('.toast-action');
assert(!!undoBtn && undoBtn.textContent === 'Undo', 'undo toast action is shown after delete');
undoBtn.click();
await new Promise((r) => setTimeout(r, 100));
assert(errors.length === 0, `no runtime errors after clicking Undo (got: ${JSON.stringify(errors)})`);
assert(document.getElementById('schedule-week').textContent.includes('CS 201'), 'class restored after Undo');

// ---- Focus timer start/stop ----
location.hash = 'focus';
await new Promise((r) => setTimeout(r, 100));
document.getElementById('focus-start').click();
await new Promise((r) => setTimeout(r, 200));
assert(errors.length === 0, `no runtime errors starting focus (got: ${JSON.stringify(errors)})`);
assert(document.getElementById('focus-start').textContent === 'Stop focus', 'focus button shows stop state');
document.getElementById('focus-start').click();
await new Promise((r) => setTimeout(r, 200));
assert(document.getElementById('focus-start').textContent === 'Start focus', 'focus button resets after stop');

console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
process.exit(process.exitCode || 0);
