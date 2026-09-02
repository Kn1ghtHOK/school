import { api, getToken, setToken } from "./api.js";
import { enablePush, disablePush, currentPushStatus, pushBlockedReason } from "./push.js";
import { parseSyllabusText } from "./syllabus-parser.js";
import { parse as nlParse, describeDraft, parseWithAssist } from "./nl-parse.js";

// ===========================================================
// State
// ===========================================================
const state = {
  terms: [],
  activeTermId: null,
  classes: [],
  assignments: [],
  daySchedule: {},
  periodTimes: {},
  todos: [],
  points: { total: 0, streak: 0, level: { name: "Freshman Focus", next: null } },
  settings: { reminderOffsetsMinutes: [1440, 60], theme: "system", passingPeriodMaxMinutes: 15, assignmentSort: "due", nlAssist: null },
  focus: { until: null },
  currentView: "today",
  classDetailId: null,
  classReturnHash: "schedule",
  assignFilter: "all", // "all" | "week" | "overdue" | a classId
  scheduleMode: "week", // "week" | "agenda"
  calCursor: startOfMonth(new Date()),
  calSelected: new Date(),
};

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = ["S", "M", "T", "W", "T", "F", "S"];

const CLASS_COLORS = ["class-1", "class-2", "class-3", "class-4", "class-5", "class-6", "class-7", "class-8", "class-9", "class-10"];
const BLOCK_GLYPH = { lunch: "🍽", win: "✦", advisory: "☕", break: "❖", activity: "◐" };
const BLOCK_LABELS = { lunch: "Lunch", win: "WIN", advisory: "Advisory", break: "Break", activity: "Activity" };
const SLOT_KINDS = ["class", "lunch", "win", "advisory", "break", "activity"];

/** CSS custom-property style string for a class-colored row, or "" if no color. */
function accentStyle(color) {
  return color && CLASS_COLORS.includes(color) ? ` style="--row-accent: var(--${color})"` : "";
}
/** Just the accent value (for composing into a larger style attr). */
function accentVar(color) {
  return color && CLASS_COLORS.includes(color) ? `var(--${color})` : "var(--text-tertiary)";
}

// Nav items — rendered into both the bottom tab bar (phone) and the left
// sidebar (wider / desktop windows). Declared here, above boot(), since
// boot() synchronously calls renderNav() before any await.
const NAV_ITEMS = [
  { view: "today", label: "Today", svg: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>` },
  { view: "schedule", label: "Schedule", svg: `<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 3v3M16 3v3"/>` },
  { view: "assignments", label: "Tasks", svg: `<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>`, dot: true },
  { view: "calendar", label: "Calendar", svg: `<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 10h18"/><path d="M8 2v4M16 2v4"/>` },
  { view: "focus", label: "Focus", svg: `<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>` },
  {
    view: "settings",
    label: "More",
    svg: `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 005 16.4a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 10a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 008 5.6a1.65 1.65 0 001-1.51V4a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9c.14.36.22.75.22 1.15"/>`,
  },
];

let focusTimer = null;
let wakeLock = null;

// ===========================================================
// Boot
// ===========================================================
boot();

async function boot() {
  registerServiceWorker();
  applyTheme();
  window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", applyTheme);

  wireAuthForms();
  wireTabbar();
  wireTopbar();
  wireFab();
  wireScheduleView();
  wireAssignmentsView();
  wireCalendarView();
  wireFocusView();
  wireSettingsView();
  wireClassDetailView();
  window.addEventListener("hashchange", handleHashRoute);
  window.addEventListener("schoolapp:auth-expired", handleAuthExpired);

  const authStatus = await api.authStatus().catch(() => ({ hasPasscode: false }));

  if (getToken()) {
    try {
      await loadAll();
      showApp();
      handleHashRoute();
    } catch (e) {
      // If the token's still set, api.js didn't clear it — so this wasn't
      // a real auth failure, just a failed request (offline, server hiccup).
      // Fall back to the last synced snapshot rather than stranding the
      // user at a login screen when they still have valid data to show.
      const cached = getToken() ? loadCache() : null;
      if (cached) {
        Object.assign(state, cached);
        showApp();
        renderAll();
        handleHashRoute();
        toast("You're offline — showing your last synced data.", { ms: 4000 });
      } else {
        showAuth(authStatus.hasPasscode);
        if (getToken()) toast("Couldn't load your data. Check your connection and reload.", { ms: 5000 });
      }
    }
  } else {
    showAuth(authStatus.hasPasscode);
  }

  setInterval(tickClock, 15000);
  tickClock();
}

function handleAuthExpired() {
  closeSheet();
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* non-critical */
  }
  showAuth(true); // a session only expires if a passcode already existed
  toast("You've been signed out — log in again.", { ms: 4000 });
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
    // Bonus path: on browsers that support notification action buttons
    // (not Safari, as of this writing), the service worker delegates a
    // tapped "Snooze" action to whichever app window is already open,
    // since only the page — not the service worker — has the auth token.
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "snooze") handleSnoozeMessage(event.data);
    });
  }
}

async function handleSnoozeMessage({ action, assignmentId, termId }) {
  if (!assignmentId || !termId) return;
  const until = action === "snooze-1h" ? new Date(Date.now() + 3600000).toISOString() : tomorrowMorning().toISOString();
  try {
    await api.snoozeAssignment(termId, assignmentId, until);
    toast(action === "snooze-1h" ? "Reminders snoozed for 1 hour." : "Reminders snoozed until tomorrow morning.");
  } catch (e) {
    toast(e?.message || "Couldn't snooze that — open the assignment to try again.", { ms: 4500 });
  }
}

// ===========================================================
// Auth
// ===========================================================
function showAuth(hasPasscode) {
  document.getElementById("auth-screen").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
  document.getElementById(hasPasscode ? "auth-login" : "auth-setup").classList.remove("hidden");
  document.getElementById(hasPasscode ? "auth-setup" : "auth-login").classList.add("hidden");
}

function showApp() {
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
}

function wireAuthForms() {
  document.getElementById("setup-submit").addEventListener("click", async () => {
    const passcode = document.getElementById("setup-passcode").value;
    setAuthError("");
    try {
      const { token } = await api.setup(passcode);
      setToken(token);
      await loadAll();
      showApp();
      handleHashRoute();
    } catch (e) {
      setAuthError(e.message);
    }
  });

  document.getElementById("login-submit").addEventListener("click", async () => {
    const passcode = document.getElementById("login-passcode").value;
    setAuthError("");
    try {
      const { token } = await api.login(passcode);
      setToken(token);
      await loadAll();
      showApp();
      handleHashRoute();
    } catch (e) {
      setAuthError(e.message);
    }
  });

  ["setup-passcode", "login-passcode"].forEach((id) => {
    document.getElementById(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById(id === "setup-passcode" ? "setup-submit" : "login-submit").click();
    });
  });
}

function setAuthError(msg) {
  document.getElementById("auth-error").textContent = msg || "";
}

// ===========================================================
// Data loading
// ===========================================================
async function loadAll() {
  const [{ terms, activeTermId }, points, settings, focus, { todos }] = await Promise.all([
    api.listTerms(),
    api.getPoints(),
    api.getSettings(),
    api.getFocus(),
    api.listTodos(),
  ]);
  state.terms = terms;
  state.activeTermId = activeTermId;
  state.points = points;
  state.settings = settings.settings;
  state.focus = focus.focus;
  state.todos = todos;

  await loadTermScopedData();
  renderAll();
  syncFocusFromServer();
  showCatchUpToast();
}

async function loadTermScopedData() {
  if (!state.activeTermId) {
    state.classes = [];
    state.assignments = [];
    state.daySchedule = {};
    state.periodTimes = {};
    return;
  }
  const [{ classes }, { assignments }, { daySchedule, periodTimes }] = await Promise.all([
    api.listClasses(state.activeTermId),
    api.listAssignments(state.activeTermId),
    api.getDaySchedule(state.activeTermId),
  ]);
  state.classes = classes;
  state.assignments = assignments;
  state.daySchedule = daySchedule;
  state.periodTimes = periodTimes || {};
}

/** "While you were away" — a one-time nudge on open for anything that became due/overdue since last time. */
function showCatchUpToast() {
  const now = new Date();
  const overdue = state.assignments.filter((a) => a.status !== "done" && new Date(a.dueDate) < now);
  const dueSoon = state.assignments.filter((a) => {
    if (a.status === "done") return false;
    const diff = new Date(a.dueDate).getTime() - now.getTime();
    return diff > 0 && diff <= 2 * 60 * 60 * 1000; // due within 2 hours
  });
  const count = overdue.length + dueSoon.length;
  if (count === 0) return;

  const label =
    overdue.length > 0
      ? `${count} thing${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} attention while you were away`
      : `${count} thing${count === 1 ? "" : "s"} due soon`;
  toast(label, { ms: 6000, action: { label: "View", onClick: () => (location.hash = "assignments") } });
}

function activeTerm() {
  return state.terms.find((t) => t.id === state.activeTermId) || null;
}

function classById(id) {
  return state.classes.find((c) => c.id === id) || null;
}

function classByPeriod(periodLabel) {
  return state.classes.find((c) => c.period === periodLabel) || null;
}

function slotKind(slot) {
  return slot.kind && SLOT_KINDS.includes(slot.kind) ? slot.kind : "class";
}

/** Ordered list of raw slots for a weekday, or [] if no school that day / not configured yet. */
function periodsForWeekday(dow) {
  const day = state.daySchedule[String(dow)];
  return Array.isArray(day) ? day : [];
}

/**
 * This weekday's slots in time order. Class slots get `.cls` (their matched
 * class or null); non-class blocks (lunch/WIN/…) get `.isBlock` and a `.label`.
 */
function scheduleForWeekday(dow) {
  return periodsForWeekday(dow)
    .map((slot) => {
      const kind = slotKind(slot);
      if (kind === "class") return { ...slot, kind, cls: classByPeriod(slot.period), isBlock: false };
      return { ...slot, kind, cls: null, isBlock: true, label: slot.label || BLOCK_LABELS[kind] || "Block" };
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** All distinct CLASS period labels currently defined anywhere in the day schedule, in first-seen order. */
function knownPeriodLabels() {
  const seen = [];
  for (const dow of DAY_ORDER) {
    for (const slot of periodsForWeekday(dow)) {
      if (slotKind(slot) === "class" && !seen.includes(slot.period)) seen.push(slot.period);
    }
  }
  return seen;
}

/** Weekdays (Mon-first) a given class period meets, with the slot's times. */
function meetingsForPeriod(periodLabel) {
  const out = [];
  for (const dow of DAY_ORDER) {
    const slot = periodsForWeekday(dow).find((s) => slotKind(s) === "class" && s.period === periodLabel);
    if (slot) out.push({ dow, start: slot.start, end: slot.end });
  }
  return out;
}

// ===========================================================
// Render orchestration
// ===========================================================
function renderAll() {
  renderTopbar();
  renderToday();
  renderSchedule();
  renderAssignments();
  renderCalendar();
  renderFocus();
  renderSettings();
  if (state.currentView === "class" && state.classDetailId) renderClassDetail();
  persistCache();
}

// ===========================================================
// Offline cache — a snapshot of the last successfully synced state, so
// the app still shows real data (not a dead login screen) when opened
// without a connection. Never used for writes — only for viewing while
// offline; any edit attempt still needs a live connection and will
// surface a clear "you're offline" message via the API layer.
// ===========================================================
const CACHE_KEY = "schoolapp_cache_v1";

function persistCache() {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        terms: state.terms,
        activeTermId: state.activeTermId,
        classes: state.classes,
        assignments: state.assignments,
        daySchedule: state.daySchedule,
        periodTimes: state.periodTimes,
        points: state.points,
        settings: state.settings,
        cachedAt: Date.now(),
      })
    );
  } catch {
    // Storage full or unavailable (e.g. private browsing) — caching is a
    // nice-to-have, never load-bearing, so just skip it silently.
  }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function renderTopbar() {
  const term = activeTerm();
  document.getElementById("term-switch-label").textContent = term ? term.name : "Add a term";
  document.getElementById("level-name").textContent = state.points.level.name;
  document.getElementById("level-points").textContent = state.points.total;

  const dueToday = state.assignments.filter((a) => a.status !== "done" && isSameDay(new Date(a.dueDate), new Date())).length;
  const overdue = state.assignments.filter((a) => a.status !== "done" && new Date(a.dueDate) < new Date()).length;
  document.querySelectorAll(".tasks-dot").forEach((d) => d.classList.toggle("hidden", dueToday + overdue === 0));
}

// ===========================================================
// Navigation — one set of items rendered into both the bottom
// tab bar (phone) and the left sidebar (wider / desktop windows)
// ===========================================================
function navButtonHTML(item) {
  return `<button class="nav-item" data-view="${item.view}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${item.svg}</svg>
    <span>${item.label}</span>
    ${item.dot ? `<span class="dot tasks-dot hidden"></span>` : ""}
  </button>`;
}

function renderNav() {
  document.getElementById("tabbar").innerHTML = NAV_ITEMS.map(navButtonHTML).join("");
  const sidebar = document.getElementById("sidebar");
  sidebar.querySelectorAll(".nav-item").forEach((b) => b.remove());
  sidebar.insertAdjacentHTML("beforeend", NAV_ITEMS.map(navButtonHTML).join(""));
}

// ===========================================================
// Tabbar / view switching
// ===========================================================
function wireTabbar() {
  renderNav();
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      location.hash = btn.dataset.view;
    });
  });
}

function handleHashRoute() {
  const hash = location.hash.replace("#", "");
  if (hash.startsWith("assignment/")) {
    switchView("assignments");
    const id = hash.split("/")[1];
    const a = state.assignments.find((x) => x.id === id);
    if (a) openAssignmentSheet(a);
    return;
  }
  if (hash.startsWith("class/")) {
    const id = hash.split("/")[1];
    if (classById(id)) {
      state.classDetailId = id;
      switchView("class");
      renderClassDetail();
    } else {
      switchView("schedule");
    }
    return;
  }
  const known = ["today", "schedule", "assignments", "calendar", "focus", "settings"];
  switchView(known.includes(hash) ? hash : "today");
}

