import { api, getToken, setToken } from "./api.js";
import { enablePush, disablePush, currentPushStatus, pushBlockedReason } from "./push.js";
import { parseSyllabusText } from "./syllabus-parser.js";
import { parseNaturalDueDate } from "./date-parse.js";

// ===========================================================
// State
// ===========================================================
const state = {
  terms: [],
  activeTermId: null,
  classes: [],
  assignments: [],
  daySchedule: {},
  todos: [],
  points: { total: 0, streak: 0, level: { name: "Freshman Focus", next: null } },
  settings: { reminderOffsetsMinutes: [1440, 60], theme: "system" },
  focus: { until: null },
  currentView: "today",
  calCursor: startOfMonth(new Date()),
  calSelected: new Date(),
};

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = ["S", "M", "T", "W", "T", "F", "S"];

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

  setInterval(tickClock, 30000);
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
    return;
  }
  const [{ classes }, { assignments }, { daySchedule }] = await Promise.all([
    api.listClasses(state.activeTermId),
    api.listAssignments(state.activeTermId),
    api.getDaySchedule(state.activeTermId),
  ]);
  state.classes = classes;
  state.assignments = assignments;
  state.daySchedule = daySchedule;
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

/** Ordered list of { period, start, end } slots for a weekday, or [] if no school that day / not configured yet. */
function periodsForWeekday(dow) {
  const day = state.daySchedule[String(dow)];
  return Array.isArray(day) ? day : [];
}

