import { json, err, readJSON } from "../lib/http.js";
import { getJSON, putJSON, keys } from "../lib/store.js";
import { hashPasscode, verifyPasscode, newSessionToken, createSession, destroySession, getBearerToken } from "../lib/auth.js";

export async function status(request, env) {
  const config = await getJSON(env.SCHOOL_KV, keys.config(), null);
  return json({ hasPasscode: Boolean(config?.passcode) });
}

export async function setup(request, env) {
  const config = await getJSON(env.SCHOOL_KV, keys.config(), null);
  if (config?.passcode) return err("Passcode already set. Use /api/auth/login instead.", 409);

  const { passcode } = await readJSON(request);
  if (!passcode || String(passcode).length < 4) {
    return err("Passcode must be at least 4 characters.", 400);
  }

  const hashed = await hashPasscode(String(passcode));
  await putJSON(env.SCHOOL_KV, keys.config(), { passcode: hashed });

  const token = newSessionToken();
  await createSession(env.SCHOOL_KV, token);
  return json({ token });
}

export async function login(request, env) {
  const config = await getJSON(env.SCHOOL_KV, keys.config(), null);
  if (!config?.passcode) return err("No passcode set up yet.", 409);

  const { passcode } = await readJSON(request);
  const ok = await verifyPasscode(String(passcode || ""), config.passcode);
  if (!ok) return err("Incorrect passcode.", 401);

  const token = newSessionToken();
  await createSession(env.SCHOOL_KV, token);
  return json({ token });
}

export async function logout(request, env) {
  const token = getBearerToken(request);
  await destroySession(env.SCHOOL_KV, token);
  return json({ ok: true });
}