function switchView(name) {
  state.currentView = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  // Detail views have no tab of their own — light up the tab they belong under.
  const litTab = name === "class" ? "schedule" : name;
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === litTab));
  try {
    const se = document.scrollingElement || document.documentElement;
    if (se) se.scrollTop = 0;
  } catch {
    /* non-critical */
  }
}

function wireFab() {
  document.getElementById("topbar-add").addEventListener("click", () => openOmnibox());
}

/** Navigate to a class's home page, remembering where we came from for the back button. */
function goToClass(id) {
  const from = location.hash.replace("#", "") || "today";
  if (!from.startsWith("class/") && !from.startsWith("assignment/")) state.classReturnHash = from;
  location.hash = "class/" + id;
}

// ===========================================================
// Sheets (modal bottom sheets)
// ===========================================================
function openSheet(innerHTML, { onMount } = {}) {
  const root = document.getElementById("sheet-root");
  root.innerHTML = `
    <div class="sheet-backdrop" id="sheet-backdrop">
      <div class="sheet" role="dialog" aria-modal="true">
        <div class="sheet-handle"></div>
        ${innerHTML}
      </div>
    </div>`;
  document.getElementById("sheet-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "sheet-backdrop") closeSheet();
  });
  onMount?.(root);
}

function closeSheet() {
  document.getElementById("sheet-root").innerHTML = "";
}

// ===========================================================
// Omnibox — one text field that creates an assignment, a to-do,
// or a class, deciding from what you typed. Falls back to the
// relevant sheet (pre-filled) whenever the parse is unsure.
// ===========================================================
function openOmnibox() {
  openSheet(
    `
    <h2>Add anything</h2>
    <input type="text" class="omni-input" id="omni-input" placeholder="e.g. “Essay for Bio due Fri 5pm !”" autocomplete="off" />
    <div class="omni-preview" id="omni-preview">Type an assignment, a to-do, or a class.</div>
    <button class="btn primary block mt-16" id="omni-go">Add</button>
    <div class="omni-hints">
      Assignment — “read ch 4 tomorrow ~2h”, “pset for calc due monday, weekly until dec 12”<br />
      To-do — “bring goggles”, “return the field trip form”<br />
      Class — “AP Bio p3 with Dr. Lee in room 214”
    </div>
  `,
    {
      onMount: (root) => {
        const input = root.querySelector("#omni-input");
        const preview = root.querySelector("#omni-preview");
        input.focus();
        const refresh = () => {
          const text = input.value.trim();
          if (!text) {
            preview.textContent = "Type an assignment, a to-do, or a class.";
            return;
          }
          const res = nlParse(text, { now: new Date(), term: activeTerm(), classes: state.classes });
          preview.innerHTML = `<strong>${escapeHtml(describeDraft(res, { classes: state.classes }))}</strong>`;
        };
        input.addEventListener("input", refresh);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") root.querySelector("#omni-go").click();
        });
        root.querySelector("#omni-go").addEventListener("click", guarded(() => runCapture(input.value)));
      },
    }
  );
}

/** Shared entry point for the omnibox and the Assignments quick-add field. */
async function runCapture(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return;
  const ctx = { now: new Date(), term: activeTerm(), classes: state.classes };
  let res = nlParse(text, ctx);
  if (res.confidence === "low" && state.settings.nlAssist) {
    const assisted = await parseWithAssist(text, ctx, state.settings.nlAssist).catch(() => null);
    if (assisted) res = { confidence: "low", ...assisted };
  }

  if (res.kind === "todo") {
    if (!res.draft.title) return;
    const { todo } = await api.createTodo(res.draft.title);
    state.todos.push(todo);
    renderTodos();
    closeSheet();
    toast(`Added to-do — “${todo.title}”`, {
      action: {
        label: "Undo",
        onClick: guarded(async () => {
          await api.deleteTodo(todo.id);
          state.todos = state.todos.filter((t) => t.id !== todo.id);
          renderTodos();
        }),
      },
    });
    return;
  }

  if (!state.activeTermId) {
    closeSheet();
    toast("Add a term first — then you can add classes and assignments.");
    return openTermSheet(null);
  }

  if (res.kind === "class") {
    if (res.confidence === "low" || !res.draft.title || !res.draft.period) {
      closeSheet();
      return openClassSheet(null, { prefill: res.draft });
    }
    const termId = state.activeTermId;
    const { class: cls } = await api.createClass(termId, {
      title: res.draft.title,
      period: res.draft.period,
      instructor: res.draft.instructor || "",
      location: res.draft.location || "",
    });
    await refreshTermScoped();
    closeSheet();
    toast(`Added class — “${cls.title}”`, {
      action: {
        label: "Undo",
        onClick: guarded(async () => {
          await api.deleteClass(termId, cls.id);
          if (state.activeTermId === termId) await refreshTermScoped();
        }),
      },
    });
    return;
  }

  // assignment
  if (res.confidence === "low" || !res.draft.dueDate) {
    closeSheet();
    return openAssignmentSheet(null, { prefill: res.draft });
  }
  closeSheet();
  await createAssignmentFromDraft(res.draft, { toastEdit: true });
}

/** Turn an assignment draft (from nl-parse) into one or more real assignments. */
async function createAssignmentFromDraft(draft, { toastEdit = false } = {}) {
  const payload = {
    title: draft.title,
    classId: draft.classId || null,
    dueDate: draft.dueDate.toISOString(),
    priority: draft.priority || "medium",
    estimatedMinutes: draft.estimatedMinutes || null,
    link: draft.link || null,
  };
  if (draft.repeat) {
    const term = activeTerm();
    const until = draft.repeat.until || (term ? new Date(term.endDate) : new Date(draft.dueDate.getTime() + 8 * 7 * 86400000));
    await createWeeklyRepeats(payload, draft.dueDate, until);
    await refreshTermScoped();
    return;
  }
  const { assignment } = await api.createAssignment(state.activeTermId, payload);
  await refreshTermScoped();
  const due = draft.dueDate;
  toast(`Added — due ${due.toLocaleDateString([], { month: "short", day: "numeric" })} ${due.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`, {
    action: toastEdit
      ? { label: "Edit", onClick: () => openAssignmentSheet(state.assignments.find((a) => a.id === assignment.id) || assignment) }
      : undefined,
  });
}

/** Reload the current term's classes/assignments/schedule and re-render, tolerating a transient failure. */
async function refreshTermScoped() {
  try {
    await loadTermScopedData();
    renderAll();
  } catch {
    toast("Saved, but couldn't refresh the view — switch tabs to reload.", { ms: 5000 });
  }
}

// ===========================================================
// Toasts
// ===========================================================
/**
 * Optimistic delete with an undo window: the caller has already removed
 * the item from local state and re-rendered before calling this. If the
 * user doesn't tap Undo within the window, the real delete is committed;
 * if it fails, the item is restored locally so the UI never drifts from
 * what's actually saved.
 */
/** Wrap an async event handler so a failure shows a toast instead of throwing unhandled and leaving the UI stuck. */
function guarded(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      toast(e?.message || "Something went wrong. Please try again.", { ms: 4500 });
    }
  };
}

function scheduleDelete(label, commitFn, restoreFn, { undoMs = 6000, onCommitted } = {}) {  let undone = false;
  toast(`Deleted "${label}"`, {
    ms: undoMs,
    action: {
      label: "Undo",
      onClick: () => {
        undone = true;
        restoreFn();
      },
    },
  });
  setTimeout(async () => {
    if (undone) return;
    try {
      await commitFn();
      await onCommitted?.();
    } catch (e) {
      restoreFn();
      toast(`Couldn't delete "${label}" — it's back. ${e.message || ""}`.trim(), { ms: 5000 });
    }
  }, undoMs);
}

/**
 * @param {string} message
 * @param {{celebrate?: boolean, ms?: number, action?: {label: string, onClick: () => void}}} [opts]
 */
function toast(message, { celebrate = false, ms = 2800, action } = {}) {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = `toast${celebrate ? " celebrate" : ""}`;

  const text = document.createElement("span");
  text.textContent = message;
  el.appendChild(text);

  let timer;
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      clearTimeout(timer);
      el.remove();
      action.onClick();
    });
    el.appendChild(btn);
  }

  root.appendChild(el);
  timer = setTimeout(() => el.remove(), ms);
}

// ===========================================================
// Clock
// ===========================================================
function tickClock() {
  const now = new Date();
  const timeEl = document.getElementById("clock-time");
  const dateEl = document.getElementById("clock-date");
  if (timeEl) timeEl.textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (dateEl) dateEl.textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  // Keep the "now / next" strip live between full re-renders.
  if (state.currentView === "today") renderNowNext();
}

