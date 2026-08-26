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
periodRow.querySelector('[data-field="period"]').value = '3';
periodRow.querySelector('[data-field="period"]').dispatchEvent(new window.Event('input', { bubbles: true }));
periodRow.querySelector('[data-field="start"]').value = '10:25';
periodRow.querySelector('[data-field="start"]').dispatchEvent(new window.Event('input', { bubbles: true }));
periodRow.querySelector('[data-field="end"]').value = '11:15';
periodRow.querySelector('[data-field="end"]').dispatchEvent(new window.Event('input', { bubbles: true }));
document.getElementById('day-save').click();
await new Promise((r) => setTimeout(r, 300));
assert(errors.length === 0, `no runtime errors saving Tuesday bell schedule (got: ${JSON.stringify(errors)})`);
assert(document.querySelector('[data-edit-day="2"] .sub').textContent.includes('1 period'), 'Tuesday shows 1 period after save');
document.getElementById('dayschedule-done').click();
await new Promise((r) => setTimeout(r, 50));

// ---- Add a class on period 3 ----
document.getElementById('topbar-add').click();
await new Promise((r) => setTimeout(r, 50));
document.getElementById('cls-title').value = 'CS 201';
document.getElementById('cls-period').value = '3';
document.getElementById('cls-save').click();
await new Promise((r) => setTimeout(r, 300));

assert(errors.length === 0, `no runtime errors after adding class (got: ${JSON.stringify(errors)})`);
assert(document.getElementById('schedule-week').textContent.includes('CS 201'), 'class appears in schedule view');

// ---- Add an assignment ----
document.querySelectorAll('.tabbar button')[2].click(); // assignments tab
await new Promise((r) => setTimeout(r, 50));
document.getElementById('topbar-add').click();
await new Promise((r) => setTimeout(r, 50));
document.getElementById('asg-title').value = 'Essay 1';
document.getElementById('asg-save').click();
await new Promise((r) => setTimeout(r, 300));

assert(errors.length === 0, `no runtime errors after adding assignment (got: ${JSON.stringify(errors)})`);
assert(document.getElementById('assignments-pending').textContent.includes('Essay 1'), 'assignment appears in list');

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

// ---- Re-open the class to confirm notes persisted ----
location.hash = 'schedule';
await new Promise((r) => setTimeout(r, 100));
document.querySelector('[data-class-id]').click();
await new Promise((r) => setTimeout(r, 100));
assert(document.getElementById('cls-title').value === 'CS 201', 'editing existing class prefills title');
document.getElementById('cls-notes').value = 'Bring calculator';
document.getElementById('cls-save').click();
await new Promise((r) => setTimeout(r, 300));
document.querySelector('[data-class-id]').click();
await new Promise((r) => setTimeout(r, 150));
assert(document.getElementById('cls-notes').value === 'Bring calculator', 'class notes persisted across edits');
document.getElementById('cls-cancel').click();

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
