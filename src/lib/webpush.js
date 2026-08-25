// Web Push: message encryption (RFC 8291) + VAPID auth (RFC 8292).
// Uses only crypto.subtle — verified against the official RFC 8291 test
// vector during development. No external dependencies.

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

function concatBytes(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

async function hmacSha256(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, msgBytes));
}

async function encryptPush(payloadBytes, uaPublicRaw, authSecret) {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));

  const uaPublicKey = await crypto.subtle.importKey("raw", uaPublicRaw, { name: "ECDH", namedCurve: "P-256" }, true, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, kp.privateKey, 256)
  );

  const PRK_key = await hmacSha256(authSecret, ecdhSecret);
  const enc = new TextEncoder();
  const keyInfo = concatBytes(enc.encode("WebPush: info"), new Uint8Array([0]), uaPublicRaw, asPublicRaw);
  const IKM = await hmacSha256(PRK_key, concatBytes(keyInfo, new Uint8Array([1])));

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const PRK = await hmacSha256(salt, IKM);
  const cekInfo = concatBytes(enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0]));
  const CEK = (await hmacSha256(PRK, concatBytes(cekInfo, new Uint8Array([1])))).slice(0, 16);
  const nonceInfo = concatBytes(enc.encode("Content-Encoding: nonce"), new Uint8Array([0]));
  const NONCE = (await hmacSha256(PRK, concatBytes(nonceInfo, new Uint8Array([1])))).slice(0, 12);

  const paddedPlaintext = concatBytes(payloadBytes, new Uint8Array([2]));
  const cekKey = await crypto.subtle.importKey("raw", CEK, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: NONCE, tagLength: 128 }, cekKey, paddedPlaintext)
  );

  const rsBytes = new Uint8Array(4);
  new DataView(rsBytes.buffer).setUint32(0, 4096, false);
  const header = concatBytes(salt, rsBytes, new Uint8Array([asPublicRaw.length]), asPublicRaw);

  return concatBytes(header, ciphertext);
}

async function signVapidJwt({ audience, subject, privateJwk, expirySeconds = 12 * 3600 }) {
  const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = { typ: "JWT", alg: "ES256" };
  const payload = { aud: audience, exp: Math.floor(Date.now() / 1000) + expirySeconds, sub: subject };
  const enc = new TextEncoder();
  const headerB64 = b64urlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, enc.encode(signingInput))
  );
  return `${signingInput}.${b64urlEncode(sig)}`;
}

/**
 * Send one push notification. Returns { ok, status, expired } — `expired`
 * is true on 404/410, meaning the subscription should be deleted.
 * @param {{endpoint: string, keys: {p256dh: string, auth: string}}} subscription
 * @param {object} payloadObj - JSON-serializable notification data
 * @param {{privateJwk: object, publicKeyB64url: string}} vapidKeys
 * @param {string} subject - e.g. "mailto:you@example.com"
 */
export async function sendWebPush(subscription, payloadObj, vapidKeys, subject, ttlSeconds = 60 * 60 * 24) {
  const uaPublicRaw = b64urlDecode(subscription.keys.p256dh);
  const authSecret = b64urlDecode(subscription.keys.auth);
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payloadObj));

  const body = await encryptPush(payloadBytes, uaPublicRaw, authSecret);

  const endpointUrl = new URL(subscription.endpoint);
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const jwt = await signVapidJwt({ audience, subject, privateJwk: vapidKeys.privateJwk });

  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: String(ttlSeconds),
      Authorization: `vapid t=${jwt}, k=${vapidKeys.publicKeyB64url}`,
    },
    body,
  });

  return { ok: res.ok, status: res.status, expired: res.status === 404 || res.status === 410 };
}

/** One-time VAPID key pair generation (used by scripts/generate-vapid-keys.mjs). */
export async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { privateJwk, publicKeyB64url: b64urlEncode(publicRaw) };
}

export { b64urlEncode, b64urlDecode };
