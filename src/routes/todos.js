import { json, err, readJSON } from "../lib/http.js";
import { getJSON, putJSON, newId, keys } from "../lib/store.js";
import { clampText, MAX_TITLE_LEN } from "../lib/validate.js";

// Deliberately not term-scoped — "buy a pen" or "return the field trip
// form" isn't tied to a semester the way classes and assignments are.

export async function list(request, env) {
  const todos = await getJSON(env.SCHOOL_KV, keys.todos(), []);
  return json({ todos });
}

export async function create(request, env) {
  const body = await readJSON(request);
  const title = clampText(body.title, MAX_TITLE_LEN).trim();
  if (!title) return err("title is required.", 400);

  const todos = await getJSON(env.SCHOOL_KV, keys.todos(), []);
  const todo = { id: newId(), title, done: false, createdAt: Date.now(), completedAt: null };
  todos.push(todo);
  await putJSON(env.SCHOOL_KV, keys.todos(), todos);
  return json({ todo }, 201);
}

export async function update(request, env, id) {
  const body = await readJSON(request);
  const todos = await getJSON(env.SCHOOL_KV, keys.todos(), []);
  const idx = todos.findIndex((t) => t.id === id);
  if (idx === -1) return err("To-do not found.", 404);

  const editable = {};
  if (body.title !== undefined) {
    const title = clampText(body.title, MAX_TITLE_LEN).trim();
    if (!title) return err("title cannot be empty.", 400);
    editable.title = title;
  }
  if (body.done !== undefined) {
    if (typeof body.done !== "boolean") return err("done must be true or false.", 400);
    editable.done = body.done;
    editable.completedAt = body.done ? Date.now() : null;
  }

  todos[idx] = { ...todos[idx], ...editable, id };
  await putJSON(env.SCHOOL_KV, keys.todos(), todos);
  return json({ todo: todos[idx] });
}

export async function remove(request, env, id) {
  const todos = await getJSON(env.SCHOOL_KV, keys.todos(), []);
  const next = todos.filter((t) => t.id !== id);
  if (next.length === todos.length) return err("To-do not found.", 404);
  await putJSON(env.SCHOOL_KV, keys.todos(), next);
  return json({ ok: true });
}
