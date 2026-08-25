import { json, err, readJSON } from "../lib/http.js";
import { getJSON, putJSON, newId, keys } from "../lib/store.js";

const COLORS = ["#5B8DEF", "#EF6A5B", "#5BCB77", "#F2B84B", "#B15BEF", "#3EC6C0", "#EF5B9C"];

export async function list(request, env, termId) {
  const classes = await getJSON(env.SCHOOL_KV, keys.schedule(termId), []);
  return json({ classes });
}

export async function create(request, env, termId) {
  const body = await readJSON(request);
  if (!body.title || !Array.isArray(body.days) || body.days.length === 0) {
    return err("title and at least one day are required.", 400);
  }
  if (!body.startTime || !body.endTime) return err("startTime and endTime are required.", 400);

  const classes = await getJSON(env.SCHOOL_KV, keys.schedule(termId), []);
  const cls = {
    id: newId(),
    title: String(body.title),
    instructor: body.instructor || "",
    location: body.location || "",
    days: body.days.map(Number),
    startTime: body.startTime,
    endTime: body.endTime,
    color: body.color || COLORS[classes.length % COLORS.length],
    createdAt: Date.now(),
  };
  classes.push(cls);
  await putJSON(env.SCHOOL_KV, keys.schedule(termId), classes);
  return json({ class: cls }, 201);
}

export async function update(request, env, termId, classId) {
  const body = await readJSON(request);
  const classes = await getJSON(env.SCHOOL_KV, keys.schedule(termId), []);
  const idx = classes.findIndex((c) => c.id === classId);
  if (idx === -1) return err("Class not found.", 404);

  classes[idx] = { ...classes[idx], ...body, id: classId };
  await putJSON(env.SCHOOL_KV, keys.schedule(termId), classes);
  return json({ class: classes[idx] });
}

export async function remove(request, env, termId, classId) {
  const classes = await getJSON(env.SCHOOL_KV, keys.schedule(termId), []);
  const next = classes.filter((c) => c.id !== classId);
  if (next.length === classes.length) return err("Class not found.", 404);
  await putJSON(env.SCHOOL_KV, keys.schedule(termId), next);
  await env.SCHOOL_KV.delete(keys.notes(classId));
  return json({ ok: true });
}
