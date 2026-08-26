// Single-user passcode auth. No usernames, no accounts — just one shared
// passcode that unlocks the same synced data from any device.

// Cloudflare Workers' WebCrypto implementation caps PBKDF2 at 100,000
// iterations (browsers/Node allow much higher) — this is the max allowed.
const PBKDF2_ITERATIONS = 100000;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year

function b64urlEncode(buf) {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function hashPasscode(passcode, saltBytes) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passcode), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return { hash: b64urlEncode(bits), salt: b64urlEncode(salt), iterations: PBKDF2_ITERATIONS };
}

export async function verifyPasscode(passcode, stored) {
  if (!stored) return false;
  const { hash } = await hashPasscode(passcode, b64urlDecode(stored.salt));
  return timingSafeEqual(hash, stored.hash);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function newSessionToken() {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(24)));
}

export async function createSession(kv, token) {
  await kv.put(`session:${token}`, JSON.stringify({ createdAt: Date.now() }), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

export async function checkSession(kv, token) {
  if (!token) return false;
  const raw = await kv.get(`session:${token}`);
  return raw !== null;
}

export async function destroySession(kv, token) {
  await kv.delete(`session:${token}`);
}

export function getBearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

export { b64urlEncode, b64urlDecode };
