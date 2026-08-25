import { json, err, readJSON } from "../lib/http.js";
import { getJSON, putJSON, newId, keys } from "../lib/store.js";
import { scoreCompletion, summarizeHistory } from "../lib/points.js";

export async function list(request, env, termId) {
  const assignments = await getJSON(env.SCHOOL_KV, keys.assignments(termId), []);
  return json({ assignments });
}

export async function create(request, env, termId) {
  const body = await readJSON(request);
  if (!body.title || !body.dueDate) return err("title and dueDate are required.", 400);

  const assignments = await getJSON(env.SCHOOL_KV, keys.assignments(termId), []);
  const assignment = {
    id: newId(),
    title: String(body.title),
    classId: body.classId || null,
    dueDate: body.dueDate,
    notes: body.notes || "",
    priority: body.priority || "medium",
    status: "pending",
    completedAt: null,
    pointsAwarded: null,
    remindersSent: [],
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
  const { status, completedAt, pointsAwarded, remindersSent, ...editable } = body;
  assignments[idx] = { ...assignments[idx], ...editable, id };
  if (body.dueDate) assignments[idx].remindersSent = [];
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

async function removeFromHistory(env, assignmentId) {
  const points = await getJSON(env.SCHOOL_KV, keys.points(), { history: [] });
  points.history = points.history.filter((h) => h.assignmentId !== assignmentId);
  await putJSON(env.SCHOOL_KV, keys.points(), points);
  return summarizeHistory(points.history);
}
