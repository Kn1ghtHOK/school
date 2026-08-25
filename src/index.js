import { err } from "./lib/http.js";
import { getBearerToken, checkSession } from "./lib/auth.js";
import * as authRoutes from "./routes/auth.js";
import * as terms from "./routes/terms.js";
import * as schedule from "./routes/schedule.js";
import * as assignments from "./routes/assignments.js";
import * as notes from "./routes/notes.js";
import * as push from "./routes/push.js";
import * as focus from "./routes/focus.js";
import * as misc from "./routes/misc.js";
import { runReminderSweep } from "./cron.js";

// Each route: [method, pattern, handler, { public: true } for no-auth routes]
// Patterns use :name segments, matched against the path split on "/".
const ROUTES = [
  ["GET", "/api/auth/status", authRoutes.status, { public: true }],
  ["POST", "/api/auth/setup", authRoutes.setup, { public: true }],
  ["POST", "/api/auth/login", authRoutes.login, { public: true }],
  ["POST", "/api/auth/logout", authRoutes.logout],

  ["GET", "/api/terms", terms.list],
  ["POST", "/api/terms", terms.create],
  ["PUT", "/api/terms/:id", terms.update],
  ["DELETE", "/api/terms/:id", terms.remove],
  ["POST", "/api/terms/:id/activate", terms.activate],

  ["GET", "/api/terms/:termId/schedule", schedule.list],
  ["POST", "/api/terms/:termId/schedule", schedule.create],
  ["PUT", "/api/terms/:termId/schedule/:classId", schedule.update],
  ["DELETE", "/api/terms/:termId/schedule/:classId", schedule.remove],

  ["GET", "/api/terms/:termId/assignments", assignments.list],
  ["POST", "/api/terms/:termId/assignments", assignments.create],
  ["PUT", "/api/terms/:termId/assignments/:id", assignments.update],
  ["DELETE", "/api/terms/:termId/assignments/:id", assignments.remove],
  ["POST", "/api/terms/:termId/assignments/:id/complete", assignments.complete],
  ["POST", "/api/terms/:termId/assignments/:id/uncomplete", assignments.uncomplete],

  ["GET", "/api/classes/:classId/notes", notes.get],
  ["PUT", "/api/classes/:classId/notes", notes.put],

  ["GET", "/api/push/public-key", push.publicKey],
  ["POST", "/api/push/subscribe", push.subscribe],
  ["POST", "/api/push/unsubscribe", push.unsubscribe],
  ["GET", "/api/push/subscriptions", push.list],
  ["POST", "/api/push/test", push.sendTest],

  ["GET", "/api/focus", focus.get],
  ["POST", "/api/focus/start", focus.start],
  ["POST", "/api/focus/stop", focus.stop],

  ["GET", "/api/points", misc.pointsSummary],
  ["GET", "/api/settings", misc.getSettings],
  ["PUT", "/api/settings", misc.putSettings],
];

function matchRoute(method, pathname) {
  const pathSegs = pathname.split("/").filter(Boolean);
  for (const [routeMethod, pattern, handler, opts] of ROUTES) {
    if (routeMethod !== method) continue;
    const patSegs = pattern.split("/").filter(Boolean);
    if (patSegs.length !== pathSegs.length) continue;

    const params = {};
    let ok = true;
    for (let i = 0; i < patSegs.length; i++) {
      if (patSegs[i].startsWith(":")) {
        params[patSegs[i].slice(1)] = decodeURIComponent(pathSegs[i]);
      } else if (patSegs[i] !== pathSegs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler, params, opts: opts || {} };
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const match = matchRoute(request.method, url.pathname);
    if (!match) return err("Not found.", 404);

    if (!match.opts.public) {
      const token = getBearerToken(request);
      const ok = await checkSession(env.SCHOOL_KV, token);
      if (!ok) return err("Unauthorized.", 401);
    }

    try {
      const paramValues = Object.values(match.params);
      return await match.handler(request, env, ...paramValues);
    } catch (e) {
      console.error(e);
      return err(e?.message || "Internal error.", 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminderSweep(env));
  },
};
