import { json, err, readJSON } from "../lib/http.js";
import { getJSON, putJSON, newId, keys } from "../lib/store.js";

export async function list(request, env) {
  const terms = await getJSON(env.SCHOOL_KV, keys.terms(), []);
  const activeTermId = await getJSON(env.SCHOOL_KV, keys.activeTermId(), null);
  return json({ terms, activeTermId });
}

export async function create(request, env) {
  const body = await readJSON(request);
  if (!body.name || !body.startDate || !body.endDate) {
    return err("name, startDate, and endDate are required.", 400);
  }
  const terms = await getJSON(env.SCHOOL_KV, keys.terms(), []);
  const term = {
    id: newId(),
    name: String(body.name),
    startDate: body.startDate,
    endDate: body.endDate,
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

  terms[idx] = { ...terms[idx], ...body, id };
  await putJSON(env.SCHOOL_KV, keys.terms(), terms);
  return json({ term: terms[idx] });
}

export async function remove(request, env, id) {
  const terms = await getJSON(env.SCHOOL_KV, keys.terms(), []);
  const next = terms.filter((t) => t.id !== id);
  if (next.length === terms.length) return err("Term not found.", 404);

  await putJSON(env.SCHOOL_KV, keys.terms(), next);
  await env.SCHOOL_KV.delete(keys.schedule(id));
  await env.SCHOOL_KV.delete(keys.assignments(id));

  const activeTermId = await getJSON(env.SCHOOL_KV, keys.activeTermId(), null);
  if (activeTermId === id) {
    await putJSON(env.SCHOOL_KV, keys.activeTermId(), next[0]?.id || null);
  }

  return json({ ok: true });
}

export async function activate(request, env, id) {
  const terms = await getJSON(env.SCHOOL_KV, keys.terms(), []);
  if (!terms.some((t) => t.id === id)) return err("Term not found.", 404);
  await putJSON(env.SCHOOL_KV, keys.activeTermId(), id);
  return json({ ok: true, activeTermId: id });
}
