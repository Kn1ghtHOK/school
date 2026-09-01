import { runReminderSweep } from '../src/cron.js';
import { createMockKV } from './mock-kv.mjs';
import { generateVapidKeys } from '../src/lib/webpush.js';
import { getJSON, putJSON, keys } from '../src/lib/store.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', msg); }
}

async function freshEnv() {
  const kv = createMockKV();
  const vapid = await generateVapidKeys();
  return {
    SCHOOL_KV: kv,
    VAPID_PUBLIC_KEY: vapid.publicKeyB64url,
    VAPID_PRIVATE_JWK: JSON.stringify(vapid.privateJwk),
    VAPID_SUBJECT: 'mailto:test@example.com',
  };
}

// ---- Setup: one term, a few assignments (one deliberately corrupt),
// and push subscriptions that are malformed/unreachable. None of this
// should ever stop reminders for the well-formed data. ----
const env = await freshEnv();
const termId = 'term-1';
const dueSoon = new Date(Date.now() + 30 * 60 * 1000).toISOString();
const dueSoon2 = new Date(Date.now() + 45 * 60 * 1000).toISOString();

await putJSON(env.SCHOOL_KV, keys.terms(), [{ id: termId, name: 'Test Term' }]);
await putJSON(env.SCHOOL_KV, keys.schedule(termId), []);
await putJSON(env.SCHOOL_KV, keys.assignments(termId), [
  { id: 'a1', title: 'Essay', dueDate: dueSoon, status: 'pending', remindersSent: [] },
  { id: 'a2', title: 'Lab report', dueDate: dueSoon2, status: 'pending', remindersSent: [] },
  { id: 'a3', title: 'Corrupt', dueDate: 'not-a-real-date', status: 'pending', remindersSent: [] },
]);
await putJSON(env.SCHOOL_KV, keys.settings(), { reminderOffsetsMinutes: [60] });
await putJSON(env.SCHOOL_KV, keys.pushSubs(), [
  { endpoint: 'https://example.invalid/bad-endpoint-1', keys: { p256dh: 'x', auth: 'y' } },
  { endpoint: '', keys: {} },
]);

let threw = false;
try {
  await runReminderSweep(env);
} catch (e) {
  threw = true;
  console.error('runReminderSweep threw:', e);
}
assert(!threw, 'reminder sweep completes without throwing despite bad data and bad subscriptions');

const assignments = await getJSON(env.SCHOOL_KV, keys.assignments(termId), []);
const a1 = assignments.find((a) => a.id === 'a1');
const a2 = assignments.find((a) => a.id === 'a2');
const a3 = assignments.find((a) => a.id === 'a3');
assert(a1.remindersSent.includes(60), 'valid assignment a1 still got its reminder processed');
assert(a2.remindersSent.includes(60), 'valid assignment a2 (after a1) still got processed — not blocked by a1');
assert(a3.remindersSent.length === 0, 'corrupt assignment a3 was skipped, not crashed on');

// ---- Independent scenario: a corrupted VAPID secret shouldn't throw ----
const env2 = await freshEnv();
env2.VAPID_PRIVATE_JWK = '{not valid json';
await putJSON(env2.SCHOOL_KV, keys.terms(), [{ id: termId, name: 'Test Term' }]);
await putJSON(env2.SCHOOL_KV, keys.assignments(termId), [
  { id: 'a1', title: 'Essay', dueDate: dueSoon, status: 'pending', remindersSent: [] },
]);
await putJSON(env2.SCHOOL_KV, keys.pushSubs(), [
  { endpoint: 'https://example.invalid/x', keys: { p256dh: 'x', auth: 'y' } },
]);
let threw2 = false;
try {
  await runReminderSweep(env2);
} catch {
  threw2 = true;
}
assert(!threw2, 'reminder sweep handles a corrupted VAPID secret without throwing');

// ---- Snooze: suppressed while snoozed, one wake-up when it elapses,
// then normal reminder logic resumes on the next cycle. ----
const env3 = await freshEnv();
const dueLater = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2 hr out
await putJSON(env3.SCHOOL_KV, keys.terms(), [{ id: termId, name: 'Test Term' }]);
await putJSON(env3.SCHOOL_KV, keys.schedule(termId), []);
await putJSON(env3.SCHOOL_KV, keys.settings(), { reminderOffsetsMinutes: [60] });
await putJSON(env3.SCHOOL_KV, keys.pushSubs(), [
  { endpoint: 'https://example.invalid/x', keys: { p256dh: 'x', auth: 'y' } },
]);

// Still snoozed (future) — sweep should do nothing to it at all.
await putJSON(env3.SCHOOL_KV, keys.assignments(termId), [
  { id: 'snoozed-future', title: 'Snoozed ahead', dueDate: dueLater, status: 'pending', remindersSent: [], snoozedUntil: new Date(Date.now() + 3600000).toISOString() },
]);
await runReminderSweep(env3);
let snoozed = (await getJSON(env3.SCHOOL_KV, keys.assignments(termId), []))[0];
assert(snoozed.remindersSent.length === 0, 'snoozed-until-the-future assignment gets no reminders this cycle');
assert(snoozed.snoozedUntil !== null, 'snoozedUntil is left untouched while still in the future');

// Snooze has elapsed — sweep should send exactly one wake-up and clear it.
await putJSON(env3.SCHOOL_KV, keys.assignments(termId), [
  { id: 'snoozed-elapsed', title: 'Snoozed, now due', dueDate: dueLater, status: 'pending', remindersSent: [], snoozedUntil: new Date(Date.now() - 60000).toISOString() },
]);
await runReminderSweep(env3);
let woken = (await getJSON(env3.SCHOOL_KV, keys.assignments(termId), []))[0];
assert(woken.remindersSent.includes('snoozed'), 'elapsed snooze sends exactly one wake-up reminder');
assert(woken.snoozedUntil === null, 'snoozedUntil is cleared once the wake-up has fired');

// Next cycle: shouldn't re-send the wake-up, and normal offset reminders
// should now be free to evaluate again since the snooze is cleared.
await runReminderSweep(env3);
let after = (await getJSON(env3.SCHOOL_KV, keys.assignments(termId), []))[0];
const wakeUpCount = after.remindersSent.filter((r) => r === 'snoozed').length;
assert(wakeUpCount === 1, 'the wake-up reminder is never sent twice on subsequent cycles');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