// ===========================================================
// Helpers: dates & formatting
// ===========================================================
function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function timeStrToLabel(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function dueLabel(dueDate) {
  const d = new Date(dueDate);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const dayLabel = isSameDay(d, now)
    ? "Today"
    : isSameDay(d, new Date(now.getTime() + 86400000))
    ? "Tomorrow"
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
  const timeLabel = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const overdue = diffMs < 0;
  return { text: `${dayLabel}, ${timeLabel}`, overdue };
}
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ===========================================================
// TODAY view
// ===========================================================
function renderToday() {
  const classesEl = document.getElementById("today-classes");
  const upcomingEl = document.getElementById("today-upcoming");

  renderOnboarding();
  renderNowNext();

  if (!state.activeTermId) {
    classesEl.innerHTML = emptyState("📚", "No term yet", "Add a term in Settings to start building your schedule.");
    upcomingEl.innerHTML = "";
    document.getElementById("stat-classes-today").textContent = "0";
    document.getElementById("stat-due-today").textContent = "0";
    document.getElementById("stat-overdue").textContent = "0";
    document.getElementById("do-next-wrap").classList.add("hidden");
    renderHeatmap();
    return;
  }

  const todayDow = new Date().getDay();
  const slots = scheduleForWeekday(todayDow);
  const classCount = slots.filter((s) => s.cls).length;

  if (slots.length) {
    const gaps = computeGaps(slots);
    let html = "";
    slots.forEach((s, i) => {
      html += slotRow(s);
      const gap = gaps.find((g) => g.afterIndex === i);
      if (gap) html += gap.passing ? passingStrip(gap) : freePeriodRow(gap);
    });
    classesEl.innerHTML = html;
  } else {
    classesEl.innerHTML = emptyState("☀️", "No school today", "Nothing on the bell schedule for today.");
  }
  classesEl.querySelectorAll("[data-free-period]").forEach((row) => {
    row.addEventListener("click", () => {
      const minutes = Number(row.dataset.freePeriod);
      focusMinutesSetting = Math.max(5, Math.min(180, minutes));
      location.hash = "focus";
      renderFocus();
      toast(`Focus timer set to ${formatMinutes(focusMinutesSetting)} for this gap.`);
    });
  });

  const pending = state.assignments.filter((a) => a.status !== "done").sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  const upcoming = pending.slice(0, 6);
  upcomingEl.innerHTML = upcoming.length
    ? upcoming.map((a, i) => assignmentFlapRow(a, i)).join("")
    : emptyState("🎉", "Nothing due", "You're all caught up.");

  const doNextWrap = document.getElementById("do-next-wrap");
  const nextUp = pickNextAssignment(pending);
  if (nextUp) {
    doNextWrap.classList.remove("hidden");
    document.getElementById("do-next-card").innerHTML = assignmentFlapRow(nextUp);
    bindFlapRowClicks(document.getElementById("do-next-card"));
  } else {
    doNextWrap.classList.add("hidden");
  }

  document.getElementById("stat-classes-today").textContent = classCount;
  document.getElementById("stat-due-today").textContent = pending.filter((a) => isSameDay(new Date(a.dueDate), new Date())).length;
  document.getElementById("stat-overdue").textContent = pending.filter((a) => new Date(a.dueDate) < new Date()).length;

  renderHeatmap();
  bindFlapRowClicks(classesEl, upcomingEl);
}

/** The live "Now / Next" strip at the top of Today. Recomputed every clock tick. */
function renderNowNext() {
  const el = document.getElementById("now-next");
  if (!el) return;
  const now = new Date();
  if (!state.activeTermId) return void (el.innerHTML = "");
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const slots = scheduleForWeekday(now.getDay()).map((s) => ({
    ...s,
    sMin: timeStrToMinutes(s.start),
    eMin: timeStrToMinutes(s.end),
  }));

  const slotName = (s) => (s.isBlock ? s.label : s.cls ? s.cls.title : `Period ${s.period}`);
  const cardHTML = ({ kind, title, sub, cls, pct, mod }) => {
    const accent = cls && cls.color ? ` style="--row-accent: var(--${cls.color})"` : "";
    return `<div class="now-card ${mod || ""}"${accent}>
      <div class="now-accent"></div>
      <div class="kicker">${kind}</div>
      <div class="now-title">${escapeHtml(title)}</div>
      ${sub ? `<div class="now-sub">${escapeHtml(sub)}</div>` : ""}
      ${typeof pct === "number" ? `<div class="now-progress"><i style="width:${Math.max(2, Math.min(100, pct))}%"></i></div>` : ""}
    </div>`;
  };

  const cards = [];
  const current = slots.find((s) => nowMin >= s.sMin && nowMin < s.eMin);
  const next = slots.filter((s) => s.sMin > nowMin).sort((a, b) => a.sMin - b.sMin)[0];
  const threshold = Number(state.settings.passingPeriodMaxMinutes) || 15;

  if (current) {
    const left = current.eMin - nowMin;
    cards.push(
      cardHTML({
        kind: "Now",
        title: slotName(current),
        sub: `${left} min left · until ${timeStrToLabel(current.end)}${current.cls?.location ? " · " + current.cls.location : ""}`,
        cls: current.cls,
        pct: ((nowMin - current.sMin) / (current.eMin - current.sMin)) * 100,
      })
    );
    if (next) cards.push(cardHTML({ kind: "Next", title: slotName(next), sub: `at ${timeStrToLabel(next.start)}`, cls: next.cls }));
  } else if (next) {
    const gap = next.sMin - nowMin;
    const hadEarlier = slots.some((s) => s.eMin <= nowMin);
    if (hadEarlier && gap <= threshold) {
      cards.push(
        cardHTML({
          kind: "Passing",
          mod: "passing",
          title: `${gap} min → ${slotName(next)}${next.cls?.location ? " · " + next.cls.location : ""}`,
        })
      );
    } else {
      cards.push(
        cardHTML({
          kind: "Next",
          mod: "gap",
          title: slotName(next),
          sub: `at ${timeStrToLabel(next.start)}${gap < 120 ? ` · in ${gap} min` : ""}`,
          cls: next.cls,
        })
      );
    }
  } else if (slots.length) {
    const tm = firstClassOnUpcomingDay(now);
    cards.push(
      cardHTML({
        kind: "Done for the day",
        mod: "done",
        title: tm ? `${tm.dayLabel}: first up ${tm.name} at ${timeStrToLabel(tm.start)}` : "Nothing left today",
      })
    );
  }
  el.innerHTML = cards.join("");
}

/** Look ahead up to a week for the next day that has a class slot. */
function firstClassOnUpcomingDay(from) {
  for (let i = 1; i <= 7; i++) {
    const d = new Date(from.getTime() + i * 86400000);
    const slots = scheduleForWeekday(d.getDay());
    const firstClass = slots.find((s) => !s.isBlock);
    if (firstClass) {
      return {
        dayLabel: i === 1 ? "Tomorrow" : DAY_NAMES[d.getDay()],
        name: firstClass.cls ? firstClass.cls.title : `Period ${firstClass.period}`,
        start: firstClass.start,
      };
    }
  }
  return null;
}

/** Highest-urgency × priority pending assignment — a single actionable suggestion, not just the soonest due date. */
function pickNextAssignment(pending) {
  if (pending.length === 0) return null;
  const now = Date.now();
  const priorityWeight = { high: 3, medium: 2, low: 1 };
  let best = null;
  let bestScore = -Infinity;
  for (const a of pending) {
    const hoursUntilDue = (new Date(a.dueDate).getTime() - now) / 3600000;
    let urgency;
    if (hoursUntilDue <= 0) urgency = 5;
    else if (hoursUntilDue <= 24) urgency = 4;
    else if (hoursUntilDue <= 72) urgency = 3;
    else if (hoursUntilDue <= 168) urgency = 2;
    else urgency = 1;
    const score = urgency * 10 + (priorityWeight[a.priority] || 2);
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best;
}

function timeStrToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Gaps between consecutive slots. A gap shorter than the passing-period
 * threshold is marked `.passing` (rendered as a thin strip); a longer one
 * is a free period offered as a focus-timer slot.
 */
function computeGaps(slots) {
  const threshold = Number(state.settings.passingPeriodMaxMinutes) || 15;
  const gaps = [];
  for (let i = 0; i < slots.length - 1; i++) {
    const gapMin = timeStrToMinutes(slots[i + 1].start) - timeStrToMinutes(slots[i].end);
    if (gapMin > 0) {
      gaps.push({ afterIndex: i, start: slots[i].end, end: slots[i + 1].start, minutes: gapMin, passing: gapMin < threshold });
    }
  }
  return gaps;
}

function passingStrip(gap) {
  return `<div class="passing-strip">${gap.minutes} min passing</div>`;
}

function freePeriodRow(gap) {
  return `<div class="list-row free-period-row" data-free-period="${gap.minutes}">
    <div class="row-time rounded">${timeStrToLabel(gap.start)}</div>
    <div class="row-body">
      <div class="row-title" style="color:var(--text-tertiary);">Free period · ${formatMinutes(gap.minutes)}</div>
      <div class="row-sub">Tap to set a focus timer for this gap</div>
    </div>
  </div>`;
}

/** A schedule list row for any slot — a class, an empty class period, or a named block. */
function slotRow(s) {
  if (!s.isBlock) return classFlapRow(s);
  return `<div class="list-row block-row">
    <div class="row-time rounded">${timeStrToLabel(s.start)}</div>
    <div class="row-body">
      <div class="row-title">${BLOCK_GLYPH[s.kind] || "•"} ${escapeHtml(s.label)}</div>
    </div>
  </div>`;
}

function renderHeatmap() {
  const el = document.getElementById("workload-heatmap");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const DEFAULT_MINUTES = 30; // assumed effort for items with no estimate, so the heatmap still means something
  let html = "";
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    const dayAssignments = state.assignments.filter((a) => a.status !== "done" && isSameDay(new Date(a.dueDate), d));
    const totalMinutes = dayAssignments.reduce((sum, a) => sum + (a.estimatedMinutes || DEFAULT_MINUTES), 0);
    const level = totalMinutes === 0 ? 0 : totalMinutes <= 45 ? 1 : totalMinutes <= 120 ? 2 : 3;
    const label = totalMinutes === 0 ? "" : totalMinutes < 60 ? `${totalMinutes}m` : `${Math.round((totalMinutes / 60) * 10) / 10}h`;
    html += `<div class="col">
      <div class="day-label">${DAY_SHORT[d.getDay()]}</div>
      <div class="cell${i === 0 ? " today" : ""}" data-level="${level}" title="${dayAssignments.length} thing${dayAssignments.length === 1 ? "" : "s"} due">${label}</div>
    </div>`;
  }
  el.innerHTML = html;
}

function emptyState(glyph, title, sub) {
  return `<div class="empty-state"><div class="glyph">${glyph}</div><p><strong>${escapeHtml(title)}</strong></p><p>${escapeHtml(sub)}</p></div>`;
}

const CHEVRON_SVG = `<svg viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l6 6-6 6"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>`;
const CLOSE_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
const LINK_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 9.5L9.5 6.5"/><path d="M7 4.5L8.3 3.2a2.4 2.4 0 013.4 3.4L9.5 8"/><path d="M9 11.5L7.7 12.8a2.4 2.4 0 01-3.4-3.4L5.5 8"/></svg>`;

function formatMinutes(min) {
  if (min < 60) return `${min} min`;
  const hours = Math.round((min / 60) * 10) / 10;
  return `${hours} hr`;
}

function classFlapRow(slot) {
  const timeLabel = timeStrToLabel(slot.start);
  if (!slot.cls) {
    return `<div class="list-row" data-empty-period="${escapeHtml(slot.period)}">
      <div class="row-time rounded">${timeLabel}</div>
      <div class="row-body">
        <div class="row-title" style="color:var(--text-tertiary)">Period ${escapeHtml(slot.period)} — tap to add a class</div>
      </div>
      <span class="chevron">${CHEVRON_SVG}</span>
    </div>`;
  }
  const c = slot.cls;
  return `<div class="list-row" data-class-id="${c.id}"${accentStyle(c.color)}>
    <div class="row-time rounded">${timeLabel}</div>
    <div class="row-body">
      <div class="row-title">${escapeHtml(c.title)}</div>
      <div class="row-sub">${escapeHtml(c.location || c.instructor || `Period ${slot.period}`)}</div>
    </div>
    <span class="chevron">${CHEVRON_SVG}</span>
  </div>`;
}

function assignmentFlapRow(a) {
  const cls = a.classId ? classById(a.classId) : null;
  const due = dueLabel(a.dueDate);
  const overdue = due.overdue && a.status !== "done";
  const effortLabel = a.estimatedMinutes ? ` · ${formatMinutes(a.estimatedMinutes)}` : "";
  const linkIcon = a.link ? ` <span class="row-link-icon">${LINK_SVG}</span>` : "";
  return `<div class="list-row assignment-row${a.status === "done" ? " done" : ""}" data-assignment-id="${a.id}"${accentStyle(cls?.color)}>
    <button class="check" data-toggle-complete="${a.id}" aria-label="Mark complete">${CHECK_SVG}</button>
    <div class="row-body">
      <div class="row-title"><span class="priority-dot priority-${a.priority}"></span>${escapeHtml(a.title)}${linkIcon}</div>
      <div class="row-sub${overdue ? " overdue" : ""}">${cls ? escapeHtml(cls.title) + " · " : ""}${due.text}${effortLabel}</div>
    </div>
  </div>`;
}

function bindFlapRowClicks(...containers) {
  containers.forEach((container) => {
    container.querySelectorAll("[data-class-id]").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-toggle-complete]")) return;
        goToClass(row.dataset.classId);
      });
    });
    container.querySelectorAll("[data-empty-period]").forEach((row) => {
      row.addEventListener("click", () => openClassSheet(null, { prefillPeriod: row.dataset.emptyPeriod }));
    });
    container.querySelectorAll("[data-assignment-id]").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest("[data-toggle-complete]")) return;
        const a = state.assignments.find((x) => x.id === row.dataset.assignmentId);
        if (a) openAssignmentSheet(a);
      });
    });
    container.querySelectorAll("[data-toggle-complete]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleComplete(btn.dataset.toggleComplete);
      });
    });
  });
}

async function toggleComplete(id) {
  const a = state.assignments.find((x) => x.id === id);
  if (!a) return false;
  try {
    if (a.status === "done") {
      const res = await api.uncompleteAssignment(state.activeTermId, id);
      Object.assign(a, res.assignment);
      state.points = { total: res.total, streak: res.streak, level: res.level };
    } else {
      const res = await api.completeAssignment(state.activeTermId, id);
      Object.assign(a, res.assignment);
      state.points = { total: res.total, streak: res.streak, level: res.level };
      toast(`+${res.assignment.pointsAwarded} pts — ${res.scoreLabel}${res.streak > 1 ? ` 🔥 ${res.streak} in a row` : ""}`, { celebrate: true });
    }
    renderAll();
    return true;
  } catch (e) {
    toast(e?.message || "Couldn't update that — try again.", { ms: 4500 });
    return false;
  }
}

// ===========================================================
// SCHEDULE view
// ===========================================================
function renderSchedule() {
  const weekEl = document.getElementById("schedule-week");
  const agendaEl = document.getElementById("schedule-agenda");
  const isAgenda = state.scheduleMode === "agenda";
  weekEl.classList.toggle("hidden", isAgenda);
  agendaEl.classList.toggle("hidden", !isAgenda);
  document.querySelectorAll("#schedule-seg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.schedMode === state.scheduleMode));

  if (!state.activeTermId) {
    weekEl.innerHTML = emptyState("🗓️", "No term yet", "Add a term in Settings, then build your weekly schedule here.");
    agendaEl.innerHTML = "";
    return;
  }
  const configuredDays = DAY_ORDER.filter((dow) => periodsForWeekday(dow).length > 0);
  if (configuredDays.length === 0) {
    weekEl.innerHTML = emptyState("🔔", "Set up your bell schedule", 'Tap "Bell schedule" above to enter which periods meet each day — then assign classes to periods.');
    agendaEl.innerHTML = "";
    return;
  }

  let html = "";
  for (const dow of configuredDays) {
    const slots = scheduleForWeekday(dow);
    html += `<div class="section-title">${DAY_NAMES[dow]}</div><div class="list-card">`;
    html += slots.map((s) => slotRow(s)).join("");
    html += `</div>`;
  }
  weekEl.innerHTML = html;
  bindFlapRowClicks(weekEl);

  if (isAgenda) renderAgenda(agendaEl);
}

/** "This week" list — each of the next 7 days with its classes and anything due that day. */
function renderAgenda(el) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let html = "";
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    const slots = scheduleForWeekday(d.getDay()).filter((s) => !s.isBlock);
    const due = state.assignments
      .filter((a) => a.status !== "done" && isSameDay(new Date(a.dueDate), d))
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    if (!slots.length && !due.length) continue;
    html += `<div class="agenda-day">
      <div class="agenda-head${i === 0 ? " is-today" : ""}">
        <span>${i === 0 ? "Today" : d.toLocaleDateString([], { weekday: "long" })}</span>
        <span>${d.toLocaleDateString([], { month: "short", day: "numeric" })}</span>
      </div>
      <div class="list-card">
        ${slots.map((s) => slotRow(s)).join("")}
        ${due.map((a) => assignmentFlapRow(a)).join("")}
      </div>
    </div>`;
  }
  el.innerHTML = html || emptyState("🎉", "Clear week", "No classes or due dates in the next 7 days.");
  bindFlapRowClicks(el);
}

function wireScheduleView() {
  document.getElementById("btn-edit-dayschedule").addEventListener("click", () => {
    if (!state.activeTermId) return toast("Add a term first.");
    openDayScheduleOverviewSheet();
  });
  document.getElementById("btn-period-times").addEventListener("click", () => {
    if (!state.activeTermId) return toast("Add a term first.");
    openPeriodTimesSheet();
  });
  document.querySelectorAll("#schedule-seg .seg-btn").forEach((b) => {
    b.addEventListener("click", () => {
      state.scheduleMode = b.dataset.schedMode;
      renderSchedule();
    });
  });
}

// ---- Bell schedule (day schedule) editor ----
function daySummary(raw) {
  if (raw === undefined) return "Not set up";
  if (!Array.isArray(raw) || raw.length === 0) return "No school";
  const first = [...raw].sort((a, b) => a.start.localeCompare(b.start))[0];
  const classes = raw.filter((s) => slotKind(s) === "class").length;
  const blocks = raw.length - classes;
  return `${classes} class${classes === 1 ? "" : "es"}${blocks ? ` + ${blocks} block${blocks === 1 ? "" : "s"}` : ""}, from ${timeStrToLabel(first.start)}`;
}

function openDayScheduleOverviewSheet() {
  const rows = DAY_ORDER.map(
    (dow) => `<div class="settings-row" style="cursor:pointer;" data-edit-day="${dow}">
      <div>
        <div class="label">${DAY_NAMES[dow]}</div>
        <div class="sub">${daySummary(state.daySchedule[String(dow)])}</div>
      </div>
      <span class="chevron">${CHEVRON_SVG}</span>
    </div>`
  ).join("");

  openSheet(
    `
    <h2>Bell schedule</h2>
    <p class="small text-muted" style="margin:-8px 0 14px;">Set which periods meet each day, plus lunch, WIN and other blocks. Classes just pick a period — days and times come from here, so a period not scheduled on a day (like Wednesdays) simply won't show that day.</p>
    <div class="settings-list">${rows}</div>
    <button class="btn ghost block mt-16" id="add-everyday-block">+ Add a block to every school day</button>
    <button class="btn ghost block mt-8" id="dayschedule-done">Done</button>
  `,
    {
      onMount: (root) => {
        root.querySelectorAll("[data-edit-day]").forEach((row) => {
          row.addEventListener("click", () => openDayEditorSheet(Number(row.dataset.editDay)));
        });
        root.querySelector("#add-everyday-block").addEventListener("click", openEveryDayBlockSheet);
        root.querySelector("#dayschedule-done").addEventListener("click", closeSheet);
      },
    }
  );
}

