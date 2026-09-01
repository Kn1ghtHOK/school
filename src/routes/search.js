import { json, err } from "../lib/http.js";
import { getJSON, keys } from "../lib/store.js";

const MAX_RESULTS_PER_TYPE = 25;

export async function search(request, env, termId) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  if (!q) return err("q is required.", 400);
  if (q.length < 2) return err("Search term must be at least 2 characters.", 400);

  const [classes, assignments] = await Promise.all([
    getJSON(env.SCHOOL_KV, keys.schedule(termId), []),
    getJSON(env.SCHOOL_KV, keys.assignments(termId), []),
  ]);

  // Class notes live in their own per-class KV entries, so pull them in
  // parallel rather than one at a time.
  const notesEntries = await Promise.all(
    classes.map(async (c) => [c.id, await getJSON(env.SCHOOL_KV, keys.notes(c.id), { content: "" })])
  );
  const notesByClassId = Object.fromEntries(notesEntries);

  const matchedClasses = classes
    .filter((c) => {
      const note = notesByClassId[c.id]?.content || "";
      return (
        c.title?.toLowerCase().includes(q) ||
        c.instructor?.toLowerCase().includes(q) ||
        c.location?.toLowerCase().includes(q) ||
        c.period?.toLowerCase().includes(q) ||
        note.toLowerCase().includes(q)
      );
    })
    .slice(0, MAX_RESULTS_PER_TYPE)
    .map((c) => ({ ...c, matchedInNotes: (notesByClassId[c.id]?.content || "").toLowerCase().includes(q) }));

  const matchedAssignments = assignments
    .filter((a) => a.title?.toLowerCase().includes(q) || a.notes?.toLowerCase().includes(q))
    .slice(0, MAX_RESULTS_PER_TYPE);

  return json({ classes: matchedClasses, assignments: matchedAssignments });
}
