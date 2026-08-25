import { json, readJSON } from "../lib/http.js";
import { getJSON, putJSON, keys } from "../lib/store.js";

export async function get(request, env, classId) {
  const note = await getJSON(env.SCHOOL_KV, keys.notes(classId), { content: "", updatedAt: null });
  return json({ note });
}

export async function put(request, env, classId) {
  const body = await readJSON(request);
  const note = { content: body.content || "", updatedAt: Date.now() };
  await putJSON(env.SCHOOL_KV, keys.notes(classId), note);
  return json({ note });
}
