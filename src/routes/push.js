import { json, err, readJSON } from "../lib/http.js";
import { getJSON, putJSON, keys } from "../lib/store.js";
import { sendWebPush } from "../lib/webpush.js";

export async function publicKey(request, env) {
  return json({ publicKey: env.VAPID_PUBLIC_KEY });
}

export async function subscribe(request, env) {
  const body = await readJSON(request);
  if (!body.subscription?.endpoint) return err("subscription is required.", 400);

  const subs = await getJSON(env.SCHOOL_KV, keys.pushSubs(), []);
  const filtered = subs.filter((s) => s.endpoint !== body.subscription.endpoint);
  filtered.push({
    endpoint: body.subscription.endpoint,
    keys: body.subscription.keys,
    label: body.label || "device",
    addedAt: Date.now(),
  });
  await putJSON(env.SCHOOL_KV, keys.pushSubs(), filtered);
  return json({ ok: true, count: filtered.length });
}

export async function unsubscribe(request, env) {
  const body = await readJSON(request);
  const subs = await getJSON(env.SCHOOL_KV, keys.pushSubs(), []);
  const next = subs.filter((s) => s.endpoint !== body.endpoint);
  await putJSON(env.SCHOOL_KV, keys.pushSubs(), next);
  return json({ ok: true, count: next.length });
}

export async function list(request, env) {
  const subs = await getJSON(env.SCHOOL_KV, keys.pushSubs(), []);
  return json({ subscriptions: subs.map((s) => ({ label: s.label, addedAt: s.addedAt, endpoint: s.endpoint })) });
}

export async function sendTest(request, env) {
  if (!env.VAPID_PRIVATE_JWK) return err("VAPID keys are not configured on the server yet.", 500);
  const subs = await getJSON(env.SCHOOL_KV, keys.pushSubs(), []);
  if (subs.length === 0) return err("No devices are subscribed yet.", 400);

  const vapidKeys = { privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), publicKeyB64url: env.VAPID_PUBLIC_KEY };
  const results = [];
  const keep = [];
  for (const sub of subs) {
    const r = await sendWebPush(
      sub,
      { title: "Test notification", body: "Push notifications are working.", tag: "test" },
      vapidKeys,
      env.VAPID_SUBJECT || "mailto:you@example.com"
    );
    results.push({ label: sub.label, ok: r.ok, status: r.status });
    if (!r.expired) keep.push(sub);
  }
  if (keep.length !== subs.length) await putJSON(env.SCHOOL_KV, keys.pushSubs(), keep);
  return json({ results });
}
