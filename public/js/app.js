import { api, getToken, setToken } from "./api.js";
import { enablePush, disablePush, currentPushStatus, pushBlockedReason } from "./push.js";
import { parseSyllabusText } from "./syllabus-parser.js";

// ===========================================================
// State
// ===========================================================
const state = {
  terms: [],
  activeTermId: null,
  classes: [],
  assignments: [],
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
const CLASS_COLORS = ["#5B8DEF", "#EF6A5B", "#5BCB77", "#F2B84B", "#B15BEF", "#3EC6C0", "#EF5B9C"];

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

  const authStatus = await api.authStatus().catch(() => ({ hasPasscode: false }));

  if (getToken()) {
    try {
      await loadAll();
      showApp();
      handleHashRoute();
    } catch {
      showAuth(authStatus.hasPasscode);
    }
  } else {
    showAuth(authStatus.hasPasscode);
  }

  setInterval(tickClock, 30000);
  tickClock();
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
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
  const [{ terms, activeTermId }, points, settings, focus] = await Promise.all([
    api.listTerms(),
    api.getPoints(),
    api.getSettings(),
    api.getFocus(),
  ]);
  state.terms = terms;
  state.activeTermId = activeTermId;
  state.points = points;
  state.settings = settings.settings;
  state.focus = focus.focus;

  await loadTermScopedData();
  renderAll();
  syncFocusFromServer();
}

async function loadTermScopedData() {
  if (!state.activeTermId) {
    state.classes = [];
    state.assignments = [];
    return;
  }
  const [{ classes }, { assignments }] = await Promise.all([
    api.listClasses(state.activeTermId),
    api.listAssignments(state.activeTermId),
  ]);
  state.classes = classes;
  state.assignments = assignments;
}

function activeTerm() {
  return state.terms.find((t) => t.id === state.activeTermId) || null;
}

function classById(id) {
  return state.classes.find((c) => c.id === id) || null;
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
}

function renderTopbar() {
  const term = activeTerm();
  document.getElementById("term-switch-label").textContent = term ? term.name : "Add a term";
  document.getElementById("level-name").textContent = state.points.level.name;
  document.getElementById("level-points").textContent = state.points.total;

  const dueToday = state.assignments.filter((a) => a.status !== "done" && isSameDay(new Date(a.dueDate), new Date())).length;
  const overdue = state.assignments.filter((a) => a.status !== "done" && new Date(a.dueDate) < new Date()).length;
  document.getElementById("tasks-dot").classList.toggle("hidden", dueToday + overdue === 0);
}

// ===========================================================
// Tabbar / view switching
// ===========================================================
function wireTabbar() {
  document.querySelectorAll(".tabbar button").forEach((btn) => {
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
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));

  const fab = document.getElementById("fab-add");
  if (name === "schedule" || name === "assignments") {
    fab.classList.remove("hidden");
  } else {
    fab.classList.add("hidden");
  }
}

