import { json, err, readJSON } from "../lib/http.js";
import { getJSON, putJSON, newId, keys } from "../lib/store.js";
import { clampText, MAX_TITLE_LEN, normalizeClassColor, normalizeLinks } from "../lib/validate.js";

// A "class" is tied to a period label (e.g. "3", "WIN") rather than to
// specific weekdays/times directly. Which days it actually meets, and at
// what time, is derived from the term's day schedule (see dayschedule.js)
// — whichever weekdays include that period.

const MAX_PERIOD_LEN = 20;
const MAX_OFFICE_HOURS_LEN = 500;

export async function list(request, env, termId) {
  const classes = await getJSON(env.SCHOOL_KV, keys.schedule(termId), []);
  return json({ classes });
}

export async function create(request, env, termId) {
  const body = await readJSON(request);
  const title = clampText(body.title, MAX_TITLE_LEN).trim();
  const period = clampText(body.period, MAX_PERIOD_LEN).trim();
  if (!title) return err("title is required.", 400);
  if (!period) return err("period is required.", 400);

  const classes = await getJSON(env.SCHOOL_KV, keys.schedule(termId), []);

  const color = normalizeClassColor(body.color, classes.map((c) => c.color).filter(Boolean));
  if (color === false) return err("color must be one of class-1 … class-10.", 400);

  const links = normalizeLinks(body.links);
  if (links === false) return err("links must be a list of { label, url } with valid URLs.", 400);

  const cls = {
    id: newId(),
    title,
    period,
    color,
    instructor: clampText(body.instructor, MAX_TITLE_LEN),
    location: clampText(body.location, MAX_TITLE_LEN),
    officeHours: clampText(body.officeHours, MAX_OFFICE_HOURS_LEN),
    links: links || [],
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

  const editable = { ...body };
  if (editable.title !== undefined) {
    editable.title = clampText(editable.title, MAX_TITLE_LEN).trim();
    if (!editable.title) return err("title cannot be empty.", 400);
  }
  if (editable.period !== undefined) {
    editable.period = clampText(editable.period, MAX_PERIOD_LEN).trim();
    if (!editable.period) return err("period cannot be empty.", 400);
  }
  if (editable.instructor !== undefined) editable.instructor = clampText(editable.instructor, MAX_TITLE_LEN);
  if (editable.location !== undefined) editable.location = clampText(editable.location, MAX_TITLE_LEN);
  if (editable.officeHours !== undefined) editable.officeHours = clampText(editable.officeHours, MAX_OFFICE_HOURS_LEN);
  if (editable.color !== undefined) {
    const color = normalizeClassColor(editable.color, []);
    if (color === false) return err("color must be one of class-1 … class-10.", 400);
    editable.color = color;
  }
  if (editable.links !== undefined) {
    const links = normalizeLinks(editable.links);
    if (links === false) return err("links must be a list of { label, url } with valid URLs.", 400);
    editable.links = links;
  }

  classes[idx] = { ...classes[idx], ...editable, id: classId };
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