/** Insert one named block (WIN, Lunch, …) at the same time into every day that currently has school. */
function openEveryDayBlockSheet() {
  const meetingDays = DAY_ORDER.filter((d) => periodsForWeekday(d).length > 0);
  openSheet(
    `
    <h2>Block on every school day</h2>
    <p class="small text-muted" style="margin:-8px 0 14px;">Adds this to all ${meetingDays.length} day${meetingDays.length === 1 ? "" : "s"} that currently have school — no need to edit each one.</p>
    <div class="field">
      <label>Type</label>
      <select id="eb-kind">
        ${["win", "lunch", "advisory", "break", "activity"].map((k) => `<option value="${k}">${BLOCK_LABELS[k]}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Name (optional)</label><input type="text" id="eb-label" placeholder="WIN" /></div>
    <div class="field-row">
      <div class="field"><label>Start</label><input type="time" id="eb-start" /></div>
      <div class="field"><label>End</label><input type="time" id="eb-end" /></div>
    </div>
    <div class="sheet-actions">
      <button class="btn ghost" id="eb-cancel">Cancel</button>
      <button class="btn primary block" id="eb-save">Add to every day</button>
    </div>
  `,
    {
      onMount: (root) => {
        root.querySelector("#eb-cancel").addEventListener("click", openDayScheduleOverviewSheet);
        root.querySelector("#eb-save").addEventListener(
          "click",
          guarded(async () => {
            const kind = root.querySelector("#eb-kind").value;
            const label = root.querySelector("#eb-label").value.trim() || BLOCK_LABELS[kind];
            const start = root.querySelector("#eb-start").value;
            const end = root.querySelector("#eb-end").value;
            if (!start || !end) return toast("Pick a start and end time.");
            if (start >= end) return toast("End time must be after the start.");
            let ok = 0;
            for (const dow of meetingDays) {
              const next = [...periodsForWeekday(dow), { kind, label, start, end }];
              try {
                await api.setDaySchedule(state.activeTermId, dow, next);
                ok++;
              } catch (e) {
                toast(e?.message || `Couldn't update ${DAY_NAMES[dow]}.`, { ms: 4000 });
              }
            }
            await loadTermScopedData();
            renderAll();
            toast(`Added ${label} to ${ok} day${ok === 1 ? "" : "s"}.`);
            openDayScheduleOverviewSheet();
          })
        );
      },
    }
  );
}

const DAY_KIND_OPTIONS = ["class", "lunch", "win", "advisory", "break", "activity"];

function openDayEditorSheet(dow) {
  const existing = state.daySchedule[String(dow)];
  // internal row shape: { kind, name, start, end } — `name` is the period
  // label for a class, or the display label for a block.
  let rows = Array.isArray(existing)
    ? existing.map((p) => ({ kind: slotKind(p), name: slotKind(p) === "class" ? p.period : p.label || "", start: p.start || "", end: p.end || "" }))
    : [];
  let noSchool = existing === null;

  const otherDaysWithData = DAY_ORDER.filter(
    (d) => d !== dow && Array.isArray(state.daySchedule[String(d)]) && state.daySchedule[String(d)].length > 0
  );

  function rowsHTML() {
    if (rows.length === 0) {
      return `<p class="small text-muted" style="padding:6px 2px 10px;">Nothing yet — add a period or block below.</p>`;
    }
    return rows
      .map(
        (p, i) => `
      <div class="period-row" data-idx="${i}">
        <select data-field="kind" class="period-kind">
          ${DAY_KIND_OPTIONS.map((k) => `<option value="${k}" ${p.kind === k ? "selected" : ""}>${k === "class" ? "Class" : BLOCK_LABELS[k]}</option>`).join("")}
        </select>
        <input type="text" class="period-label" data-field="name" value="${escapeHtml(p.name)}" placeholder="${p.kind === "class" ? "1" : BLOCK_LABELS[p.kind] || "Name"}" />
        <input type="time" data-field="start" value="${p.start}" />
        <input type="time" data-field="end" value="${p.end}" />
        <button type="button" class="period-remove" data-remove="${i}" aria-label="Remove">${CLOSE_SVG}</button>
      </div>`
      )
      .join("");
  }

  openSheet(
    `
    <h2>${DAY_NAMES[dow]}</h2>
    <div class="settings-row" style="padding:2px 0 16px; background:none;">
      <div class="label">School meets this day</div>
      <label class="switch"><input type="checkbox" id="day-meets" ${noSchool ? "" : "checked"} /><span class="track"></span></label>
    </div>
    <div id="day-periods-wrap" class="${noSchool ? "hidden" : ""}">
      ${
        otherDaysWithData.length
          ? `<div class="field">
        <label>Copy from another day</label>
        <select id="day-copy-from">
          <option value="">— choose a day —</option>
          ${otherDaysWithData.map((d) => `<option value="${d}">${DAY_NAMES[d]}</option>`).join("")}
        </select>
      </div>`
          : ""
      }
      <label style="font-size:12.5px; font-weight:600; color:var(--text-secondary); display:block; margin-bottom:8px;">In time order</label>
      <div id="period-rows">${rowsHTML()}</div>
      <div class="field-row mt-8">
        <button type="button" class="btn ghost block" id="add-period">+ Class period</button>
        <button type="button" class="btn ghost block" id="add-block">+ Block</button>
      </div>
    </div>
    <div class="sheet-actions mt-16">
      <button class="btn ghost" id="day-cancel">Cancel</button>
      <button class="btn primary block" id="day-save">Save</button>
    </div>
  `,
    {
      onMount: (root) => {
        const wrap = root.querySelector("#day-periods-wrap");
        const rowsEl = root.querySelector("#period-rows");
        const refreshRows = () => (rowsEl.innerHTML = rowsHTML());

        root.querySelector("#day-meets").addEventListener("change", (e) => {
          noSchool = !e.target.checked;
          wrap.classList.toggle("hidden", noSchool);
        });

        root.querySelector("#day-copy-from")?.addEventListener("change", (e) => {
          if (!e.target.value) return;
          rows = (state.daySchedule[e.target.value] || []).map((p) => ({
            kind: slotKind(p),
            name: slotKind(p) === "class" ? p.period : p.label || "",
            start: p.start || "",
            end: p.end || "",
          }));
          refreshRows();
        });

        root.querySelector("#add-period").addEventListener("click", () => {
          rows.push({ kind: "class", name: "", start: "", end: "" });
          refreshRows();
        });
        root.querySelector("#add-block").addEventListener("click", () => {
          rows.push({ kind: "lunch", name: "", start: "", end: "" });
          refreshRows();
        });

        rowsEl.addEventListener("click", (e) => {
          const btn = e.target.closest("[data-remove]");
          if (!btn) return;
          rows.splice(Number(btn.dataset.remove), 1);
          refreshRows();
        });

        // kind change re-renders (placeholder depends on kind)
        rowsEl.addEventListener("change", (e) => {
          const rowEl = e.target.closest("[data-idx]");
          if (!rowEl || e.target.dataset.field !== "kind") return;
          rows[Number(rowEl.dataset.idx)].kind = e.target.value;
          refreshRows();
        });

        rowsEl.addEventListener("input", (e) => {
          const rowEl = e.target.closest("[data-idx]");
          const field = e.target.dataset.field;
          if (!rowEl || !field) return;
          const row = rows[Number(rowEl.dataset.idx)];
          row[field] = e.target.value;
          // Auto-fill a class period's times from the term default the moment its label is known.
          if (field === "name" && row.kind === "class" && state.periodTimes[e.target.value] && !row.start && !row.end) {
            row.start = state.periodTimes[e.target.value].start;
            row.end = state.periodTimes[e.target.value].end;
            const startEl = rowEl.querySelector('[data-field="start"]');
            const endEl = rowEl.querySelector('[data-field="end"]');
            if (startEl) startEl.value = row.start;
            if (endEl) endEl.value = row.end;
          }
        });

        root.querySelector("#day-cancel").addEventListener("click", openDayScheduleOverviewSheet);

        root.querySelector("#day-save").addEventListener(
          "click",
          guarded(async () => {
            if (noSchool) {
              await api.setDaySchedule(state.activeTermId, dow, null);
            } else {
              if (rows.length === 0) return toast('Add something, or turn off "School meets this day."');
              const payload = [];
              for (const r of rows) {
                if (!r.start || !r.end) return toast("Every row needs a start and end time.");
                if (r.kind === "class") {
                  if (!r.name.trim()) return toast("Every class period needs a label.");
                  payload.push({ period: r.name.trim(), start: r.start, end: r.end, kind: "class" });
                } else {
                  payload.push({ kind: r.kind, label: r.name.trim() || BLOCK_LABELS[r.kind], start: r.start, end: r.end });
                }
              }
              await api.setDaySchedule(state.activeTermId, dow, payload);
            }
            await loadTermScopedData();
            renderAll();
            openDayScheduleOverviewSheet();
          })
        );
      },
    }
  );
}

// ---- Global per-term period times (entered once, reused every day a period meets) ----
function openPeriodTimesSheet() {
  const labels = [...new Set([...knownPeriodLabels(), ...Object.keys(state.periodTimes)])];
  let extra = [];

  const rowFor = (label) => {
    const t = state.periodTimes[label] || {};
    return `<div class="period-row" data-label="${escapeHtml(label)}">
      <div class="period-label" style="display:flex;align-items:center;justify-content:center;">${escapeHtml(label)}</div>
      <input type="time" data-pt="start" value="${t.start || ""}" />
      <input type="time" data-pt="end" value="${t.end || ""}" />
    </div>`;
  };

  openSheet(
    `
    <h2>Period times</h2>
    <p class="small text-muted" style="margin:-8px 0 14px;">Default start/end for each period. The bell-schedule editor fills these in automatically, so you only enter them once.</p>
    <div id="pt-rows">${labels.length ? labels.map(rowFor).join("") : `<p class="small text-muted">No class periods defined yet — add them in the bell schedule first, or add one below.</p>`}</div>
    <div class="field-row mt-8" style="align-items:flex-end;">
      <div class="field" style="margin:0;"><label>Add a period label</label><input type="text" id="pt-new-label" placeholder="e.g. 8 or WIN" /></div>
      <button class="btn ghost" id="pt-add">Add</button>
    </div>
    <div class="sheet-actions mt-16">
      <button class="btn ghost" id="pt-cancel">Cancel</button>
      <button class="btn primary block" id="pt-save">Save</button>
    </div>
  `,
    {
      onMount: (root) => {
        root.querySelector("#pt-cancel").addEventListener("click", closeSheet);
        root.querySelector("#pt-add").addEventListener("click", () => {
          const v = root.querySelector("#pt-new-label").value.trim();
          if (!v || root.querySelector(`[data-label="${CSS.escape(v)}"]`)) return;
          extra.push(v);
          root.querySelector("#pt-rows").insertAdjacentHTML("beforeend", rowFor(v));
          root.querySelector("#pt-new-label").value = "";
        });
        root.querySelector("#pt-save").addEventListener(
          "click",
          guarded(async () => {
            const map = {};
            let bad = false;
            root.querySelectorAll("#pt-rows [data-label]").forEach((row) => {
              const label = row.dataset.label;
              const start = row.querySelector('[data-pt="start"]').value;
              const end = row.querySelector('[data-pt="end"]').value;
              if (!start && !end) return; // skip blank rows
              if (!start || !end || start >= end) bad = true;
              else map[label] = { start, end };
            });
            if (bad) return toast("Each filled-in period needs a valid start before end.");
            const { periodTimes } = await api.setPeriodTimes(state.activeTermId, map);
            state.periodTimes = periodTimes;
            closeSheet();
            toast("Period times saved.");
          })
        );
      },
    }
  );
}