function wireFab() {
  document.getElementById("fab-add").addEventListener("click", () => {
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
function toast(message, { celebrate = false, ms = 2800 } = {}) {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = `toast${celebrate ? " celebrate" : ""}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), ms);
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
    renderHeatmap();
    return;
  }

  const todayDow = new Date().getDay();
  const todaysClasses = state.classes.filter((c) => c.days.includes(todayDow)).sort((a, b) => a.startTime.localeCompare(b.startTime));

  classesEl.innerHTML = todaysClasses.length
    ? todaysClasses.map((c, i) => classFlapRow(c, i)).join("")
    : emptyState("☀️", "No classes today", "Enjoy the free day.");

  const pending = state.assignments.filter((a) => a.status !== "done").sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  const upcoming = pending.slice(0, 6);
  upcomingEl.innerHTML = upcoming.length
    ? upcoming.map((a, i) => assignmentFlapRow(a, i)).join("")
    : emptyState("🎉", "Nothing due", "You're all caught up.");

  document.getElementById("stat-classes-today").textContent = todaysClasses.length;
  document.getElementById("stat-due-today").textContent = pending.filter((a) => isSameDay(new Date(a.dueDate), new Date())).length;
  document.getElementById("stat-overdue").textContent = pending.filter((a) => new Date(a.dueDate) < new Date()).length;

  renderHeatmap();
  bindFlapRowClicks(classesEl, upcomingEl);
}

function renderHeatmap() {
  const el = document.getElementById("workload-heatmap");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let html = "";
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    const count = state.assignments.filter((a) => a.status !== "done" && isSameDay(new Date(a.dueDate), d)).length;
    const level = count === 0 ? 0 : count === 1 ? 1 : count === 2 ? 2 : 3;
    html += `<div class="col">
      <div class="day-label">${DAY_SHORT[d.getDay()]}</div>
      <div class="cell${i === 0 ? " today" : ""}" data-level="${level}">${count || ""}</div>
    </div>`;
  }
  el.innerHTML = html;
}

function emptyState(glyph, title, sub) {
  return `<div class="empty-state"><div class="glyph">${glyph}</div><p><strong>${escapeHtml(title)}</strong></p><p>${escapeHtml(sub)}</p></div>`;
}

function classFlapRow(c, i) {
  return `<div class="flap-row flap-in" style="--rail:${c.color}; animation-delay:${i * 0.04}s" data-class-id="${c.id}">
    <div class="flap-time mono">${timeStrToLabel(c.startTime)}</div>
    <div class="flap-body">
      <div class="flap-title">${escapeHtml(c.title)}</div>
      <div class="flap-sub">${escapeHtml(c.location || c.instructor || "")}</div>
    </div>
  </div>`;
}

function assignmentFlapRow(a, i) {
  const cls = a.classId ? classById(a.classId) : null;
  const due = dueLabel(a.dueDate);
  return `<div class="flap-row flap-in assignment-row${a.status === "done" ? " done" : ""}" style="--rail:${cls ? cls.color : "var(--text-muted)"}; animation-delay:${i * 0.04}s" data-assignment-id="${a.id}">
    <button class="check" data-toggle-complete="${a.id}" aria-label="Mark complete">✓</button>
    <div class="flap-body">
      <div class="flap-title"><span class="priority-dot priority-${a.priority}"></span>${escapeHtml(a.title)}</div>
      <div class="flap-sub">${cls ? escapeHtml(cls.title) + " · " : ""}${due.text}${due.overdue && a.status !== "done" ? " · overdue" : ""}</div>
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
  if (!a) return;
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
  if (state.classes.length === 0) {
    el.innerHTML = emptyState("➕", "No classes yet", "Tap the + button to add your first class, or paste a syllabus from the Tasks tab.");
    return;
  }
  let html = "";
  for (const dow of DAY_ORDER) {
    const dayClasses = state.classes.filter((c) => c.days.includes(dow)).sort((a, b) => a.startTime.localeCompare(b.startTime));
    if (dayClasses.length === 0) continue;
    html += `<div class="section-title">${DAY_NAMES[dow]}</div><div class="flap-list">`;
    html += dayClasses.map((c, i) => classFlapRow(c, i)).join("");
    html += `</div>`;
  }
  el.innerHTML = html;
  bindFlapRowClicks(el);
}

function wireScheduleView() {
  // class sheet opened via bindFlapRowClicks / FAB
}

function openClassSheet(cls) {
  const isEdit = Boolean(cls);
  const days = cls?.days || [];
  const color = cls?.color || CLASS_COLORS[state.classes.length % CLASS_COLORS.length];

  openSheet(
    `
    <h2>${isEdit ? "Edit class" : "Add class"}</h2>
    <div class="field"><label>Class name</label><input type="text" id="cls-title" value="${escapeHtml(cls?.title || "")}" placeholder="Organic Chemistry" /></div>
    <div class="field-row">
      <div class="field"><label>Instructor</label><input type="text" id="cls-instructor" value="${escapeHtml(cls?.instructor || "")}" /></div>
      <div class="field"><label>Location</label><input type="text" id="cls-location" value="${escapeHtml(cls?.location || "")}" /></div>
    </div>
    <div class="field">
      <label>Days</label>
      <div class="day-picker" id="cls-days">
        ${DAY_ORDER.map((d) => `<button type="button" data-day="${d}" class="${days.includes(d) ? "selected" : ""}">${DAY_SHORT[d]}</button>`).join("")}
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>Starts</label><input type="time" id="cls-start" value="${cls?.startTime || "09:00"}" /></div>
      <div class="field"><label>Ends</label><input type="time" id="cls-end" value="${cls?.endTime || "09:50"}" /></div>
    </div>
    <div class="field">
      <label>Color</label>
      <div class="color-picker" id="cls-color">
        ${CLASS_COLORS.map((c) => `<button type="button" data-color="${c}" style="background:${c}" class="${c === color ? "selected" : ""}"></button>`).join("")}
      </div>
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
        root.querySelectorAll("#cls-days button").forEach((b) => b.addEventListener("click", () => b.classList.toggle("selected")));
        root.querySelectorAll("#cls-color button").forEach((b) =>
          b.addEventListener("click", () => {
            root.querySelectorAll("#cls-color button").forEach((x) => x.classList.remove("selected"));
            b.classList.add("selected");
          })
        );
        root.querySelector("#cls-cancel").addEventListener("click", closeSheet);

        if (isEdit) {
          api.getNotes(cls.id).then(({ note }) => {
            const ta = document.getElementById("cls-notes");
            if (ta) ta.value = note.content;
          });
          root.querySelector("#cls-delete").addEventListener("click", async () => {
            if (!confirm(`Delete ${cls.title}? This won't delete its assignments.`)) return;
            await api.deleteClass(state.activeTermId, cls.id);
            await loadTermScopedData();
            renderAll();
            closeSheet();
          });
        }

        root.querySelector("#cls-save").addEventListener("click", async () => {
          const title = document.getElementById("cls-title").value.trim();
          if (!title) return toast("Class name is required.");
          const selectedDays = [...root.querySelectorAll("#cls-days button.selected")].map((b) => Number(b.dataset.day));
          if (selectedDays.length === 0) return toast("Pick at least one day.");
          const selectedColor = root.querySelector("#cls-color button.selected")?.dataset.color || color;
          const payload = {
            title,
            instructor: document.getElementById("cls-instructor").value.trim(),
            location: document.getElementById("cls-location").value.trim(),
            days: selectedDays,
            startTime: document.getElementById("cls-start").value,
            endTime: document.getElementById("cls-end").value,
            color: selectedColor,
          };
          let savedClass;
          if (isEdit) {
            const res = await api.updateClass(state.activeTermId, cls.id, payload);
            savedClass = res.class;
          } else {
            const res = await api.createClass(state.activeTermId, payload);
            savedClass = res.class;
          }
          const notesContent = document.getElementById("cls-notes").value;
          await api.saveNotes(savedClass.id, notesContent);
          await loadTermScopedData();
          renderAll();
          closeSheet();
        });
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
}

function openAssignmentSheet(assignment) {
  const isEdit = Boolean(assignment);
  const dueLocal = assignment ? toDatetimeLocalValue(new Date(assignment.dueDate)) : defaultDueLocal();

  openSheet(
    `
    <h2>${isEdit ? "Edit assignment" : "Add assignment"}</h2>
    <div class="field"><label>Title</label><input type="text" id="asg-title" value="${escapeHtml(assignment?.title || "")}" placeholder="Essay 2 draft" /></div>
    <div class="field">
      <label>Class (optional)</label>
      <select id="asg-class">
        <option value="">No class</option>
        ${state.classes.map((c) => `<option value="${c.id}" ${assignment?.classId === c.id ? "selected" : ""}>${escapeHtml(c.title)}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Due</label><input type="datetime-local" id="asg-due" value="${dueLocal}" /></div>
    <div class="field">
      <label>Priority</label>
      <select id="asg-priority">
        <option value="low" ${assignment?.priority === "low" ? "selected" : ""}>Low</option>
        <option value="medium" ${!assignment || assignment.priority === "medium" ? "selected" : ""}>Medium</option>
        <option value="high" ${assignment?.priority === "high" ? "selected" : ""}>High</option>
      </select>
    </div>
    <div class="field"><label>Notes</label><textarea id="asg-notes">${escapeHtml(assignment?.notes || "")}</textarea></div>
    <div class="sheet-actions">
      ${isEdit ? `<button class="btn danger" id="asg-delete">Delete</button>` : ""}
      <button class="btn ghost" id="asg-cancel">Cancel</button>
      <button class="btn primary block" id="asg-save">Save</button>
    </div>
    ${isEdit ? `<button class="btn ghost block mt-16" id="asg-toggle">${assignment.status === "done" ? "Mark as not done" : "Mark complete"}</button>` : ""}
  `,
    {
      onMount: (root) => {
        root.querySelector("#asg-cancel").addEventListener("click", closeSheet);

        if (isEdit) {
          root.querySelector("#asg-delete").addEventListener("click", async () => {
            if (!confirm(`Delete "${assignment.title}"?`)) return;
            await api.deleteAssignment(state.activeTermId, assignment.id);
            await loadTermScopedData();
            renderAll();
            closeSheet();
          });
          root.querySelector("#asg-toggle").addEventListener("click", async () => {
            await toggleComplete(assignment.id);
            closeSheet();
          });
        }

        root.querySelector("#asg-save").addEventListener("click", async () => {
          const title = document.getElementById("asg-title").value.trim();
          const dueVal = document.getElementById("asg-due").value;
          if (!title || !dueVal) return toast("Title and due date are required.");
          const payload = {
            title,
            classId: document.getElementById("asg-class").value || null,
            dueDate: new Date(dueVal).toISOString(),
            priority: document.getElementById("asg-priority").value,
            notes: document.getElementById("asg-notes").value,
          };
          if (isEdit) await api.updateAssignment(state.activeTermId, assignment.id, payload);
          else await api.createAssignment(state.activeTermId, payload);
          await loadTermScopedData();
          renderAll();
          closeSheet();
        });
      },
    }
  );
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
        <div class="card" style="padding:10px; margin-bottom:8px;" data-row="${i}">
          <div style="display:flex; gap:8px; align-items:center;">
            <input type="checkbox" checked data-syl-include="${i}" />
            <input type="text" value="${escapeHtml(r.title)}" data-syl-title="${i}" style="flex:1; background:var(--surface-2); border:1px solid var(--border); border-radius:6px; padding:6px 8px; color:var(--text);" />
          </div>
          <div style="display:flex; gap:8px; margin-top:8px;">
            <input type="datetime-local" value="${toDatetimeLocalValue(new Date(r.date))}" data-syl-date="${i}" style="flex:1; background:var(--surface-2); border:1px solid var(--border); border-radius:6px; padding:6px 8px; color:var(--text);" />
            <select data-syl-class="${i}" style="background:var(--surface-2); border:1px solid var(--border); border-radius:6px; padding:6px 8px; color:var(--text);">
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
  document.getElementById("syl-import").addEventListener("click", async () => {
    const rowsEls = [...document.querySelectorAll("#syl-rows [data-row]")];
    let count = 0;
    for (const rowEl of rowsEls) {
      const i = rowEl.dataset.row;
      const include = rowEl.querySelector(`[data-syl-include="${i}"]`).checked;
      if (!include) continue;
      const title = rowEl.querySelector(`[data-syl-title="${i}"]`).value.trim();
      const dueVal = rowEl.querySelector(`[data-syl-date="${i}"]`).value;
      const classId = rowEl.querySelector(`[data-syl-class="${i}"]`).value || null;
      if (!title || !dueVal) continue;
      await api.createAssignment(state.activeTermId, {
        title,
        dueDate: new Date(dueVal).toISOString(),
        classId,
        priority: "medium",
      });
      count++;
    }
    await loadTermScopedData();
    renderAll();
    closeSheet();
    toast(`Imported ${count} item${count === 1 ? "" : "s"}.`);
  });
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
      .map((a) => {
        const cls = a.classId ? classById(a.classId) : null;
        return `<span style="background:${cls ? cls.color : "var(--text-muted)"}"></span>`;
      })
      .join("");
    html += `<div class="month-cell${inMonth ? "" : " other-month"}${isSameDay(cellDate, today) ? " today" : ""}" data-date="${cellDate.toISOString()}">
      <div class="n">${cellDate.getDate()}</div>
      <div class="dots">${dots}</div>
    </div>`;
  }
  grid.innerHTML = html;

  grid.querySelectorAll("[data-date]").forEach((cell) => {
    cell.addEventListener("click", () => {
      state.calSelected = new Date(cell.dataset.date);
      renderCalendarDayList();
      grid.querySelectorAll(".month-cell").forEach((c) => (c.style.outline = ""));
      cell.style.outline = "2px solid var(--signal)";
    });
  });

  renderCalendarDayList();
}

function renderCalendarDayList() {
  const el = document.getElementById("cal-day-list");
  const d = state.calSelected;
  const dow = d.getDay();
  const classesThatDay = state.classes.filter((c) => c.days.includes(dow)).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const assignmentsThatDay = state.assignments.filter((a) => isSameDay(new Date(a.dueDate), d));

  if (classesThatDay.length === 0 && assignmentsThatDay.length === 0) {
    el.innerHTML = emptyState("—", d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }), "Nothing scheduled.");
    return;
  }
  el.innerHTML =
    classesThatDay.map((c, i) => classFlapRow(c, i)).join("") + assignmentsThatDay.map((a, i) => assignmentFlapRow(a, i)).join("");
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
  document.getElementById("focus-start").addEventListener("click", async () => {
    if (focusTimer) {
      await stopFocusSession();
    } else {
      await api.startFocus(focusMinutesSetting);
      const { focus } = await api.getFocus();
      state.focus = focus;
      startFocusCountdown(focus.until);
    }
  });
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
  await api.stopFocus();
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
  el.innerHTML = state.terms.length
    ? state.terms
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
    row.addEventListener("click", async () => {
      await api.activateTerm(row.dataset.switchTerm);
      state.activeTermId = row.dataset.switchTerm;
      await loadTermScopedData();
      renderAll();
    })
  );
  el.querySelectorAll("[data-edit-term]").forEach((btn) =>
    btn.addEventListener("click", () => openTermSheet(state.terms.find((t) => t.id === btn.dataset.editTerm)))
  );

  document.getElementById("reminder-offsets").value = (state.settings.reminderOffsetsMinutes || []).join(", ");
  document.getElementById("theme-select").value = state.settings.theme || "system";
  document.getElementById("settings-points").textContent = state.points.total;
  document.getElementById("settings-streak").textContent = state.points.streak;
  document.getElementById("settings-level").textContent = state.points.level.name;

  refreshPushStatusUI();
}

function wireSettingsView() {
  document.getElementById("btn-add-term").addEventListener("click", () => openTermSheet(null));

  document.getElementById("reminder-offsets").addEventListener("change", async (e) => {
    const arr = e.target.value
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    const { settings } = await api.updateSettings({ reminderOffsetsMinutes: arr });
    state.settings = settings;
    toast("Reminder times saved.");
  });

  document.getElementById("theme-select").addEventListener("change", async (e) => {
    const { settings } = await api.updateSettings({ theme: e.target.value });
    state.settings = settings;
    applyTheme();
  });

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
  `,
    {
      onMount: (root) => {
        root.querySelector("#term-cancel").addEventListener("click", closeSheet);
        if (isEdit) {
          root.querySelector("#term-delete").addEventListener("click", async () => {
            if (!confirm(`Delete ${term.name}? This deletes its schedule and assignments too.`)) return;
            await api.deleteTerm(term.id);
            const { terms, activeTermId } = await api.listTerms();
            state.terms = terms;
            state.activeTermId = activeTermId;
            await loadTermScopedData();
            renderAll();
            closeSheet();
          });
        }
        root.querySelector("#term-save").addEventListener("click", async () => {
          const name = document.getElementById("term-name").value.trim();
          const startDate = document.getElementById("term-start").value;
          const endDate = document.getElementById("term-end").value;
          if (!name || !startDate || !endDate) return toast("All fields are required.");
          const payload = { name, startDate: new Date(startDate).toISOString(), endDate: new Date(endDate).toISOString() };
          if (isEdit) await api.updateTerm(term.id, payload);
          else await api.createTerm(payload);
          const { terms, activeTermId } = await api.listTerms();
          state.terms = terms;
          state.activeTermId = activeTermId;
          await loadTermScopedData();
          renderAll();
          closeSheet();
        });
      },
    }
  );
}

function wireTopbar() {
  document.getElementById("term-switch").addEventListener("click", openTermSwitcherSheet);
  document.getElementById("level-badge").addEventListener("click", () => switchView("settings"));
}

function openTermSwitcherSheet() {
  openSheet(
    `
    <h2>Switch term</h2>
    <div class="settings-list">
      ${state.terms
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
          row.addEventListener("click", async () => {
            await api.activateTerm(row.dataset.pickTerm);
            state.activeTermId = row.dataset.pickTerm;
            await loadTermScopedData();
            renderAll();
            closeSheet();
          })
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
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", effective === "dark" ? "#12151c" : "#f3f1ec");
}
