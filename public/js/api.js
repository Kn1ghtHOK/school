const TOKEN_KEY = "schoolapp_token";

// Only idempotent methods are safe to auto-retry on a network blip — a
// dropped response after a POST that actually succeeded server-side
// would otherwise create a duplicate (e.g. two copies of an assignment).
const RETRYABLE_METHODS = new Set(["GET", "PUT", "DELETE"]);
const RETRY_DELAYS_MS = [500, 1500];

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

class ApiError extends Error {
  constructor(message, status, { offline = false } = {}) {
    super(message);
    this.status = status;
    this.offline = offline;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function notifyAuthExpired() {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent("schoolapp:auth-expired"));
  }
}

async function attemptOnce(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // fetch() itself throws for network-level failures: offline, DNS
    // failure, connection reset, etc. — there's no HTTP response at all.
    throw new ApiError(
      isOffline() ? "You're offline — reconnect and try again." : "Couldn't reach the server. Check your connection and try again.",
      0,
      { offline: true }
    );
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }

  if (!res.ok) {
    if (res.status === 401) {
      setToken(null);
      notifyAuthExpired();
    }
    throw new ApiError(data?.error || `Something went wrong (${res.status}). Please try again.`, res.status);
  }
  return data;
}

async function request(method, path, body) {
  const canRetry = RETRYABLE_METHODS.has(method);
  const attempts = canRetry ? RETRY_DELAYS_MS.length + 1 : 1;
  let lastError;

  for (let i = 0; i < attempts; i++) {
    try {
      return await attemptOnce(method, path, body);
    } catch (e) {
      lastError = e;
      // Retry only on a network-level failure or a 5xx server error — never
      // on a 4xx (retrying won't fix bad input) or a 401 (needs a fresh login).
      const serverError = typeof e.status === "number" && e.status >= 500;
      const shouldRetry = canRetry && i < attempts - 1 && (e.offline || serverError);
      if (!shouldRetry) throw e;
      await sleep(RETRY_DELAYS_MS[i]);
    }
  }
  throw lastError;
}

export const api = {
  // auth
  authStatus: () => request("GET", "/api/auth/status"),
  setup: (passcode) => request("POST", "/api/auth/setup", { passcode }),
  login: (passcode) => request("POST", "/api/auth/login", { passcode }),
  logout: () => request("POST", "/api/auth/logout"),

  // terms
  listTerms: () => request("GET", "/api/terms"),
  createTerm: (data) => request("POST", "/api/terms", data),
  updateTerm: (id, data) => request("PUT", `/api/terms/${id}`, data),
  deleteTerm: (id) => request("DELETE", `/api/terms/${id}`),
  activateTerm: (id) => request("POST", `/api/terms/${id}/activate`),

  // schedule
  listClasses: (termId) => request("GET", `/api/terms/${termId}/schedule`),
  createClass: (termId, data) => request("POST", `/api/terms/${termId}/schedule`, data),
  updateClass: (termId, id, data) => request("PUT", `/api/terms/${termId}/schedule/${id}`, data),
  deleteClass: (termId, id) => request("DELETE", `/api/terms/${termId}/schedule/${id}`),

  // day schedule (bell schedule matrix — which periods meet which weekday)
  getDaySchedule: (termId) => request("GET", `/api/terms/${termId}/dayschedule`),
  setDaySchedule: (termId, weekday, periods) => request("PUT", `/api/terms/${termId}/dayschedule/${weekday}`, { periods }),

  // assignments
  listAssignments: (termId) => request("GET", `/api/terms/${termId}/assignments`),
  createAssignment: (termId, data) => request("POST", `/api/terms/${termId}/assignments`, data),
  updateAssignment: (termId, id, data) => request("PUT", `/api/terms/${termId}/assignments/${id}`, data),
  deleteAssignment: (termId, id) => request("DELETE", `/api/terms/${termId}/assignments/${id}`),
  completeAssignment: (termId, id) => request("POST", `/api/terms/${termId}/assignments/${id}/complete`),
  uncompleteAssignment: (termId, id) => request("POST", `/api/terms/${termId}/assignments/${id}/uncomplete`),
  snoozeAssignment: (termId, id, until) => request("POST", `/api/terms/${termId}/assignments/${id}/snooze`, { until }),

  // search
  search: (termId, q) => request("GET", `/api/terms/${termId}/search?q=${encodeURIComponent(q)}`),

  // todos (global, not term-scoped)
  listTodos: () => request("GET", "/api/todos"),
  createTodo: (title) => request("POST", "/api/todos", { title }),
  updateTodo: (id, data) => request("PUT", `/api/todos/${id}`, data),
  deleteTodo: (id) => request("DELETE", `/api/todos/${id}`),

  // notes
  getNotes: (classId) => request("GET", `/api/classes/${classId}/notes`),
  saveNotes: (classId, content) => request("PUT", `/api/classes/${classId}/notes`, { content }),

  // push
  getPushPublicKey: () => request("GET", "/api/push/public-key"),
  subscribePush: (subscription, label) => request("POST", "/api/push/subscribe", { subscription, label }),
  unsubscribePush: (endpoint) => request("POST", "/api/push/unsubscribe", { endpoint }),
  listPushSubs: () => request("GET", "/api/push/subscriptions"),
  sendTestPush: () => request("POST", "/api/push/test"),

  // focus
  getFocus: () => request("GET", "/api/focus"),
  startFocus: (minutes) => request("POST", "/api/focus/start", { minutes }),
  stopFocus: () => request("POST", "/api/focus/stop"),

  // points & settings
  getPoints: () => request("GET", "/api/points"),
  getSettings: () => request("GET", "/api/settings"),
  updateSettings: (data) => request("PUT", "/api/settings", data),
};

export { ApiError };
