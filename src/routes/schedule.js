import { json, err, readJSON } from "../lib/http.js";
import { getJSON, putJSON, newId, keys } from "../lib/store.js";

// A "class" is tied to a period label (e.g. "3", "WIN") rather than to
// specific weekdays/times directly. Which days it actually meets, and at
// what time, is derived from the term's day schedule (see dayschedule.js)
// — whichever weekdays include that period.

export async function list(request, env, termId) {
  const classes = await getJSON(env.SCHOOL_KV, keys.schedule(termId), []);
  return json({ classes });
}

export async function create(request, env, termId) {
  const body = await readJSON(request);
  if (!body.title || !String(body.period || "").trim()) {
    return err("title and period are required.", 400);
  }

  const classes = await getJSON(env.SCHOOL_KV, keys.schedule(termId), []);
  const cls = {
    id: newId(),
    title: String(body.title),
    period: String(body.period).trim(),
    instructor: body.instructor || "",
    location: body.location || "",
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