/** This weekday's period slots, each paired with its matched class (or null if unassigned), in time order. */
function scheduleForWeekday(dow) {
  return periodsForWeekday(dow)
    .map((slot) => ({ ...slot, cls: classByPeriod(slot.period) }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** All distinct period labels currently defined anywhere in the day schedule, in first-seen order. */
function knownPeriodLabels() {
  const seen = [];
  for (const dow of DAY_ORDER) {
    for (const slot of periodsForWeekday(dow)) {
      if (!seen.includes(slot.period)) seen.push(slot.period);
    }
  }
  return seen;
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
  const known = ["today", "schedule", "assignments", "calendar", "focus", "settings"];
  switchView(known.includes(hash) ? hash : "today");
}

function switchView(name) {
  state.currentView = name;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));

  const addBtn = document.getElementById("topbar-add");
  addBtn.classList.toggle("hidden", name !== "schedule" && name !== "assignments");
}

function wireFab() {
  document.getElementById("topbar-add").addEventListener("click", () => {
    if (!state.activeTermId) return openTermSheet(null);
    if (state.currentView === "schedule") openClassSheet(null);
    else if (state.currentView === "assignments") openAssignmentSheet(null);
  });
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
  const todaysClasses = scheduleForWeekday(todayDow).filter((s) => s.cls);

  if (todaysClasses.length) {
    const gaps = computeFreePeriods(todaysClasses);
    let html = "";
    todaysClasses.forEach((s, i) => {
      html += classFlapRow(s);
      const gap = gaps.find((g) => g.afterIndex === i);
      if (gap) html += freePeriodRow(gap);
    });
    classesEl.innerHTML = html;
  } else {
    classesEl.innerHTML = emptyState("☀️", "No classes today", periodsForWeekday(todayDow).length ? "Free periods today." : "Enjoy the free day.");
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

  document.getElementById("stat-classes-today").textContent = todaysClasses.length;
  document.getElementById("stat-due-today").textContent = pending.filter((a) => isSameDay(new Date(a.dueDate), new Date())).length;
  document.getElementById("stat-overdue").textContent = pending.filter((a) => new Date(a.dueDate) < new Date()).length;

  renderHeatmap();
  bindFlapRowClicks(classesEl, upcomingEl);
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

/** Gaps of 20+ minutes between consecutive classes today, suggested as focus-session slots. */
function computeFreePeriods(classSlots) {
  const MIN_GAP_MINUTES = 20;
  const gaps = [];
  for (let i = 0; i < classSlots.length - 1; i++) {
    const gapMin = timeStrToMinutes(classSlots[i + 1].start) - timeStrToMinutes(classSlots[i].end);
    if (gapMin >= MIN_GAP_MINUTES) {
      gaps.push({ afterIndex: i, start: classSlots[i].end, end: classSlots[i + 1].start, minutes: gapMin });
    }
  }
  return gaps;
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
  return `<div class="list-row" data-class-id="${c.id}">
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
  return `<div class="list-row assignment-row${a.status === "done" ? " done" : ""}" data-assignment-id="${a.id}">
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
        openClassSheet(classById(row.dataset.classId));
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
  const el = document.getElementById("schedule-week");
  if (!state.activeTermId) {
    el.innerHTML = emptyState("🗓️", "No term yet", "Add a term in Settings, then build your weekly schedule here.");
    return;
  }
  const configuredDays = DAY_ORDER.filter((dow) => periodsForWeekday(dow).length > 0);
  if (configuredDays.length === 0) {
    el.innerHTML = emptyState("🔔", "Set up your bell schedule", "Tap \"Edit bell schedule\" above to enter which periods meet on each day — then you can assign classes to periods.");
    return;
  }
  let html = "";
  for (const dow of configuredDays) {
    const slots = scheduleForWeekday(dow);
    html += `<div class="section-title">${DAY_NAMES[dow]}</div><div class="list-card">`;
    html += slots.map((s) => classFlapRow(s)).join("");
    html += `</div>`;
  }
  el.innerHTML = html;
  bindFlapRowClicks(el);
}

function wireScheduleView() {
  document.getElementById("btn-edit-dayschedule").addEventListener("click", () => {
    if (!state.activeTermId) return toast("Add a term first.");
    openDayScheduleOverviewSheet();
  });
}

// ---- Bell schedule (day schedule) editor ----
function openDayScheduleOverviewSheet() {
  const rows = DAY_ORDER.map((dow) => {
    const raw = state.daySchedule[String(dow)];
    const configured = raw !== undefined;
    const slots = Array.isArray(raw) ? raw : [];
    let sub;
    if (!configured) sub = "Not set up";
    else if (slots.length === 0) sub = "No school";
    else {
      const first = [...slots].sort((a, b) => a.start.localeCompare(b.start))[0];
      sub = `${slots.length} period${slots.length === 1 ? "" : "s"}, starts ${timeStrToLabel(first.start)}`;
    }
    return `<div class="settings-row" style="cursor:pointer;" data-edit-day="${dow}">
      <div>
        <div class="label">${DAY_NAMES[dow]}</div>
        <div class="sub">${sub}</div>
      </div>
      <span class="chevron">${CHEVRON_SVG}</span>
    </div>`;
  }).join("");

  openSheet(
    `
    <h2>Bell schedule</h2>
    <p class="small" style="color:var(--text-secondary); margin:-8px 0 14px;">Set which periods meet each day, and their times. When you add a class you'll just pick a period — the days and times come from here, so a period that isn't scheduled on a given day (like Wednesdays) simply won't show a class that day.</p>
    <div class="settings-list">${rows}</div>
    <button class="btn ghost block mt-16" id="dayschedule-done">Done</button>
  `,
    {
      onMount: (root) => {
        root.querySelectorAll("[data-edit-day]").forEach((row) => {
          row.addEventListener("click", () => openDayEditorSheet(Number(row.dataset.editDay)));
        });
        root.querySelector("#dayschedule-done").addEventListener("click", closeSheet);
      },
    }
  );
}

function openDayEditorSheet(dow) {
  const existing = state.daySchedule[String(dow)];
  let periods = Array.isArray(existing) ? existing.map((p) => ({ ...p })) : [];
  let noSchool = existing === null;

  const otherDaysWithData = DAY_ORDER.filter(
    (d) => d !== dow && Array.isArray(state.daySchedule[String(d)]) && state.daySchedule[String(d)].length > 0
  );

  function rowsHTML() {
    if (periods.length === 0) {
      return `<p class="small" style="color:var(--text-tertiary); padding:6px 2px 10px;">No periods yet — add one below.</p>`;
    }
    return periods
      .map(
        (p, i) => `
      <div class="period-row" data-idx="${i}">
        <input type="text" class="period-label" data-field="period" value="${escapeHtml(p.period)}" placeholder="1" />
        <input type="time" data-field="start" value="${p.start || ""}" />
        <input type="time" data-field="end" value="${p.end || ""}" />
        <button type="button" class="period-remove" data-remove="${i}" aria-label="Remove period">${CLOSE_SVG}</button>
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
      <label style="font-size:12.5px; font-weight:600; color:var(--text-secondary); display:block; margin-bottom:8px;">Periods, in order</label>
      <div id="period-rows">${rowsHTML()}</div>
      <button type="button" class="btn ghost block mt-8" id="add-period">+ Add period</button>
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

        function refreshRows() {
          rowsEl.innerHTML = rowsHTML();
        }

        root.querySelector("#day-meets").addEventListener("change", (e) => {
          noSchool = !e.target.checked;
          wrap.classList.toggle("hidden", noSchool);
        });

        root.querySelector("#day-copy-from")?.addEventListener("change", (e) => {
          if (!e.target.value) return;
          periods = (state.daySchedule[e.target.value] || []).map((p) => ({ ...p }));
          refreshRows();
        });

        root.querySelector("#add-period").addEventListener("click", () => {
          periods.push({ period: "", start: "", end: "" });
          refreshRows();
        });

        rowsEl.addEventListener("click", (e) => {
          const btn = e.target.closest("[data-remove]");
          if (!btn) return;
          periods.splice(Number(btn.dataset.remove), 1);
          refreshRows();
        });

        rowsEl.addEventListener("input", (e) => {
          const rowEl = e.target.closest("[data-idx]");
          const field = e.target.dataset.field;
          if (!rowEl || !field) return;
          periods[Number(rowEl.dataset.idx)][field] = e.target.value;
        });

        root.querySelector("#day-cancel").addEventListener("click", closeSheet);

        root.querySelector("#day-save").addEventListener(
          "click",
          guarded(async () => {
            if (noSchool) {
              await api.setDaySchedule(state.activeTermId, dow, null);
            } else {
              const cleaned = periods.map((p) => ({ period: p.period.trim(), start: p.start, end: p.end }));
              if (cleaned.length === 0) return toast('Add at least one period, or turn off "School meets this day."');
              if (cleaned.some((p) => !p.period)) return toast("Every period needs a label.");
              if (cleaned.some((p) => !p.start || !p.end)) return toast("Every period needs a start and end time.");
              await api.setDaySchedule(state.activeTermId, dow, cleaned);
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

function openClassSheet(cls, { prefillPeriod } = {}) {
  const isEdit = Boolean(cls);
  const periodOptions = knownPeriodLabels();
  const currentPeriod = cls?.period || prefillPeriod || "";

  openSheet(
    `
    <h2>${isEdit ? "Edit class" : "Add class"}</h2>
    <div class="field"><label>Class name</label><input type="text" id="cls-title" value="${escapeHtml(cls?.title || "")}" placeholder="Organic Chemistry" /></div>
    <div class="field">
      <label>Period</label>
      <input type="text" id="cls-period" list="cls-period-options" value="${escapeHtml(currentPeriod)}" placeholder="e.g. 3, or WIN" />
      <datalist id="cls-period-options">
        ${periodOptions.map((p) => `<option value="${escapeHtml(p)}"></option>`).join("")}
      </datalist>
      <p class="small" style="color:var(--text-tertiary); margin:6px 2px 0;">Which days and times this meets comes from your bell schedule — set that up under Schedule → Edit bell schedule.</p>
    </div>
    <div class="field-row">
      <div class="field"><label>Instructor</label><input type="text" id="cls-instructor" value="${escapeHtml(cls?.instructor || "")}" /></div>
      <div class="field"><label>Location</label><input type="text" id="cls-location" value="${escapeHtml(cls?.location || "")}" /></div>
    </div>
    <div class="field"><label>Notes</label><textarea id="cls-notes" placeholder="Syllabus links, office hours, textbook info…"></textarea></div>
    <div class="sheet-actions">
      ${isEdit ? `<button class="btn danger" id="cls-delete">Delete</button>` : ""}
      <button class="btn ghost" id="cls-cancel">Cancel</button>
      <button class="btn primary block" id="cls-save">Save</button>
    </div>
  `,
    {
      onMount: async (root) => {
        root.querySelector("#cls-cancel").addEventListener("click", closeSheet);

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
              instructor: document.getElementById("cls-instructor").value.trim(),
              location: document.getElementById("cls-location").value.trim(),
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
// ASSIGNMENTS view
// ===========================================================
function renderAssignments() {
  const pendingEl = document.getElementById("assignments-pending");
  const doneEl = document.getElementById("assignments-done");
  renderTodos(); // independent of term — always render regardless of what's below

  if (!state.activeTermId) {
    pendingEl.innerHTML = emptyState("📋", "No term yet", "Add a term in Settings to start tracking assignments.");
    doneEl.innerHTML = "";
    return;
  }

  const pending = [...state.assignments].filter((a) => a.status !== "done").sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  const done = [...state.assignments].filter((a) => a.status === "done").sort((a, b) => b.completedAt - a.completedAt);

  pendingEl.innerHTML = pending.length ? pending.map((a, i) => assignmentFlapRow(a, i)).join("") : emptyState("🎉", "All clear", "No pending assignments.");
  doneEl.innerHTML = done.length ? done.slice(0, 20).map((a, i) => assignmentFlapRow(a, i)).join("") : emptyState("—", "Nothing completed yet", "");

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

// ---- Quick add (natural-language assignment entry) ----
function wireQuickAdd() {
  const submit = guarded(async () => {
    const input = document.getElementById("quick-add-input");
    const text = input.value.trim();
    if (!text) return;
    if (!state.activeTermId) return toast("Add a term first.");

    const parsed = parseNaturalDueDate(text, { now: new Date(), term: activeTerm() });
    if (!parsed) {
      // No date found in the text — open the full sheet with the title
      // prefilled rather than silently failing or guessing a date.
      input.value = "";
      openAssignmentSheet(null, { prefillTitle: text });
      return;
    }

    const title = text.replace(parsed.matchedText, "").replace(/^(due|is due|due on|due by)\b[:,-]?\s*/i, "").trim() || text;
    await api.createAssignment(state.activeTermId, { title, dueDate: parsed.date.toISOString(), priority: "medium" });
    input.value = "";
    await loadTermScopedData();
    renderAll();
    toast(`Added — due ${parsed.date.toLocaleDateString([], { month: "short", day: "numeric" })} at ${parsed.date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
  });

  document.getElementById("quick-add-submit").addEventListener("click", submit);
  document.getElementById("quick-add-input").addEventListener("keydown", (e) => {
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

function openAssignmentSheet(assignment, { prefillTitle } = {}) {
  const isEdit = Boolean(assignment);
  const dueLocal = assignment ? toDatetimeLocalValue(new Date(assignment.dueDate)) : defaultDueLocal();
  const term = activeTerm();
  const defaultRepeatUntil = term ? term.endDate.slice(0, 10) : "";
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
    <div class="field"><label>Title</label><input type="text" id="asg-title" value="${escapeHtml(assignment?.title || prefillTitle || "")}" placeholder="Essay 2 draft" /></div>
    <div class="field">
      <label>Class (optional)</label>
      <select id="asg-class">
        <option value="">No class</option>
        ${state.classes.map((c) => `<option value="${c.id}" ${assignment?.classId === c.id ? "selected" : ""}>${escapeHtml(c.title)}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Due</label><input type="datetime-local" id="asg-due" value="${dueLocal}" /></div>
    <div class="field-row">
      <div class="field">
        <label>Priority</label>
        <select id="asg-priority">
          <option value="low" ${assignment?.priority === "low" ? "selected" : ""}>Low</option>
          <option value="medium" ${!assignment || assignment.priority === "medium" ? "selected" : ""}>Medium</option>
          <option value="high" ${assignment?.priority === "high" ? "selected" : ""}>High</option>
        </select>
      </div>
      <div class="field">
        <label>Est. time</label>
        <select id="asg-effort">
          ${EFFORT_OPTIONS.map(([v, l]) => `<option value="${v}" ${String(assignment?.estimatedMinutes || "") === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="field">
      <label>Link (optional)</label>
      <input type="text" id="asg-link" value="${escapeHtml(assignment?.link || "")}" placeholder="Canvas, Google Doc, etc." />
    </div>
    <div class="field"><label>Notes</label><textarea id="asg-notes">${escapeHtml(assignment?.notes || "")}</textarea></div>
    ${
      !isEdit
        ? `<div class="field">
          <div class="settings-row" style="padding:0 0 10px; background:none;">
            <div class="label">Repeat weekly</div>
            <label class="switch"><input type="checkbox" id="asg-repeat" /><span class="track"></span></label>
          </div>
          <div id="asg-repeat-until-wrap" class="hidden">
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
  const classesThatDay = scheduleForWeekday(dow).filter((s) => s.cls);
  const assignmentsThatDay = state.assignments.filter((a) => isSameDay(new Date(a.dueDate), d));

  if (classesThatDay.length === 0 && assignmentsThatDay.length === 0) {
    el.innerHTML = emptyState("—", d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }), "Nothing scheduled.");
    return;
  }
  el.innerHTML = classesThatDay.map((s) => classFlapRow(s)).join("") + assignmentsThatDay.map((a) => assignmentFlapRow(a)).join("");
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
        openClassSheet(classById(row.dataset.classId));
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
