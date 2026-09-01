import worker from '../src/index.js';
import { createMockKV } from './mock-kv.mjs';
import { generateVapidKeys } from '../src/lib/webpush.js';

const kv = createMockKV();
const vapid = await generateVapidKeys();
const env = {
  SCHOOL_KV: kv,
  VAPID_PUBLIC_KEY: vapid.publicKeyB64url,
  VAPID_PRIVATE_JWK: JSON.stringify(vapid.privateJwk),
  VAPID_SUBJECT: 'mailto:test@example.com',
  ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
};
const ctx = { waitUntil: (p) => p };

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', msg); }
}

async function call(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const hasBody = body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD';
  const req = new Request(`https://example.com${path}`, {
    method,
    headers,
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env, ctx);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

// --- Auth ---
let r = await call('GET', '/api/auth/status');
assert(r.status === 200 && r.json.hasPasscode === false, 'no passcode initially');

r = await call('POST', '/api/auth/setup', { passcode: 'abcd' });
assert(r.status === 200 && r.json.token, 'setup returns token');
const token = r.json.token;

r = await call('GET', '/api/terms', null, 'bogus-token');
assert(r.status === 401, 'bogus token rejected');

r = await call('POST', '/api/auth/setup', { passcode: 'abcd' });
assert(r.status === 409, 'cannot set up passcode twice');

r = await call('POST', '/api/auth/login', { passcode: 'wrong' });
assert(r.status === 401, 'wrong passcode rejected');

r = await call('POST', '/api/auth/login', { passcode: 'abcd' });
assert(r.status === 200 && r.json.token, 'correct passcode logs in');

// --- Terms ---
r = await call('POST', '/api/terms', { name: 'Fall 2026', startDate: '2026-08-24', endDate: '2026-12-18' }, token);
assert(r.status === 201, 'create term');
const termId = r.json.term.id;

r = await call('GET', '/api/terms', null, token);
assert(r.status === 200 && r.json.activeTermId === termId, 'first term auto-activated');

// --- Schedule ---
r = await call('POST', `/api/terms/${termId}/schedule`, {
  title: 'CS 201', instructor: 'Dr. Lee', location: 'Keller 3-180', period: '3',
}, token);
assert(r.status === 201, 'create class');
const classId = r.json.class.id;

r = await call('GET', `/api/terms/${termId}/schedule`, null, token);
assert(r.json.classes.length === 1, 'schedule has 1 class');

r = await call('POST', `/api/terms/${termId}/schedule`, { title: 'No period' }, token);
assert(r.status === 400, 'class without a period is rejected');

// --- Day schedule (bell schedule matrix) ---
r = await call('GET', `/api/terms/${termId}/dayschedule`, null, token);
assert(r.status === 200 && Object.keys(r.json.daySchedule).length === 0, 'day schedule starts empty');

r = await call('PUT', `/api/terms/${termId}/dayschedule/2`, {
  periods: [
    { period: '1', start: '08:00', end: '08:50' },
    { period: '3', start: '10:25', end: '11:15' },
  ],
}, token);
assert(r.status === 200 && r.json.daySchedule['2'].length === 2, 'set Tuesday periods');

r = await call('PUT', `/api/terms/${termId}/dayschedule/3`, {
  periods: [{ period: '2', start: '09:35', end: '10:20' }],
}, token);
assert(r.status === 200, 'set Wednesday periods with a later start');

r = await call('PUT', `/api/terms/${termId}/dayschedule/0`, { periods: null }, token);
assert(r.status === 200 && r.json.daySchedule['0'] === null, 'Sunday set to no school');

r = await call('PUT', `/api/terms/${termId}/dayschedule/9`, { periods: null }, token);
assert(r.status === 400, 'invalid weekday rejected');

r = await call('PUT', `/api/terms/${termId}/dayschedule/2`, {
  periods: [{ period: '1', start: '8am', end: '08:50' }],
}, token);
assert(r.status === 400, 'invalid time format rejected');

// --- Notes ---
r = await call('PUT', `/api/classes/${classId}/notes`, { content: 'Bring calculator' }, token);
assert(r.status === 200 && r.json.note.content === 'Bring calculator', 'save note');
r = await call('GET', `/api/classes/${classId}/notes`, null, token);
assert(r.json.note.content === 'Bring calculator', 'read note back');

// --- Assignments ---
const futureDue = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
r = await call('POST', `/api/terms/${termId}/assignments`, {
  title: 'Essay 1', classId, dueDate: futureDue, priority: 'high',
}, token);
assert(r.status === 201, 'create assignment');
const assignmentId = r.json.assignment.id;

r = await call('POST', `/api/terms/${termId}/assignments/${assignmentId}/complete`, null, token);
assert(r.status === 200 && r.json.total === 50 && r.json.streak === 1, 'complete way-early assignment scores 50 pts, streak 1');

r = await call('POST', `/api/terms/${termId}/assignments/${assignmentId}/complete`, null, token);
assert(r.json.total === 50, 'completing twice is idempotent');

r = await call('POST', `/api/terms/${termId}/assignments/${assignmentId}/uncomplete`, null, token);
assert(r.json.total === 0 && r.json.streak === 0, 'uncomplete reverses points');

r = await call('GET', '/api/points', null, token);
assert(r.json.total === 0 && r.json.level.name === 'Freshman Focus', 'points summary after reversal');

// --- Focus mode ---
r = await call('POST', '/api/focus/start', { minutes: 25 }, token);
assert(r.status === 200 && r.json.focus.until > Date.now(), 'focus mode starts');
r = await call('POST', '/api/focus/stop', null, token);
assert(r.json.focus.until === null, 'focus mode stops');

r = await call('POST', '/api/focus/start', { minutes: -5 }, token);
assert(r.status === 400, 'negative focus minutes rejected');

r = await call('POST', '/api/focus/start', { minutes: 'a lot' }, token);
assert(r.status === 400, 'non-numeric focus minutes rejected');

r = await call('POST', '/api/focus/start', { minutes: 99999 }, token);
const focusUntil = r.json.focus.until;
const maxExpected = Date.now() + 181 * 60 * 1000;
assert(r.status === 200 && focusUntil < maxExpected, 'absurdly large focus minutes is capped, not taken literally');
await call('POST', '/api/focus/stop', null, token);

// --- Settings ---
r = await call('PUT', '/api/settings', { reminderOffsetsMinutes: [2880, 60, 15] }, token);
assert(r.json.settings.reminderOffsetsMinutes.length === 3, 'update settings');

r = await call('PUT', '/api/settings', { reminderOffsetsMinutes: ['soon', -5] }, token);
assert(r.status === 400, 'non-numeric/negative reminder offsets rejected');

r = await call('PUT', '/api/settings', { reminderOffsetsMinutes: [] }, token);
assert(r.status === 400, 'empty reminder offsets array rejected');

r = await call('PUT', '/api/settings', { theme: 'rainbow' }, token);
assert(r.status === 400, 'invalid theme value rejected');

r = await call('PUT', '/api/settings', { theme: 'dark' }, token);
assert(r.status === 200 && r.json.settings.theme === 'dark', 'valid theme still accepted after the rejections above');

// --- Validation hardening ---
r = await call('POST', `/api/terms/${termId}/assignments`, { title: 'Bad due date', dueDate: 'not-a-date' }, token);
assert(r.status === 400, 'assignment with invalid dueDate rejected');

r = await call('POST', `/api/terms/${termId}/assignments`, { title: 'Bad priority', dueDate: futureDue, priority: 'urgent' }, token);
assert(r.status === 400, 'assignment with invalid priority rejected');

r = await call('POST', `/api/terms/${termId}/assignments`, { title: '   ', dueDate: futureDue }, token);
assert(r.status === 400, 'assignment with whitespace-only title rejected');

r = await call('POST', '/api/terms', { name: 'Backwards Term', startDate: '2026-12-18', endDate: '2026-08-24' }, token);
assert(r.status === 400, 'term with end before start rejected');

r = await call('POST', '/api/terms', { name: 'Bad Dates', startDate: 'nope', endDate: 'also nope' }, token);
assert(r.status === 400, 'term with unparseable dates rejected');

r = await call('POST', `/api/terms/${termId}/schedule`, { title: '  ', period: '5' }, token);
assert(r.status === 400, 'class with whitespace-only title rejected');

r = await call('PUT', `/api/terms/${termId}/dayschedule/4`, {
  periods: [{ period: '1', start: '10:00', end: '09:00' }],
}, token);
assert(r.status === 400, 'period ending before it starts is rejected');

r = await call('PUT', `/api/terms/${termId}/dayschedule/4`, {
  periods: [
    { period: '1', start: '08:00', end: '08:50' },
    { period: '1', start: '09:00', end: '09:50' },
  ],
}, token);
assert(r.status === 400, 'duplicate period label on the same day is rejected');

r = await call('PUT', `/api/terms/${termId}/dayschedule/4`, {
  periods: [{ period: '1', start: '08:00', end: '08:50' }],
}, token);
assert(r.status === 200, 'valid day schedule still accepted after the rejections above');

// --- Assignment: effort estimate + link ---
r = await call('POST', `/api/terms/${termId}/assignments`, {
  title: 'Lab report', dueDate: futureDue, estimatedMinutes: 90, link: 'docs.google.com/doc/123',
}, token);
assert(r.status === 201 && r.json.assignment.estimatedMinutes === 90, 'assignment stores estimatedMinutes');
assert(r.json.assignment.link === 'https://docs.google.com/doc/123', 'assignment link gets https:// prefix added');
const labReportId = r.json.assignment.id;

r = await call('POST', `/api/terms/${termId}/assignments`, { title: 'Bad estimate', dueDate: futureDue, estimatedMinutes: -10 }, token);
assert(r.status === 400, 'negative estimatedMinutes rejected');

r = await call('POST', `/api/terms/${termId}/assignments`, { title: 'Bad link', dueDate: futureDue, link: 'not a url!!' }, token);
assert(r.status === 400, 'garbage link rejected');

r = await call('PUT', `/api/terms/${termId}/assignments/${labReportId}`, { estimatedMinutes: null }, token);
assert(r.status === 200 && r.json.assignment.estimatedMinutes === null, 'estimatedMinutes can be cleared');

// --- Assignment: snooze ---
r = await call('POST', `/api/terms/${termId}/assignments/${labReportId}/snooze`, {
  until: new Date(Date.now() + 3600000).toISOString(),
}, token);
assert(r.status === 200 && r.json.assignment.snoozedUntil, 'snooze sets snoozedUntil');

r = await call('POST', `/api/terms/${termId}/assignments/${labReportId}/snooze`, { until: new Date(Date.now() - 3600000).toISOString() }, token);
assert(r.status === 400, 'snoozing to a past time is rejected');

r = await call('POST', `/api/terms/${termId}/assignments/${labReportId}/snooze`, { until: 'not a date' }, token);
assert(r.status === 400, 'snoozing with an invalid date is rejected');

r = await call('POST', `/api/terms/${termId}/assignments/nonexistent-id/snooze`, { until: new Date(Date.now() + 3600000).toISOString() }, token);
assert(r.status === 404, 'snoozing a nonexistent assignment 404s');

await call('DELETE', `/api/terms/${termId}/assignments/${labReportId}`, null, token);

// --- Search ---
await call('POST', `/api/terms/${termId}/assignments`, { title: 'Photosynthesis essay', dueDate: futureDue, notes: 'cite three sources' }, token);
r = await call('GET', `/api/terms/${termId}/search?q=photo`, null, token);
assert(r.status === 200 && r.json.assignments.some((a) => a.title.includes('Photosynthesis')), 'search finds assignment by title');

r = await call('GET', `/api/terms/${termId}/search?q=cite`, null, token);
assert(r.json.assignments.some((a) => a.title.includes('Photosynthesis')), 'search finds assignment by notes content');

r = await call('GET', `/api/terms/${termId}/search?q=x`, null, token);
assert(r.status === 400, 'search query under 2 chars rejected');

r = await call('GET', `/api/terms/${termId}/search`, null, token);
assert(r.status === 400, 'search with no query rejected');

// --- Archived terms ---
r = await call('POST', '/api/terms', { name: 'Spring 2027', startDate: '2027-01-05', endDate: '2027-05-20' }, token);
const springTermId = r.json.term.id;

r = await call('PUT', `/api/terms/${termId}`, { archived: true }, token);
assert(r.status === 200 && r.json.term.archived === true, 'term can be archived');
assert(r.json.activeTermId === springTermId, 'archiving the active term reassigns active to a non-archived one');

r = await call('POST', `/api/terms/${termId}/activate`, null, token);
r = await call('GET', '/api/terms', null, token);
const fallTerm = r.json.terms.find((t) => t.id === termId);
assert(fallTerm.archived === false, 'activating an archived term un-archives it');
assert(r.json.activeTermId === termId, 'activating switches active term');

r = await call('PUT', `/api/terms/${termId}`, { archived: 'yes' }, token);
assert(r.status === 400, 'non-boolean archived value rejected');

await call('DELETE', `/api/terms/${springTermId}`, null, token);

// --- To-dos (global, not term-scoped) ---
r = await call('GET', '/api/todos', null, token);
assert(r.status === 200 && Array.isArray(r.json.todos) && r.json.todos.length === 0, 'todos start empty');

r = await call('POST', '/api/todos', { title: 'Add a new pen to my bag' }, token);
assert(r.status === 201 && r.json.todo.done === false, 'create a todo');
const todoId = r.json.todo.id;

r = await call('POST', '/api/todos', { title: '   ' }, token);
assert(r.status === 400, 'whitespace-only todo title rejected');

r = await call('PUT', `/api/todos/${todoId}`, { done: true }, token);
assert(r.status === 200 && r.json.todo.done === true && r.json.todo.completedAt, 'mark todo done sets completedAt');

r = await call('PUT', `/api/todos/${todoId}`, { done: false }, token);
assert(r.json.todo.completedAt === null, 'un-marking a todo clears completedAt');

r = await call('PUT', `/api/todos/${todoId}`, { done: 'yes' }, token);
assert(r.status === 400, 'non-boolean done value rejected');

r = await call('DELETE', `/api/todos/${todoId}`, null, token);
assert(r.status === 200, 'delete todo');
r = await call('DELETE', `/api/todos/${todoId}`, null, token);
assert(r.status === 404, 'deleting an already-deleted todo 404s');

// --- Delete cascade ---
r = await call('DELETE', `/api/terms/${termId}/schedule/${classId}`, null, token);
assert(r.status === 200, 'delete class');
r = await call('DELETE', `/api/terms/${termId}`, null, token);
assert(r.status === 200, 'delete term');
r = await call('GET', '/api/terms', null, token);
assert(r.json.terms.length === 0 && r.json.activeTermId === null, 'term list empty after delete');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