function openClassSheet(cls, { prefillPeriod, prefill } = {}) {
  const isEdit = Boolean(cls);
  const periodOptions = knownPeriodLabels();
  const currentPeriod = cls?.period || prefill?.period || prefillPeriod || "";
  const usedColors = state.classes.filter((c) => c.id !== cls?.id).map((c) => c.color);
  let chosenColor = cls?.color || CLASS_COLORS.find((c) => !usedColors.includes(c)) || CLASS_COLORS[0];
  let links = (cls?.links || []).map((l) => ({ ...l }));

  const linkRowsHTML = () =>
    links.length
      ? links
          .map(
            (l, i) => `<div class="period-row" data-link-idx="${i}">
        <input type="text" class="row-inline-edit" data-link-field="label" value="${escapeHtml(l.label || "")}" placeholder="Canvas" />
        <input type="text" class="row-inline-edit" data-link-field="url" value="${escapeHtml(l.url || "")}" placeholder="canvas.school.edu/…" />
        <button type="button" class="period-remove" data-link-remove="${i}" aria-label="Remove link">${CLOSE_SVG}</button>
      </div>`
          )
          .join("")
      : `<p class="small text-muted" style="padding:4px 2px 8px;">No links yet.</p>`;

  openSheet(
    `
    <h2>${isEdit ? "Edit class" : "Add class"}</h2>
    <div class="field"><label>Class name</label><input type="text" id="cls-title" value="${escapeHtml(cls?.title || prefill?.title || "")}" placeholder="Organic Chemistry" /></div>
    <div class="field">
      <label>Period</label>
      <input type="text" id="cls-period" list="cls-period-options" value="${escapeHtml(currentPeriod)}" placeholder="e.g. 3, or WIN" />
      <datalist id="cls-period-options">
        ${periodOptions.map((p) => `<option value="${escapeHtml(p)}"></option>`).join("")}
      </datalist>
      <p class="small text-muted" style="margin:6px 2px 0;">Days and times come from your bell schedule (Schedule → Bell schedule).</p>
    </div>
    <div class="field">
      <label>Color</label>
      <div class="class-color-dots" id="cls-colors">
        ${CLASS_COLORS.map((c) => `<button type="button" data-color="${c}" class="${c === chosenColor ? "sel" : ""}" style="background:var(--${c})" aria-label="${c}"></button>`).join("")}
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>Instructor</label><input type="text" id="cls-instructor" value="${escapeHtml(cls?.instructor || prefill?.instructor || "")}" /></div>
      <div class="field"><label>Location</label><input type="text" id="cls-location" value="${escapeHtml(cls?.location || prefill?.location || "")}" /></div>
    </div>
    <div class="field"><label>Office hours (optional)</label><input type="text" id="cls-office" value="${escapeHtml(cls?.officeHours || "")}" placeholder="Tue/Thu lunch, room 214" /></div>
    <div class="field">
      <label>Links</label>
      <div id="cls-link-rows">${linkRowsHTML()}</div>
      <button type="button" class="btn ghost block mt-4" id="cls-link-add">+ Add link</button>
    </div>
    <div class="field"><label>Notes</label><textarea id="cls-notes" placeholder="Textbook info, seating, anything to remember…"></textarea></div>
    <div class="sheet-actions">
      ${isEdit ? `<button class="btn danger" id="cls-delete">Delete</button>` : ""}
      <button class="btn ghost" id="cls-cancel">Cancel</button>
      <button class="btn primary block" id="cls-save">Save</button>
    </div>
  `,
    {
      onMount: async (root) => {
        root.querySelector("#cls-cancel").addEventListener("click", closeSheet);

        root.querySelector("#cls-colors").addEventListener("click", (e) => {
          const btn = e.target.closest("[data-color]");
          if (!btn) return;
          chosenColor = btn.dataset.color;
          root.querySelectorAll("#cls-colors button").forEach((b) => b.classList.toggle("sel", b === btn));
        });

        const linkRowsEl = root.querySelector("#cls-link-rows");
        const refreshLinks = () => (linkRowsEl.innerHTML = linkRowsHTML());
        root.querySelector("#cls-link-add").addEventListener("click", () => {
          links.push({ label: "", url: "" });
          refreshLinks();
        });
        linkRowsEl.addEventListener("input", (e) => {
          const rowEl = e.target.closest("[data-link-idx]");
          const f = e.target.dataset.linkField;
          if (rowEl && f) links[Number(rowEl.dataset.linkIdx)][f] = e.target.value;
        });
        linkRowsEl.addEventListener("click", (e) => {
          const btn = e.target.closest("[data-link-remove]");
          if (!btn) return;
          links.splice(Number(btn.dataset.linkRemove), 1);
          refreshLinks();
        });

        if (isEdit) {
          api.getNotes(cls.id).then(({ note }) => {
            const ta = document.getElementById("cls-notes");
            if (ta) ta.value = note.content;
          });
          root.querySelector("#cls-delete").addEventListener("click", () => {
            const termId = state.activeTermId; // capture now — the user may switch terms before this commits
            const idx = state.classes.findIndex((c) => c.id === cls.id);
            if (idx === -1) return;
            const removed = state.classes[idx];
            state.classes.splice(idx, 1);
            closeSheet();
            if (state.currentView === "class" && state.classDetailId === cls.id) location.hash = state.classReturnHash || "schedule";
            renderAll();
            scheduleDelete(
              cls.title,
              () => api.deleteClass(termId, cls.id),
              () => {
                // Only splice back in if still viewing the same term —
                // otherwise state.classes belongs to a different term now,
                // and nothing else is needed since nothing was committed.
                if (state.activeTermId === termId) {
                  state.classes.splice(idx, 0, removed);
                  renderAll();
                }
              }
            );
          });
        }

        root.querySelector("#cls-save").addEventListener(
          "click",
          guarded(async () => {
            const title = document.getElementById("cls-title").value.trim();
            const period = document.getElementById("cls-period").value.trim();
            if (!title) return toast("Class name is required.");
            if (!period) return toast("Period is required.");
            const payload = {
              title,
              period,
              color: chosenColor,
              instructor: document.getElementById("cls-instructor").value.trim(),
              location: document.getElementById("cls-location").value.trim(),
              officeHours: document.getElementById("cls-office").value.trim(),
              links: links.map((l) => ({ label: l.label.trim(), url: l.url.trim() })).filter((l) => l.url),
            };
            let savedClass;
            if (isEdit) {
              const res = await api.updateClass(state.activeTermId, cls.id, payload);
              savedClass = res.class;
            } else {
              const res = await api.createClass(state.activeTermId, payload);
              savedClass = res.class;
            }
            // Read form values before closing the sheet — closeSheet() removes
            // this DOM, so anything still needed from it must be read first.
            const notesContent = document.getElementById("cls-notes").value;
            // The class itself is saved at this point — close the sheet now so a
            // retry after a hiccup below can never create a duplicate class.
            closeSheet();
            try {
              await api.saveNotes(savedClass.id, notesContent);
              await loadTermScopedData();
              renderAll();
            } catch {
              toast("Saved, but couldn't refresh the view — switch tabs to reload.", { ms: 5000 });
            }
          })
        );
      },
    }
  );
}

// ===========================================================
// CLASS HOME PAGE (#class/<id>)
// ===========================================================
function wireClassDetailView() {
  document.getElementById("class-back").addEventListener("click", () => {
    location.hash = state.classReturnHash || "schedule";
  });
}

function renderClassDetail() {
  const host = document.getElementById("class-detail");
  const c = classById(state.classDetailId);
  if (!c) {
    location.hash = "schedule";
    return;
  }
  const meetings = meetingsForPeriod(c.period);
  const now = new Date();
  const meetsLine = meetings.length ? summarizeMeetings(meetings) : `Period ${escapeHtml(c.period)} — not on the bell schedule yet`;

  const classAssignments = state.assignments
    .filter((a) => a.classId === c.id)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  const pending = classAssignments.filter((a) => a.status !== "done");
  const doneList = classAssignments.filter((a) => a.status === "done").slice(-8).reverse();

  const nextMeeting = nextMeetingLabel(meetings, now);

  host.innerHTML = `
    <div class="class-hero" style="--row-accent: ${accentVar(c.color)}">
      <h2>${escapeHtml(c.title)}</h2>
      <div class="meta">
        <button data-edit-field="instructor">${c.instructor ? escapeHtml(c.instructor) : "+ teacher"}</button>
        <button data-edit-field="location">${c.location ? escapeHtml("Room " + c.location) : "+ room"}</button>
        <span>Period ${escapeHtml(c.period)}</span>
      </div>
      <div class="class-hero-actions">
        <button class="btn ghost btn-xs" id="cd-edit">Edit</button>
      </div>
    </div>

    <div class="section-title">Meets</div>
    <div class="list-card"><div class="list-row block-row"><div class="row-body"><div class="row-title">${meetsLine}</div>
      ${nextMeeting ? `<div class="row-sub">Next: ${nextMeeting}</div>` : ""}</div></div></div>

    ${
      c.officeHours
        ? `<div class="section-title">Office hours</div><div class="list-card"><div class="list-row block-row"><div class="row-body"><div class="row-title">${escapeHtml(c.officeHours)}</div></div></div></div>`
        : ""
    }

    ${
      (c.links || []).length
        ? `<div class="section-title">Links</div><div class="link-chips" id="cd-links">
            ${c.links.map((l) => `<a class="link-chip" href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${LINK_SVG}${escapeHtml(l.label || l.url)}</a>`).join("")}
          </div>`
        : ""
    }

    <div class="section-title row-between"><span>Assignments</span>
      <button class="btn ghost btn-xs" id="cd-add-asg">+ Add</button>
    </div>
    <div class="list-card" id="cd-pending">${
      pending.length ? pending.map((a) => assignmentFlapRow(a)).join("") : emptyState("🎉", "Nothing pending", "No open assignments for this class.")
    }</div>
    ${doneList.length ? `<div class="section-title">Recently done</div><div class="list-card" id="cd-done">${doneList.map((a) => assignmentFlapRow(a)).join("")}</div>` : ""}

    <div class="section-title">Notes</div>
    <textarea class="notes-inline" id="cd-notes" placeholder="Textbook, seating, anything to remember…"></textarea>
  `;

  bindFlapRowClicks(host);

  host.querySelector("#cd-edit").addEventListener("click", () => openClassSheet(c));
  host.querySelector("#cd-add-asg").addEventListener("click", () => openAssignmentSheet(null, { prefill: { classId: c.id } }));

  // inline teacher / room edit
  host.querySelectorAll("[data-edit-field]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const field = btn.dataset.editField;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "row-inline-edit";
      input.value = field === "location" ? c.location || "" : c.instructor || "";
      input.placeholder = field === "location" ? "Room" : "Teacher";
      btn.replaceWith(input);
      input.focus();
      input.addEventListener(
        "blur",
        guarded(async () => {
          const val = input.value.trim();
          const res = await api.updateClass(state.activeTermId, c.id, { [field]: val });
          Object.assign(c, res.class);
          const local = state.classes.find((x) => x.id === c.id);
          if (local) Object.assign(local, res.class);
          renderClassDetail();
        })
      );
    });
  });

  // notes: load then autosave on blur
  const notesEl = host.querySelector("#cd-notes");
  api.getNotes(c.id).then(({ note }) => {
    if (host.querySelector("#cd-notes")) host.querySelector("#cd-notes").value = note.content || "";
  });
  notesEl.addEventListener(
    "blur",
    guarded(async () => {
      await api.saveNotes(c.id, notesEl.value);
    })
  );
}

/** "Mon–Fri 10:00–10:50 AM" when the time is uniform; otherwise per-day. */
function summarizeMeetings(meetings) {
  const sorted = [...meetings].sort((a, b) => DAY_ORDER.indexOf(a.dow) - DAY_ORDER.indexOf(b.dow));
  const sameTime = sorted.every((m) => m.start === sorted[0].start && m.end === sorted[0].end);
  const timeRange = (m) => `${timeStrToLabel(m.start)}–${timeStrToLabel(m.end)}`;
  if (sameTime && sorted.length > 1) {
    // collapse runs of consecutive weekdays
    const idx = sorted.map((m) => DAY_ORDER.indexOf(m.dow));
    const runs = [];
    let runStart = 0;
    for (let i = 1; i <= idx.length; i++) {
      if (i === idx.length || idx[i] !== idx[i - 1] + 1) {
        runs.push(runStart === i - 1 ? DAY_NAMES[sorted[runStart].dow].slice(0, 3) : `${DAY_NAMES[sorted[runStart].dow].slice(0, 3)}–${DAY_NAMES[sorted[i - 1].dow].slice(0, 3)}`);
        runStart = i;
      }
    }
    return `${runs.join(", ")} · ${timeRange(sorted[0])}`;
  }
  return sorted.map((m) => `${DAY_NAMES[m.dow].slice(0, 3)} ${timeRange(m)}`).join("  ·  ");
}

function nextMeetingLabel(meetings, now) {
  if (!meetings.length) return "";
  const todayIdx = now.getDay();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (let add = 0; add < 8; add++) {
    const dow = (todayIdx + add) % 7;
    const m = meetings.find((x) => x.dow === dow);
    if (!m) continue;
    if (add === 0 && timeStrToMinutes(m.start) <= nowMin) continue;
    const dayLabel = add === 0 ? "today" : add === 1 ? "tomorrow" : DAY_NAMES[dow];
    return `${dayLabel} at ${timeStrToLabel(m.start)}`;
  }
  return "";
}

// ===========================================================
// Onboarding checklist (Today) — visible until setup is done
// ===========================================================
function renderOnboarding() {
  const el = document.getElementById("onboarding-card");
  if (!el) return;
  const hasTerm = Boolean(state.activeTermId);
  const hasBell = DAY_ORDER.some((d) => periodsForWeekday(d).length > 0);
  const hasClasses = state.classes.length > 0;
  if (hasTerm && hasBell && hasClasses) {
    el.innerHTML = "";
    return;
  }
  const step = (done, label, btn) =>
    `<li class="${done ? "done" : ""}">${label}${!done && btn ? ` <button data-onboard="${btn.id}">${btn.text}</button>` : ""}</li>`;
  el.innerHTML = `
    <div class="onboard">
      <h3>Let's get set up</h3>
      <p>Three quick steps and the rest of the app comes to life.</p>
      <ol>
        ${step(hasTerm, "Add a term (e.g. “Fall 2026”)", { id: "term", text: "Add" })}
        ${step(hasBell, "Set your bell schedule — which periods meet each day", { id: "bell", text: "Set up" })}
        ${step(hasClasses, "Add your classes", { id: "class", text: "Add" })}
      </ol>
    </div>`;
  el.querySelectorAll("[data-onboard]").forEach((b) => {
    b.addEventListener("click", () => {
      if (b.dataset.onboard === "term") openTermSheet(null);
      else if (b.dataset.onboard === "bell") openDayScheduleOverviewSheet();
      else openClassSheet(null);
    });
  });
}

// ===========================================================
// ASSIGNMENTS view
// ===========================================================
function renderAssignments() {
  const pendingEl = document.getElementById("assignments-pending");
  const doneEl = document.getElementById("assignments-done");
  const toolbarEl = document.getElementById("assign-toolbar");
  renderTodos(); // independent of term — always render regardless of what's below

  if (!state.activeTermId) {
    toolbarEl.innerHTML = "";
    pendingEl.innerHTML = emptyState("📋", "No term yet", "Add a term in Settings to start tracking assignments.");
    doneEl.innerHTML = "";
    return;
  }

  // --- filter toolbar: All / This week / Overdue / one chip per class ---
  const filters = [
    ["all", "All"],
    ["week", "This week"],
    ["overdue", "Overdue"],
    ...state.classes.map((c) => [c.id, c.title]),
  ];
  if (!filters.some(([k]) => k === state.assignFilter)) state.assignFilter = "all";
  toolbarEl.innerHTML =
    filters.map(([k, label]) => `<button class="chip${k === state.assignFilter ? " active" : ""}" data-filter="${escapeHtml(k)}">${escapeHtml(label)}</button>`).join("") +
    `<select class="chip" id="assign-sort" style="-webkit-appearance:none;appearance:none;">
      ${[["due", "Sort: Due"], ["priority", "Sort: Priority"], ["class", "Sort: Class"]].map(([v, l]) => `<option value="${v}" ${state.settings.assignmentSort === v ? "selected" : ""}>${l}</option>`).join("")}
    </select>`;
  toolbarEl.querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      state.assignFilter = b.dataset.filter;
      renderAssignments();
    })
  );
  toolbarEl.querySelector("#assign-sort").addEventListener(
    "change",
    guarded(async (e) => {
      const { settings } = await api.updateSettings({ assignmentSort: e.target.value });
      state.settings = settings;
      renderAssignments();
    })
  );

  const now = new Date();
  const weekEnd = new Date(now.getTime() + 7 * 86400000);
  const matchesFilter = (a) => {
    if (state.assignFilter === "all") return true;
    if (state.assignFilter === "week") return new Date(a.dueDate) <= weekEnd;
    if (state.assignFilter === "overdue") return new Date(a.dueDate) < now;
    return a.classId === state.assignFilter;
  };
  const prioRank = { high: 0, medium: 1, low: 2 };
  const sortFn = (a, b) => {
    if (state.settings.assignmentSort === "priority") return (prioRank[a.priority] ?? 1) - (prioRank[b.priority] ?? 1) || new Date(a.dueDate) - new Date(b.dueDate);
    if (state.settings.assignmentSort === "class") {
      const an = classById(a.classId)?.title || "~";
      const bn = classById(b.classId)?.title || "~";
      return an.localeCompare(bn) || new Date(a.dueDate) - new Date(b.dueDate);
    }
    return new Date(a.dueDate) - new Date(b.dueDate);
  };

  const pending = state.assignments.filter((a) => a.status !== "done" && matchesFilter(a)).sort(sortFn);
  const done = state.assignments.filter((a) => a.status === "done").sort((a, b) => b.completedAt - a.completedAt);

  pendingEl.innerHTML = pending.length
    ? pending.map((a) => assignmentFlapRow(a)).join("")
    : emptyState("🎉", state.assignFilter === "all" ? "All clear" : "Nothing here", state.assignFilter === "all" ? "No pending assignments." : "Try another filter.");
  doneEl.innerHTML = done.length ? done.slice(0, 20).map((a) => assignmentFlapRow(a)).join("") : emptyState("—", "Nothing completed yet", "");

  bindFlapRowClicks(pendingEl, doneEl);
}

