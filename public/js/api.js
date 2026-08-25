const TOKEN_KEY = "schoolapp_token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }

  if (!res.ok) {
    if (res.status === 401) setToken(null);
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  }
  return data;
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

  // assignments
  listAssignments: (termId) => request("GET", `/api/terms/${termId}/assignments`),
  createAssignment: (termId, data) => request("POST", `/api/terms/${termId}/assignments`, data),
  updateAssignment: (termId, id, data) => request("PUT", `/api/terms/${termId}/assignments/${id}`, data),
  deleteAssignment: (termId, id) => request("DELETE", `/api/terms/${termId}/assignments/${id}`),
  completeAssignment: (termId, id) => request("POST", `/api/terms/${termId}/assignments/${id}/complete`),
  uncompleteAssignment: (termId, id) => request("POST", `/api/terms/${termId}/assignments/${id}/uncomplete`),

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
