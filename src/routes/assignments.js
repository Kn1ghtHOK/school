import { json, err, readJSON } from "../lib/http.js";
import { getJSON, putJSON, newId, keys } from "../lib/store.js";
import { scoreCompletion, summarizeHistory } from "../lib/points.js";
import {
  isValidDate,
  normalizePriority,
  normalizeEstimateMinutes,
  normalizeUrl,
  clampText,
  MAX_TITLE_LEN,
} from "../lib/validate.js";

export async function list(request, env, termId) {
  const assignments = await getJSON(env.SCHOOL_KV, keys.assignments(termId), []);
  return json({ assignments });
}

export async function create(request, env, termId) {
  const body = await readJSON(request);
  const title = clampText(body.title, MAX_TITLE_LEN).trim();
  if (!title) return err("title is required.", 400);
  if (!isValidDate(body.dueDate)) return err("dueDate is required and must be a valid date.", 400);

  const priority = normalizePriority(body.priority);
  if (priority === null) return err(`priority must be one of: low, medium, high.`, 400);

  const estimatedMinutes = normalizeEstimateMinutes(body.estimatedMinutes);
  if (estimatedMinutes === false) return err("estimatedMinutes must be a positive number (minutes).", 400);

  const link = normalizeUrl(body.link);
  if (link === false) return err("link must be a valid http(s) URL.", 400);

  const assignments = await getJSON(env.SCHOOL_KV, keys.assignments(termId), []);
  const assignment = {
    id: newId(),
    title,
    classId: body.classId || null,
    dueDate: new Date(body.dueDate).toISOString(),
    notes: clampText(body.notes),
    priority,
    estimatedMinutes: estimatedMinutes || null,
    link: link || null,
    status: "pending",
    completedAt: null,
    pointsAwarded: null,
    remindersSent: [],
    snoozedUntil: null,
    createdAt: Date.now(),
  };
  assignments.push(assignment);
  await putJSON(env.SCHOOL_KV, keys.assignments(termId), assignments);
  return json({ assignment }, 201);
}

export async function update(request, env, termId, id) {
  const body = await readJSON(request);
  const assignments = await getJSON(env.SCHOOL_KV, keys.assignments(termId), []);
  const idx = assignments.findIndex((a) => a.id === id);
  if (idx === -1) return err("Assignment not found.", 404);

  // Editing the due date invalidates any reminders already sent for old offsets.
  // status/completedAt/pointsAwarded/remindersSent/snoozedUntil are only ever
  // changed by their dedicated endpoints, never by a plain field edit.
  const { status, completedAt, pointsAwarded, remindersSent, snoozedUntil, ...editable } = body;

  if (editable.title !== undefined) {
    editable.title = clampText(editable.title, MAX_TITLE_LEN).trim();
    if (!editable.title) return err("title cannot be empty.", 400);
  }
  if (editable.dueDate !== undefined) {
    if (!isValidDate(editable.dueDate)) return err("dueDate must be a valid date.", 400);
    editable.dueDate = new Date(editable.dueDate).toISOString();
  }
  if (editable.priority !== undefined) {
    const priority = normalizePriority(editable.priority);
    if (priority === null) return err(`priority must be one of: low, medium, high.`, 400);
    editable.priority = priority;
  }
  if (editable.notes !== undefined) editable.notes = clampText(editable.notes);
  if (editable.estimatedMinutes !== undefined) {
    const estimatedMinutes = normalizeEstimateMinutes(editable.estimatedMinutes);
    if (estimatedMinutes === false) return err("estimatedMinutes must be a positive number (minutes).", 400);
    editable.estimatedMinutes = estimatedMinutes;
  }
  if (editable.link !== undefined) {
    const link = normalizeUrl(editable.link);
    if (link === false) return err("link must be a valid http(s) URL.", 400);
    editable.link = link;
  }

  assignments[idx] = { ...assignments[idx], ...editable, id };
  if (body.dueDate) {
    assignments[idx].remindersSent = [];
    assignments[idx].snoozedUntil = null; // a new due date supersedes any prior snooze
  }
  await putJSON(env.SCHOOL_KV, keys.assignments(termId), assignments);
  return json({ assignment: assignments[idx] });
}