function wireAssignmentsView() {
  document.getElementById("btn-syllabus-import").addEventListener("click", () => {
    if (!state.activeTermId) return toast("Add a term first.");
    openSyllabusImportSheet();
  });
  wireQuickAdd();
  wireTodoAdd();
}

// ---- Quick add — same natural-language capture as the omnibox ----
function wireQuickAdd() {
  const input = document.getElementById("quick-add-input");
  const submit = guarded(async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    await runCapture(text);
  });
  document.getElementById("quick-add-submit").addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}

// ---- To-dos (simple, non-academic checklist items) ----
function todoRow(t) {
  return `<div class="list-row todo-row${t.done ? " done" : ""}" data-todo-id="${t.id}">
    <button class="check" data-toggle-todo="${t.id}" aria-label="Mark done">${CHECK_SVG}</button>
    <input type="text" class="todo-title" value="${escapeHtml(t.title)}" data-todo-title="${t.id}" />
    <button class="todo-remove" data-remove-todo="${t.id}" aria-label="Delete">${CLOSE_SVG}</button>
  </div>`;
}

function renderTodos() {
  const el = document.getElementById("todos-list");
  if (!el) return;
  if (state.todos.length === 0) {
    el.innerHTML = emptyState("📝", "No to-dos", "Little things that aren't tied to a class — a form to return, something to pack.");
    return;
  }
  const sorted = [...state.todos].sort((a, b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt);
  el.innerHTML = sorted.map(todoRow).join("");
  bindTodoRowEvents(el);
}

function bindTodoRowEvents(container) {
  container.querySelectorAll("[data-toggle-todo]").forEach((btn) => {
    btn.addEventListener(
      "click",
      guarded(async () => {
        const id = btn.dataset.toggleTodo;
        const t = state.todos.find((x) => x.id === id);
        if (!t) return;
        const res = await api.updateTodo(id, { done: !t.done });
        Object.assign(t, res.todo);
        renderTodos();
      })
    );
  });
  container.querySelectorAll("[data-todo-title]").forEach((input) => {
    input.addEventListener(
      "change",
      guarded(async () => {
        const id = input.dataset.todoTitle;
        const title = input.value.trim();
        const t = state.todos.find((x) => x.id === id);
        if (!title) {
          renderTodos(); // revert visually to the stored value
          return;
        }
        const res = await api.updateTodo(id, { title });
        Object.assign(t, res.todo);
      })
    );
  });
  container.querySelectorAll("[data-remove-todo]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.removeTodo;
      const idx = state.todos.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const removed = state.todos[idx];
      state.todos.splice(idx, 1);
      renderTodos();
      scheduleDelete(
        removed.title,
        () => api.deleteTodo(id),
        () => {
          state.todos.splice(idx, 0, removed);
          renderTodos();
        }
      );
    });
  });
}

