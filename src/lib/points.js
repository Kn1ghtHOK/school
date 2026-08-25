// Gamification logic: points for on-time completion, streaks, and levels.
// Pure functions, no I/O — easy to test and safe to call from the Worker.

const DAY_MS = 24 * 60 * 60 * 1000;

export const LEVELS = [
  { min: 0, name: "Freshman Focus" },
  { min: 100, name: "Syllabus Survivor" },
  { min: 300, name: "Deadline Dodger" },
  { min: 700, name: "Honor Roll Hustler" },
  { min: 1500, name: "Dean's List Legend" },
  { min: 3000, name: "Valedictorian Vibes" },
];

export function levelForTotal(total) {
  let current = LEVELS[0];
  for (const lvl of LEVELS) {
    if (total >= lvl.min) current = lvl;
  }
  const idx = LEVELS.indexOf(current);
  const next = LEVELS[idx + 1] || null;
  return {
    name: current.name,
    next: next ? { name: next.name, pointsNeeded: next.min - total } : null,
  };
}

/**
 * Score a completion: how far ahead of the due date it happened.
 * @param {string|number|Date} dueDate
 * @param {string|number|Date} completedAt
 */
export function scoreCompletion(dueDate, completedAt) {
  const due = new Date(dueDate).getTime();
  const done = new Date(completedAt).getTime();
  const diff = due - done;
  if (diff >= 3 * DAY_MS) return { pts: 50, tag: "way_early", label: "Way ahead of schedule!" };
  if (diff >= 1 * DAY_MS) return { pts: 30, tag: "early", label: "Nice and early." };
  if (diff >= 0) return { pts: 15, tag: "on_time", label: "Done right on time." };
  return { pts: 5, tag: "late", label: "Better late than never." };
}

/** Recompute total + streak from a history array (chronological order). */
export function summarizeHistory(history) {
  const total = history.reduce((sum, h) => sum + h.pts, 0);
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].tag === "late") break;
    streak++;
  }
  return { total, streak, level: levelForTotal(total) };
}