export async function remove(request, env, termId, id) {
  const assignments = await getJSON(env.SCHOOL_KV, keys.assignments(termId), []);
  const target = assignments.find((a) => a.id === id);
  const next = assignments.filter((a) => a.id !== id);
  if (next.length === assignments.length) return err("Assignment not found.", 404);
  await putJSON(env.SCHOOL_KV, keys.assignments(termId), next);

  // Keep the points ledger consistent if a completed assignment is deleted.
  if (target?.pointsAwarded) {
    await removeFromHistory(env, id);
  }
  return json({ ok: true });
}

export async function complete(request, env, termId, id) {
  const assignments = await getJSON(env.SCHOOL_KV, keys.assignments(termId), []);
  const idx = assignments.findIndex((a) => a.id === id);
  if (idx === -1) return err("Assignment not found.", 404);
  if (assignments[idx].status === "done") {
    const points = await getJSON(env.SCHOOL_KV, keys.points(), { history: [] });
    return json({ assignment: assignments[idx], ...summarizeHistory(points.history) });
  }

  const completedAt = Date.now();
  const score = scoreCompletion(assignments[idx].dueDate, completedAt);
  assignments[idx].status = "done";
  assignments[idx].completedAt = completedAt;
  assignments[idx].pointsAwarded = score.pts;
  await putJSON(env.SCHOOL_KV, keys.assignments(termId), assignments);

  const points = await getJSON(env.SCHOOL_KV, keys.points(), { history: [] });
  points.history.push({
    assignmentId: id,
    title: assignments[idx].title,
    dueDate: assignments[idx].dueDate,
    completedAt,
    pts: score.pts,
    tag: score.tag,
  });
  await putJSON(env.SCHOOL_KV, keys.points(), points);

  return json({ assignment: assignments[idx], scoreLabel: score.label, ...summarizeHistory(points.history) });
}

export async function uncomplete(request, env, termId, id) {
  const assignments = await getJSON(env.SCHOOL_KV, keys.assignments(termId), []);
  const idx = assignments.findIndex((a) => a.id === id);
  if (idx === -1) return err("Assignment not found.", 404);

  assignments[idx].status = "pending";
  assignments[idx].completedAt = null;
  assignments[idx].pointsAwarded = null;
  await putJSON(env.SCHOOL_KV, keys.assignments(termId), assignments);

  const summary = await removeFromHistory(env, id);
  return json({ assignment: assignments[idx], ...summary });
}

/** Suppresses reminders for this assignment until a given time, then sends one fresh nudge when it elapses. */
export async function snooze(request, env, termId, id) {
  const body = await readJSON(request);
  if (!isValidDate(body.until)) return err("until is required and must be a valid date.", 400);
  const until = new Date(body.until).getTime();
  if (until <= Date.now()) return err("until must be in the future.", 400);

  const assignments = await getJSON(env.SCHOOL_KV, keys.assignments(termId), []);
  const idx = assignments.findIndex((a) => a.id === id);
  if (idx === -1) return err("Assignment not found.", 404);

  assignments[idx].snoozedUntil = new Date(until).toISOString();
  await putJSON(env.SCHOOL_KV, keys.assignments(termId), assignments);
  return json({ assignment: assignments[idx] });
}

async function removeFromHistory(env, assignmentId) {
  const points = await getJSON(env.SCHOOL_KV, keys.points(), { history: [] });
  points.history = points.history.filter((h) => h.assignmentId !== assignmentId);
  await putJSON(env.SCHOOL_KV, keys.points(), points);
  return summarizeHistory(points.history);
}