function wireTodoAdd() {
  const submit = guarded(async () => {
    const input = document.getElementById("todo-add-input");
    const title = input.value.trim();
    if (!title) return;
    const res = await api.createTodo(title);
    state.todos.push(res.todo);
    input.value = "";
    renderTodos();
  });
  document.getElementById("todo-add-submit").addEventListener("click", submit);
  document.getElementById("todo-add-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}

function openAssignmentSheet(assignment, { prefillTitle, prefill } = {}) {
  const isEdit = Boolean(assignment);
  const pf = prefill || {};
  const pfDue = pf.dueDate ? (pf.dueDate instanceof Date ? pf.dueDate : new Date(pf.dueDate)) : null;
  const initialTitle = assignment?.title || pf.title || prefillTitle || "";
  const initialClassId = assignment?.classId || pf.classId || "";
  const initialPriority = assignment?.priority || pf.priority || "medium";
  const initialEffort = String(assignment?.estimatedMinutes || pf.estimatedMinutes || "");
  const initialLink = assignment?.link || pf.link || "";
  const dueLocal = assignment ? toDatetimeLocalValue(new Date(assignment.dueDate)) : pfDue ? toDatetimeLocalValue(pfDue) : defaultDueLocal();
  const term = activeTerm();
  const defaultRepeatUntil = (pf.repeat && pf.repeat.until ? new Date(pf.repeat.until).toISOString() : term ? term.endDate : "").slice(0, 10);
  const EFFORT_OPTIONS = [
    ["", "No estimate"],
    ["15", "15 min"],
    ["30", "30 min"],
    ["45", "45 min"],
    ["60", "1 hr"],
    ["90", "1.5 hr"],
    ["120", "2 hr"],
    ["180", "3 hr"],
    ["240", "4+ hr"],
  ];

  openSheet(
    `
    <h2>${isEdit ? "Edit assignment" : "Add assignment"}</h2>
    <div class="field"><label>Title</label><input type="text" id="asg-title" value="${escapeHtml(initialTitle)}" placeholder="Essay 2 draft" /></div>
    <div class="field">
      <label>Class (optional)</label>
      <select id="asg-class">
        <option value="">No class</option>
        ${state.classes.map((c) => `<option value="${c.id}" ${initialClassId === c.id ? "selected" : ""}>${escapeHtml(c.title)}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Due</label><input type="datetime-local" id="asg-due" value="${dueLocal}" /></div>
    <div class="field-row">
      <div class="field">
        <label>Priority</label>
        <select id="asg-priority">
          <option value="low" ${initialPriority === "low" ? "selected" : ""}>Low</option>
          <option value="medium" ${initialPriority === "medium" ? "selected" : ""}>Medium</option>
          <option value="high" ${initialPriority === "high" ? "selected" : ""}>High</option>
        </select>
      </div>
      <div class="field">
        <label>Est. time</label>
        <select id="asg-effort">
          ${EFFORT_OPTIONS.map(([v, l]) => `<option value="${v}" ${initialEffort === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="field">
      <label>Link (optional)</label>
      <input type="text" id="asg-link" value="${escapeHtml(initialLink)}" placeholder="Canvas, Google Doc, etc." />
    </div>
    <div class="field"><label>Notes</label><textarea id="asg-notes">${escapeHtml(assignment?.notes || "")}</textarea></div>
    ${
      !isEdit
        ? `<div class="field">
          <div class="settings-row" style="padding:0 0 10px; background:none;">
            <div class="label">Repeat weekly</div>
            <label class="switch"><input type="checkbox" id="asg-repeat" ${pf.repeat ? "checked" : ""} /><span class="track"></span></label>
          </div>
          <div id="asg-repeat-until-wrap" class="${pf.repeat ? "" : "hidden"}">
            <label>Repeat until</label>
            <input type="date" id="asg-repeat-until" value="${defaultRepeatUntil}" />
          </div>
        </div>`
        : ""
    }
    <div class="sheet-actions">
      ${isEdit ? `<button class="btn danger" id="asg-delete">Delete</button>` : ""}
      <button class="btn ghost" id="asg-cancel">Cancel</button>
      <button class="btn primary block" id="asg-save">Save</button>
    </div>
    ${isEdit ? `<button class="btn ghost block mt-16" id="asg-toggle">${assignment.status === "done" ? "Mark as not done" : "Mark complete"}</button>` : ""}
    ${
      isEdit && assignment.status !== "done"
        ? `<div class="field-row mt-8">
          <button class="btn ghost block" id="asg-snooze-1h">Snooze 1 hr</button>
          <button class="btn ghost block" id="asg-snooze-tomorrow">Snooze to tomorrow</button>
        </div>`
        : ""
    }
    ${isEdit && assignment.link ? `<a href="${escapeHtml(assignment.link)}" target="_blank" rel="noopener" class="btn ghost block mt-8">Open link ↗</a>` : ""}
  `,
    {
      onMount: (root) => {
        root.querySelector("#asg-cancel").addEventListener("click", closeSheet);
        root.querySelector("#asg-repeat")?.addEventListener("change", (e) => {
          root.querySelector("#asg-repeat-until-wrap").classList.toggle("hidden", !e.target.checked);
        });

        if (isEdit) {
          root.querySelector("#asg-delete").addEventListener("click", () => {
            const termId = state.activeTermId; // capture now — the user may switch terms before this commits
            const idx = state.assignments.findIndex((a) => a.id === assignment.id);
            if (idx === -1) return;
            const removed = state.assignments[idx];
            const hadPoints = Boolean(removed.pointsAwarded);
            state.assignments.splice(idx, 1);
            closeSheet();
            renderAll();
            scheduleDelete(
              assignment.title,
              () => api.deleteAssignment(termId, assignment.id),
              () => {
                // Only splice back into the visible list if still viewing the
                // same term — otherwise state.assignments belongs to a
                // different term now, and there's nothing else to do since
                // the delete was never actually committed server-side.
                if (state.activeTermId === termId) {
                  state.assignments.splice(idx, 0, removed);
                  renderAll();
                }
              },
              {
                // Deleting a completed assignment also removes its points
                // history server-side — refresh the local total/streak once
                // that's actually committed, not just optimistically.
                onCommitted: hadPoints
                  ? async () => {
                      state.points = await api.getPoints();
                      renderAll();
                    }
                  : undefined,
              }
            );
          });
          root.querySelector("#asg-toggle").addEventListener("click", async () => {
            const ok = await toggleComplete(assignment.id);
            if (ok) closeSheet(); // stay open on failure so the error is visible and they can retry
          });
          root.querySelector("#asg-snooze-1h")?.addEventListener(
            "click",
            guarded(async () => {
              await api.snoozeAssignment(state.activeTermId, assignment.id, new Date(Date.now() + 3600000).toISOString());
              closeSheet();
              toast("Reminders snoozed for 1 hour.");
            })
          );
          root.querySelector("#asg-snooze-tomorrow")?.addEventListener(
            "click",
            guarded(async () => {
              await api.snoozeAssignment(state.activeTermId, assignment.id, tomorrowMorning().toISOString());
              closeSheet();
              toast("Reminders snoozed until tomorrow morning.");
            })
          );
        }

        root.querySelector("#asg-save").addEventListener(
          "click",
          guarded(async () => {
            const title = document.getElementById("asg-title").value.trim();
            const dueVal = document.getElementById("asg-due").value;
            if (!title || !dueVal) return toast("Title and due date are required.");
            const effortVal = document.getElementById("asg-effort").value;
            const linkVal = document.getElementById("asg-link").value.trim();
            const payload = {
              title,
              classId: document.getElementById("asg-class").value || null,
              dueDate: new Date(dueVal).toISOString(),
              priority: document.getElementById("asg-priority").value,
              estimatedMinutes: effortVal ? Number(effortVal) : null,
              link: linkVal || null,
              notes: document.getElementById("asg-notes").value,
            };

            const repeatEl = document.getElementById("asg-repeat");
            if (!isEdit && repeatEl?.checked) {
              const untilVal = document.getElementById("asg-repeat-until").value;
              if (!untilVal) return toast("Pick a date to repeat until.");
              await createWeeklyRepeats(payload, new Date(dueVal), new Date(untilVal));
            } else {
              if (isEdit) await api.updateAssignment(state.activeTermId, assignment.id, payload);
              else await api.createAssignment(state.activeTermId, payload);
            }
            // Saved server-side already — close now so a retry after a
            // refresh hiccup below can never double-create the assignment.
            closeSheet();
            try {
              await loadTermScopedData();
              renderAll();
            } catch {
              toast("Saved, but couldn't refresh the view — switch tabs to reload.", { ms: 5000 });
            }
          })
        );
      },
    }
  );
}

/** Creates one assignment per week from the first due date through `until` (inclusive), tolerating partial failure. */
async function createWeeklyRepeats(basePayload, firstDue, until) {
  const dates = [];
  let cursor = new Date(firstDue);
  const untilEnd = new Date(until.getFullYear(), until.getMonth(), until.getDate(), 23, 59, 59);
  while (cursor <= untilEnd) {
    dates.push(new Date(cursor));
    cursor = new Date(cursor.getTime() + 7 * 86400000);
  }

  let successCount = 0;
  let failCount = 0;
  for (const d of dates) {
    try {
      await api.createAssignment(state.activeTermId, { ...basePayload, dueDate: d.toISOString() });
      successCount++;
    } catch {
      failCount++;
    }
  }

  if (failCount > 0) {
    toast(`Created ${successCount} of ${dates.length} repeats — ${failCount} failed. Check your connection and try again for the rest.`, { ms: 5500 });
  } else {
    toast(`Created ${successCount} weekly repeat${successCount === 1 ? "" : "s"}.`);
  }
}

function toDatetimeLocalValue(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function defaultDueLocal() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(23, 59, 0, 0);
  return toDatetimeLocalValue(d);
}

function tomorrowMorning() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

// ---- Syllabus paste-in import ----
function openSyllabusImportSheet() {
  openSheet(
    `
    <h2>Paste syllabus text</h2>
    <p class="small text-muted">Paste a schedule section from a syllabus. We'll pull out anything that looks like a dated item — you'll review and edit before anything is added.</p>
    <div class="field"><textarea id="syl-text" rows="8" placeholder="Sept 3 — HW 1 due&#10;Midterm Exam: Oct 8, 3:00pm&#10;..."></textarea></div>
    <button class="btn primary block" id="syl-parse">Find dated items</button>
    <div id="syl-results" class="mt-16"></div>
  `,
    {
      onMount: (root) => {
        root.querySelector("#syl-parse").addEventListener("click", () => {
          const text = document.getElementById("syl-text").value;
          const term = activeTerm();
          const rows = parseSyllabusText(text, term || {});
          renderSyllabusResults(rows);
        });
      },
    }
  );
}

function renderSyllabusResults(rows) {
  const el = document.getElementById("syl-results");
  if (!rows.length) {
    el.innerHTML = `<p class="small text-muted">No dated items found. Try pasting a section that includes dates like "Oct 8" or "10/8".</p>`;
    return;
  }
  el.innerHTML = `
    <div class="section-title">Found ${rows.length} item${rows.length === 1 ? "" : "s"} — review before importing</div>
    <div id="syl-rows">
      ${rows
        .map(
          (r, i) => `
        <div class="list-card" style="padding:10px; margin-bottom:8px;" data-row="${i}">
          <div style="display:flex; gap:8px; align-items:center;">
            <input type="checkbox" checked data-syl-include="${i}" />
            <input type="text" value="${escapeHtml(r.title)}" data-syl-title="${i}" style="flex:1; background:var(--surface-2); border:none; border-radius:9px; padding:6px 8px; color:var(--text);" />
          </div>
          <div style="display:flex; gap:8px; margin-top:8px;">
            <input type="datetime-local" value="${toDatetimeLocalValue(new Date(r.date))}" data-syl-date="${i}" style="flex:1; background:var(--surface-2); border:none; border-radius:9px; padding:6px 8px; color:var(--text);" />
            <select data-syl-class="${i}" style="background:var(--surface-2); border:none; border-radius:9px; padding:6px 8px; color:var(--text);">
              <option value="">No class</option>
              ${state.classes.map((c) => `<option value="${c.id}">${escapeHtml(c.title)}</option>`).join("")}
            </select>
          </div>
        </div>`
        )
        .join("")}
    </div>
    <button class="btn primary block mt-8" id="syl-import">Import selected</button>
  `;
  document.getElementById("syl-import").addEventListener(
    "click",
    guarded(async () => {
      const rowsEls = [...document.querySelectorAll("#syl-rows [data-row]")];
      let successCount = 0;
      let failCount = 0;
      for (const rowEl of rowsEls) {
        const i = rowEl.dataset.row;
        const includeEl = rowEl.querySelector(`[data-syl-include="${i}"]`);
        if (!includeEl.checked) continue;
        const title = rowEl.querySelector(`[data-syl-title="${i}"]`).value.trim();
        const dueVal = rowEl.querySelector(`[data-syl-date="${i}"]`).value;
        const classId = rowEl.querySelector(`[data-syl-class="${i}"]`).value || null;
        if (!title || !dueVal) continue;
        try {
          await api.createAssignment(state.activeTermId, {
            title,
            dueDate: new Date(dueVal).toISOString(),
            classId,
            priority: "medium",
          });
          successCount++;
          // Mark this row done so a retry (after a partial failure below)
          // can never import the same item twice.
          includeEl.checked = false;
          includeEl.disabled = true;
          rowEl.style.opacity = "0.4";
        } catch {
          failCount++;
        }
      }
      if (successCount > 0) {
        try {
          await loadTermScopedData();
          renderAll();
        } catch {
          /* the creates already happened; a stale view here is non-fatal */
        }
      }
      if (failCount === 0) {
        closeSheet();
        toast(`Imported ${successCount} item${successCount === 1 ? "" : "s"}.`);
      } else {
        toast(
          `Imported ${successCount}, but ${failCount} failed — check your connection and try again.`,
          { ms: 5500 }
        );
        // Sheet stays open with only the failed rows still active, so
        // hitting Import again retries just those, not everything.
      }
    })
  );
}

// ===========================================================
// CALENDAR view
// ===========================================================
function renderCalendar() {
  const grid = document.getElementById("cal-grid");
  const label = document.getElementById("cal-month-label");
  label.textContent = state.calCursor.toLocaleDateString([], { month: "long", year: "numeric" });

  const year = state.calCursor.getFullYear();
  const month = state.calCursor.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = (firstOfMonth.getDay() + 6) % 7; // Monday-first grid
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();

  let html = DAY_ORDER.map((d) => `<div class="wd">${DAY_SHORT[d]}</div>`).join("");

  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;
  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - startOffset + 1;
    const cellDate = new Date(year, month, dayNum);
    const inMonth = dayNum >= 1 && dayNum <= daysInMonth;
    const dueThatDay = state.assignments.filter((a) => isSameDay(new Date(a.dueDate), cellDate));
    const dots = dueThatDay
      .slice(0, 4)
      .map(() => `<span></span>`)
      .join("");
    html += `<div class="month-cell${inMonth ? "" : " other-month"}${isSameDay(cellDate, today) ? " today" : ""}${isSameDay(cellDate, state.calSelected) ? " selected" : ""}" data-date="${cellDate.toISOString()}">
      <div class="n">${cellDate.getDate()}</div>
      <div class="dots">${dots}</div>
    </div>`;
  }
  grid.innerHTML = html;

  grid.querySelectorAll("[data-date]").forEach((cell) => {
    cell.addEventListener("click", () => {
      state.calSelected = new Date(cell.dataset.date);
      renderCalendarDayList();
      grid.querySelectorAll(".month-cell").forEach((c) => c.classList.remove("selected"));
      cell.classList.add("selected");
    });
  });

  renderCalendarDayList();
}

function renderCalendarDayList() {
  const el = document.getElementById("cal-day-list");
  const d = state.calSelected;
  const dow = d.getDay();
  const slotsThatDay = scheduleForWeekday(dow);
  const assignmentsThatDay = state.assignments.filter((a) => isSameDay(new Date(a.dueDate), d));

  if (slotsThatDay.length === 0 && assignmentsThatDay.length === 0) {
    el.innerHTML = emptyState("—", d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }), "Nothing scheduled.");
    return;
  }
  el.innerHTML = slotsThatDay.map((s) => slotRow(s)).join("") + assignmentsThatDay.map((a) => assignmentFlapRow(a)).join("");
  bindFlapRowClicks(el);
}

function wireCalendarView() {
  document.getElementById("cal-prev").addEventListener("click", () => {
    state.calCursor = new Date(state.calCursor.getFullYear(), state.calCursor.getMonth() - 1, 1);
    renderCalendar();
  });
  document.getElementById("cal-next").addEventListener("click", () => {
    state.calCursor = new Date(state.calCursor.getFullYear(), state.calCursor.getMonth() + 1, 1);
    renderCalendar();
  });
}

// ===========================================================
// FOCUS view (Pomodoro + do-not-disturb)
// ===========================================================
let focusMinutesSetting = 25;

function renderFocus() {
  document.getElementById("focus-streak").textContent = state.points.streak > 0 ? `🔥 ${state.points.streak} on-time in a row` : "";
  if (!focusTimer) {
    document.getElementById("focus-time").textContent = `${String(focusMinutesSetting).padStart(2, "0")}:00`;
  }
}

function wireFocusView() {
  document.getElementById("focus-minus").addEventListener("click", () => {
    if (focusTimer) return;
    focusMinutesSetting = Math.max(5, focusMinutesSetting - 5);
    renderFocus();
  });
  document.getElementById("focus-plus").addEventListener("click", () => {
    if (focusTimer) return;
    focusMinutesSetting = Math.min(90, focusMinutesSetting + 5);
    renderFocus();
  });
  document.getElementById("focus-start").addEventListener(
    "click",
    guarded(async () => {
      if (focusTimer) {
        await stopFocusSession();
      } else {
        await api.startFocus(focusMinutesSetting);
        const { focus } = await api.getFocus();
        state.focus = focus;
        startFocusCountdown(focus.until);
      }
    })
  );
}

async function syncFocusFromServer() {
  if (state.focus?.until && state.focus.until > Date.now()) {
    startFocusCountdown(state.focus.until);
  }
}

function startFocusCountdown(until) {
  stopFocusInterval();
  const btn = document.getElementById("focus-start");
  const stateEl = document.getElementById("focus-state");
  btn.textContent = "Stop focus";
  requestWakeLock();

  focusTimer = setInterval(async () => {
    const remaining = until - Date.now();
    if (remaining <= 0) {
      await stopFocusSession(true);
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    document.getElementById("focus-time").textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    stateEl.textContent = "Notifications are paused until this ends.";
  }, 1000);
}

function stopFocusInterval() {
  if (focusTimer) {
    clearInterval(focusTimer);
    focusTimer = null;
  }
  releaseWakeLock();
}

async function stopFocusSession(completed = false) {
  stopFocusInterval();
  try {
    await api.stopFocus();
  } catch (e) {
    toast(e?.message || "Couldn't sync with the server, but the timer is stopped here.", { ms: 4500 });
  }
  state.focus = { until: null };
  document.getElementById("focus-start").textContent = "Start focus";
  document.getElementById("focus-state").textContent = completed ? "Focus session complete." : "Ready when you are.";
  renderFocus();
  if (completed) toast("Focus session complete! 🎯", { celebrate: true });
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request?.("screen");
  } catch {
    /* not supported / not allowed — fine, timer still runs */
  }
}
function releaseWakeLock() {
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}

// ===========================================================
// SETTINGS view
// ===========================================================
function renderSettings() {
  const el = document.getElementById("settings-terms");
  const liveTerms = state.terms.filter((t) => !t.archived);
  const archivedTerms = state.terms.filter((t) => t.archived);

  el.innerHTML = liveTerms.length
    ? liveTerms
        .map(
          (t) => `
      <div class="settings-row">
        <div style="flex:1; cursor:pointer;" data-switch-term="${t.id}">
          <div class="label">${t.id === state.activeTermId ? "✓ " : ""}${escapeHtml(t.name)}</div>
          <div class="sub">${new Date(t.startDate).toLocaleDateString()} – ${new Date(t.endDate).toLocaleDateString()}</div>
        </div>
        <button class="btn ghost icon" data-edit-term="${t.id}">✎</button>
      </div>`
        )
        .join("")
    : `<div class="settings-row"><div class="sub">No terms yet.</div></div>`;

  el.querySelectorAll("[data-switch-term]").forEach((row) =>
    row.addEventListener(
      "click",
      guarded(async () => {
        await api.activateTerm(row.dataset.switchTerm);
        state.activeTermId = row.dataset.switchTerm;
        await loadTermScopedData();
        renderAll();
      })
    )
  );
  el.querySelectorAll("[data-edit-term]").forEach((btn) =>
    btn.addEventListener("click", () => openTermSheet(state.terms.find((t) => t.id === btn.dataset.editTerm)))
  );

  const archivedWrap = document.getElementById("archived-terms-wrap");
  archivedWrap.classList.toggle("hidden", archivedTerms.length === 0);
  if (archivedTerms.length > 0) {
    const archivedEl = document.getElementById("settings-archived-terms");
    archivedEl.innerHTML = archivedTerms
      .map(
        (t) => `
      <div class="settings-row" style="cursor:pointer;" data-edit-term="${t.id}">
        <div>
          <div class="label">${escapeHtml(t.name)}</div>
          <div class="sub">${new Date(t.startDate).toLocaleDateString()} – ${new Date(t.endDate).toLocaleDateString()}</div>
        </div>
        <span class="chevron">${CHEVRON_SVG}</span>
      </div>`
      )
      .join("");
    archivedEl.querySelectorAll("[data-edit-term]").forEach((row) =>
      row.addEventListener("click", () => openTermSheet(state.terms.find((t) => t.id === row.dataset.editTerm)))
    );
  }

  document.getElementById("reminder-offsets").value = (state.settings.reminderOffsetsMinutes || []).join(", ");
  document.getElementById("theme-select").value = state.settings.theme || "system";
  document.getElementById("passing-value").textContent = state.settings.passingPeriodMaxMinutes ?? 15;
  document.getElementById("nlassist-sub").textContent = state.settings.nlAssist
    ? `On — ${state.settings.nlAssist.url}`
    : "Optional. An endpoint that helps parse anything the built-in reader can't.";
  document.getElementById("btn-nlassist").textContent = state.settings.nlAssist ? "Change" : "Set up";
  document.getElementById("settings-points").textContent = state.points.total;
  document.getElementById("settings-streak").textContent = state.points.streak;
  document.getElementById("settings-level").textContent = state.points.level.name;

  refreshPushStatusUI();
}

function wireSettingsView() {
  document.getElementById("btn-add-term").addEventListener("click", () => openTermSheet(null));

  document.getElementById("reminder-offsets").addEventListener(
    "change",
    guarded(async (e) => {
      const arr = e.target.value
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      const { settings } = await api.updateSettings({ reminderOffsetsMinutes: arr });
      state.settings = settings;
      toast("Reminder times saved.");
    })
  );

  document.getElementById("theme-select").addEventListener(
    "change",
    guarded(async (e) => {
      const { settings } = await api.updateSettings({ theme: e.target.value });
      state.settings = settings;
      applyTheme();
    })
  );

  document.getElementById("passing-stepper").addEventListener(
    "click",
    guarded(async (e) => {
      const btn = e.target.closest("[data-passing-delta]");
      if (!btn) return;
      const cur = Number(state.settings.passingPeriodMaxMinutes ?? 15);
      const next = Math.max(1, Math.min(60, cur + Number(btn.dataset.passingDelta)));
      if (next === cur) return;
      const { settings } = await api.updateSettings({ passingPeriodMaxMinutes: next });
      state.settings = settings;
      renderAll();
    })
  );

  document.getElementById("btn-export-ics").addEventListener("click", () => {
    if (!state.activeTermId) return toast("Add a term first.");
    exportICS();
  });

  document.getElementById("btn-nlassist").addEventListener("click", openNlAssistSheet);

  document.getElementById("push-toggle-btn").addEventListener("click", async () => {
    const status = await currentPushStatus();
    try {
      if (status === "subscribed") {
        await disablePush();
        toast("Push notifications turned off on this device.");
      } else {
        await enablePush();
        toast("Push notifications enabled on this device.");
      }
    } catch (e) {
      toast(e.message, { ms: 5000 });
    }
    refreshPushStatusUI();
  });

  document.getElementById("btn-send-test-push").addEventListener("click", async () => {
    try {
      const { results } = await api.sendTestPush();
      const ok = results.filter((r) => r.ok).length;
      toast(`Sent to ${ok}/${results.length} device${results.length === 1 ? "" : "s"}.`);
    } catch (e) {
      toast(e.message, { ms: 5000 });
    }
  });

  document.getElementById("btn-logout").addEventListener("click", async () => {
    if (!confirm("Log out on this device?")) return;
    await api.logout().catch(() => {});
    setToken(null);
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      /* non-critical */
    }
    location.reload();
  });
}

