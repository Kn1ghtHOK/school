import { json, err, readJSON } from "../lib/http.js";
import { getJSON, putJSON, newId, keys } from "../lib/store.js";
import { isValidDate, clampText, MAX_TITLE_LEN } from "../lib/validate.js";

function validateDateRange(startDate, endDate) {
  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    return "startDate and endDate must be valid dates.";
  }
  if (new Date(startDate).getTime() > new Date(endDate).getTime()) {
    return "startDate must be on or before endDate.";
  }
  return null;
}

export async function list(request, env) {
  const terms = await getJSON(env.SCHOOL_KV, keys.terms(), []);
  const activeTermId = await getJSON(env.SCHOOL_KV, keys.activeTermId(), null);
  return json({ terms, activeTermId });
}

export async function create(request, env) {
  const body = await readJSON(request);
  const name = clampText(body.name, MAX_TITLE_LEN).trim();
  if (!name) return err("name is required.", 400);

  const rangeError = validateDateRange(body.startDate, body.endDate);
  if (rangeError) return err(rangeError, 400);

  const terms = await getJSON(env.SCHOOL_KV, keys.terms(), []);
  const term = {
    id: newId(),
    name,
    startDate: new Date(body.startDate).toISOString(),
    endDate: new Date(body.endDate).toISOString(),
    archived: false,
    createdAt: Date.now(),
  };
  terms.push(term);
  await putJSON(env.SCHOOL_KV, keys.terms(), terms);

  // First term created becomes active automatically.
  const activeTermId = await getJSON(env.SCHOOL_KV, keys.activeTermId(), null);
  if (!activeTermId) {
    await putJSON(env.SCHOOL_KV, keys.activeTermId(), term.id);
  }

  return json({ term }, 201);
}

export async function update(request, env, id) {
  const body = await readJSON(request);
  const terms = await getJSON(env.SCHOOL_KV, keys.terms(), []);
  const idx = terms.findIndex((t) => t.id === id);
  if (idx === -1) return err("Term not found.", 404);

  const editable = { ...body };
  if (editable.name !== undefined) {
    editable.name = clampText(editable.name, MAX_TITLE_LEN).trim();
    if (!editable.name) return err("name cannot be empty.", 400);
  }
  if (editable.startDate !== undefined || editable.endDate !== undefined) {
    const nextStart = editable.startDate ?? terms[idx].startDate;
    const nextEnd = editable.endDate ?? terms[idx].endDate;
    const rangeError = validateDateRange(nextStart, nextEnd);
    if (rangeError) return err(rangeError, 400);
    if (editable.startDate !== undefined) editable.startDate = new Date(editable.startDate).toISOString();
    if (editable.endDate !== undefined) editable.endDate = new Date(editable.endDate).toISOString();
  }
  if (editable.archived !== undefined && typeof editable.archived !== "boolean") {
    return err("archived must be true or false.", 400);
  }

  terms[idx] = { ...terms[idx], ...editable, id };
  await putJSON(env.SCHOOL_KV, keys.terms(), terms);

  // Archiving the currently-active term needs a new active term, same as deleting one.
  let activeTermId = await getJSON(env.SCHOOL_KV, keys.activeTermId(), null);
  if (editable.archived === true && activeTermId === id) {
    const fallback = terms.find((t) => t.id !== id && !t.archived);
    activeTermId = fallback?.id || null;
    await putJSON(env.SCHOOL_KV, keys.activeTermId(), activeTermId);
  }

  return json({ term: terms[idx], activeTermId });
}

export async function remove(request, env, id) {
  const terms = await getJSON(env.SCHOOL_KV, keys.terms(), []);
  const next = terms.filter((t) => t.id !== id);
  if (next.length === terms.length) return err("Term not found.", 404);

  await putJSON(env.SCHOOL_KV, keys.terms(), next);
  await env.SCHOOL_KV.delete(keys.schedule(id));
  await env.SCHOOL_KV.delete(keys.assignments(id));
  await env.SCHOOL_KV.delete(keys.daySchedule(id));

  const activeTermId = await getJSON(env.SCHOOL_KV, keys.activeTermId(), null);
  if (activeTermId === id) {
    const fallback = next.find((t) => !t.archived);
    await putJSON(env.SCHOOL_KV, keys.activeTermId(), fallback?.id || null);
  }

  return json({ ok: true });
}

export async function activate(request, env, id) {
  const terms = await getJSON(env.SCHOOL_KV, keys.terms(), []);
  const idx = terms.findIndex((t) => t.id === id);
  if (idx === -1) return err("Term not found.", 404);

  // Explicitly switching to a term means "make it current" — un-archive it
  // if needed rather than leaving it in a confusing archived-but-active state.
  if (terms[idx].archived) {
    terms[idx] = { ...terms[idx], archived: false };
    await putJSON(env.SCHOOL_KV, keys.terms(), terms);
  }

  await putJSON(env.SCHOOL_KV, keys.activeTermId(), id);
  return json({ ok: true, activeTermId: id, term: terms[idx] });
}