async function refreshPushStatusUI() {
  const sub = document.getElementById("push-status-sub");
  const btn = document.getElementById("push-toggle-btn");
  const blocked = pushBlockedReason();
  if (blocked) {
    sub.textContent = blocked;
    btn.textContent = "Enable";
    return;
  }
  try {
    const status = await currentPushStatus();
    const labels = {
      subscribed: "On for this device.",
      "not-subscribed": "Off for this device.",
      denied: "Blocked — check your browser/OS notification settings.",
      unsupported: "Not supported in this browser.",
    };
    sub.textContent = labels[status] || "";
    btn.textContent = status === "subscribed" ? "Disable" : "Enable";
    btn.disabled = status === "denied" || status === "unsupported";
  } catch {
    sub.textContent = "Couldn't check notification status.";
  }
}

// ---- Natural-language assist endpoint ----
function openNlAssistSheet() {
  const cur = state.settings.nlAssist || {};
  openSheet(
    `
    <h2>Natural-language assist</h2>
    <p class="small text-muted" style="margin:-8px 0 14px;">Optional. When the built-in reader isn't sure what you typed, it can POST the text to an endpoint you control and use the structured result. Nothing is sent unless you set this. Leave blank and save to turn it off.</p>
    <div class="field"><label>Endpoint URL (https)</label><input type="text" id="nla-url" value="${escapeHtml(cur.url || "")}" placeholder="https://example.com/parse" /></div>
    <div class="field"><label>API key (optional)</label><input type="password" id="nla-key" value="${escapeHtml(cur.key || "")}" placeholder="sent as a Bearer token" /></div>
    <div class="sheet-actions">
      <button class="btn ghost" id="nla-cancel">Cancel</button>
      <button class="btn primary block" id="nla-save">Save</button>
    </div>
  `,
    {
      onMount: (root) => {
        root.querySelector("#nla-cancel").addEventListener("click", closeSheet);
        root.querySelector("#nla-save").addEventListener(
          "click",
          guarded(async () => {
            const url = root.querySelector("#nla-url").value.trim();
            const key = root.querySelector("#nla-key").value.trim();
            const nlAssist = url ? { url, ...(key ? { key } : {}) } : null;
            const { settings } = await api.updateSettings({ nlAssist });
            state.settings = settings;
            closeSheet();
            renderSettings();
            toast(nlAssist ? "Assist endpoint saved." : "Assist turned off.");
          })
        );
      },
    }
  );
}

// ---- .ics calendar export ----
function pad2(n) {
  return String(n).padStart(2, "0");
}
function icsStamp(d) {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}00Z`;
}
function icsEscape(s) {
  return String(s || "").replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
}

/** Build an .ics string: one event per assignment due date, plus a weekly recurring event per class meeting. */
function buildICS() {
  const term = activeTerm();
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//School//EN", "CALSCALE:GREGORIAN"];
  const now = new Date();

  for (const a of state.assignments) {
    const due = new Date(a.dueDate);
    if (Number.isNaN(due.getTime())) continue;
    const cls = classById(a.classId);
    lines.push(
      "BEGIN:VEVENT",
      `UID:asg-${a.id}@school`,
      `DTSTAMP:${icsStamp(now)}`,
      `DTSTART:${icsStamp(due)}`,
      `DTEND:${icsStamp(new Date(due.getTime() + 30 * 60000))}`,
      `SUMMARY:${icsEscape((cls ? cls.title + ": " : "") + a.title)}${a.status === "done" ? " (done)" : ""}`,
      a.notes ? `DESCRIPTION:${icsEscape(a.notes)}` : "DESCRIPTION:",
      "END:VEVENT"
    );
  }

  if (term) {
    const termEnd = new Date(term.endDate);
    const until = icsStamp(termEnd);
    for (const c of state.classes) {
      for (const m of meetingsForPeriod(c.period)) {
        // first occurrence: next date matching this weekday on/after term start
        const start = new Date(term.startDate);
        while (start.getDay() !== m.dow) start.setDate(start.getDate() + 1);
        const [sh, sm] = m.start.split(":").map(Number);
        const [eh, em] = m.end.split(":").map(Number);
        const dtStart = new Date(start.getFullYear(), start.getMonth(), start.getDate(), sh, sm);
        const dtEnd = new Date(start.getFullYear(), start.getMonth(), start.getDate(), eh, em);
        const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][m.dow];
        lines.push(
          "BEGIN:VEVENT",
          `UID:cls-${c.id}-${m.dow}@school`,
          `DTSTAMP:${icsStamp(now)}`,
          `DTSTART:${icsStamp(dtStart)}`,
          `DTEND:${icsStamp(dtEnd)}`,
          `RRULE:FREQ=WEEKLY;BYDAY=${BYDAY};UNTIL=${until}`,
          `SUMMARY:${icsEscape(c.title)}`,
          `LOCATION:${icsEscape(c.location || "")}`,
          "END:VEVENT"
        );
      }
    }
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function exportICS() {
  try {
    const blob = new Blob([buildICS()], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(activeTerm()?.name || "school").replace(/[^\w-]+/g, "-").toLowerCase()}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Calendar file exported.");
  } catch (e) {
    toast(e?.message || "Couldn't build the calendar file.", { ms: 4500 });
  }
}

// ---- Term add/edit sheet ----
function openTermSheet(term) {
  const isEdit = Boolean(term);
  openSheet(
    `
    <h2>${isEdit ? "Edit term" : "Add a term"}</h2>
    <div class="field"><label>Name</label><input type="text" id="term-name" value="${escapeHtml(term?.name || "")}" placeholder="Fall 2026" /></div>
    <div class="field-row">
      <div class="field"><label>Starts</label><input type="date" id="term-start" value="${term ? term.startDate.slice(0, 10) : ""}" /></div>
      <div class="field"><label>Ends</label><input type="date" id="term-end" value="${term ? term.endDate.slice(0, 10) : ""}" /></div>
    </div>
    <div class="sheet-actions">
      ${isEdit ? `<button class="btn danger" id="term-delete">Delete</button>` : ""}
      <button class="btn ghost" id="term-cancel">Cancel</button>
      <button class="btn primary block" id="term-save">Save</button>
    </div>
    ${isEdit ? `<button class="btn ghost block mt-16" id="term-archive">${term.archived ? "Unarchive (make current)" : "Archive"}</button>` : ""}
  `,
    {
      onMount: (root) => {
        root.querySelector("#term-cancel").addEventListener("click", closeSheet);
        root.querySelector("#term-archive")?.addEventListener(
          "click",
          guarded(async () => {
            if (term.archived) {
              await api.activateTerm(term.id); // activating auto-unarchives, per the backend
            } else {
              await api.updateTerm(term.id, { archived: true });
            }
            const { terms, activeTermId } = await api.listTerms();
            state.terms = terms;
            state.activeTermId = activeTermId;
            await loadTermScopedData();
            renderAll();
            closeSheet();
          })
        );
        if (isEdit) {
          root.querySelector("#term-delete").addEventListener("click", () => {
            const idx = state.terms.findIndex((t) => t.id === term.id);
            if (idx === -1) return;
            const wasActive = term.id === state.activeTermId;
            const snapshot = {
              term: state.terms[idx],
              activeTermId: state.activeTermId,
              classes: wasActive ? state.classes : null,
              assignments: wasActive ? state.assignments : null,
              daySchedule: wasActive ? state.daySchedule : null,
            };

            state.terms.splice(idx, 1);
            if (wasActive) {
              state.activeTermId = state.terms[0]?.id || null;
              state.classes = [];
              state.assignments = [];
              state.daySchedule = {};
            }
            closeSheet();
            renderAll();
            if (wasActive && state.activeTermId) {
              loadTermScopedData().then(renderAll);
            }

            scheduleDelete(
              term.name,
              () => api.deleteTerm(term.id),
              async () => {
                state.terms.splice(idx, 0, snapshot.term);
                if (wasActive) {
                  state.activeTermId = snapshot.activeTermId;
                  state.classes = snapshot.classes;
                  state.assignments = snapshot.assignments;
                  state.daySchedule = snapshot.daySchedule;
                  await api.activateTerm(snapshot.activeTermId).catch(() => {});
                }
                renderAll();
              }
            );
          });
        }
        root.querySelector("#term-save").addEventListener(
          "click",
          guarded(async () => {
            const name = document.getElementById("term-name").value.trim();
            const startDate = document.getElementById("term-start").value;
            const endDate = document.getElementById("term-end").value;
            if (!name || !startDate || !endDate) return toast("All fields are required.");
            const payload = { name, startDate: new Date(startDate).toISOString(), endDate: new Date(endDate).toISOString() };
            if (isEdit) await api.updateTerm(term.id, payload);
            else await api.createTerm(payload);
            // Term is saved server-side now — close before the refresh below
            // so a retry after a hiccup can never create a duplicate term.
            closeSheet();
            try {
              const { terms, activeTermId } = await api.listTerms();
              state.terms = terms;
              state.activeTermId = activeTermId;
              await loadTermScopedData();
              renderAll();
            } catch {
              toast("Saved, but couldn't refresh the view — switch tabs to reload.", { ms: 5000 });
            }
          })
        );
      },
    }
  );
}

function wireTopbar() {
  document.getElementById("term-switch").addEventListener("click", openTermSwitcherSheet);
  document.getElementById("level-badge").addEventListener("click", () => switchView("settings"));
  document.getElementById("topbar-search").addEventListener("click", openSearchSheet);
}

// ---- Search ----
function openSearchSheet() {
  if (!state.activeTermId) return toast("Add a term first.");
  openSheet(
    `
    <h2>Search</h2>
    <div class="field"><input type="text" id="search-input" placeholder="Classes, assignments, notes…" /></div>
    <div id="search-results"></div>
  `,
    {
      onMount: (root) => {
        const input = root.querySelector("#search-input");
        input.focus();
        let debounceTimer;
        input.addEventListener("input", () => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => runSearch(input.value), 300);
        });
      },
    }
  );
}

async function runSearch(query) {
  const resultsEl = document.getElementById("search-results");
  if (!resultsEl) return; // sheet already closed
  const q = query.trim();
  if (q.length < 2) {
    resultsEl.innerHTML = q.length === 0 ? "" : `<p class="small" style="color:var(--text-tertiary); padding:8px 2px;">Keep typing (2+ characters)…</p>`;
    return;
  }
  try {
    const { classes, assignments } = await api.search(state.activeTermId, q);
    if (classes.length === 0 && assignments.length === 0) {
      resultsEl.innerHTML = emptyState("🔍", "No matches", "Try a different search term.");
      return;
    }
    let html = "";
    if (classes.length) {
      html += `<div class="section-title">Classes</div><div class="list-card">${classes.map(searchClassRow).join("")}</div>`;
    }
    if (assignments.length) {
      html += `<div class="section-title">Assignments</div><div class="list-card">${assignments.map((a) => assignmentFlapRow(a)).join("")}</div>`;
    }
    resultsEl.innerHTML = html;
    resultsEl.querySelectorAll("[data-class-id]").forEach((row) => {
      row.addEventListener("click", () => {
        closeSheet();
        goToClass(row.dataset.classId);
      });
    });
    resultsEl.querySelectorAll("[data-assignment-id]").forEach((row) => {
      row.addEventListener("click", () => {
        closeSheet();
        const a = assignments.find((x) => x.id === row.dataset.assignmentId);
        if (a) openAssignmentSheet(a);
      });
    });
  } catch (e) {
    resultsEl.innerHTML = `<p class="small" style="color:var(--danger); padding:8px 2px;">${escapeHtml(e.message || "Search failed.")}</p>`;
  }
}

function searchClassRow(c) {
  return `<div class="list-row" data-class-id="${c.id}">
    <div class="row-time rounded">P${escapeHtml(c.period)}</div>
    <div class="row-body">
      <div class="row-title">${escapeHtml(c.title)}</div>
      <div class="row-sub">${escapeHtml(c.instructor || c.location || "")}${c.matchedInNotes ? " · matched in notes" : ""}</div>
    </div>
    <span class="chevron">${CHEVRON_SVG}</span>
  </div>`;
}

function openTermSwitcherSheet() {
  const liveTerms = state.terms.filter((t) => !t.archived);
  openSheet(
    `
    <h2>Switch term</h2>
    <div class="settings-list">
      ${liveTerms
        .map(
          (t) => `<div class="settings-row" style="cursor:pointer;" data-pick-term="${t.id}">
            <div class="label">${t.id === state.activeTermId ? "✓ " : ""}${escapeHtml(t.name)}</div>
          </div>`
        )
        .join("") || `<div class="settings-row"><div class="sub">No terms yet.</div></div>`}
    </div>
    <button class="btn ghost block mt-16" id="switcher-add-term">Add a term</button>
  `,
    {
      onMount: (root) => {
        root.querySelectorAll("[data-pick-term]").forEach((row) =>
          row.addEventListener(
            "click",
            guarded(async () => {
              await api.activateTerm(row.dataset.pickTerm);
              state.activeTermId = row.dataset.pickTerm;
              await loadTermScopedData();
              renderAll();
              closeSheet();
            })
          )
        );
        root.querySelector("#switcher-add-term").addEventListener("click", () => openTermSheet(null));
      },
    }
  );
}

// ===========================================================
// Theme
// ===========================================================
function applyTheme() {
  const pref = state.settings.theme || "system";
  let effective = pref;
  if (pref === "system") {
    effective = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", effective);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", effective === "dark" ? "#000000" : "#f2f2f7");
}
