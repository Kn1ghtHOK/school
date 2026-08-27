// Run once during setup: node scripts/generate-vapid-keys.mjs
// Prints the two values you need to configure push notifications:
//   1. VAPID_PUBLIC_KEY  -> paste into wrangler.jsonc under "vars"
//   2. VAPID_PRIVATE_JWK -> set as a secret, never commit it
import { generateVapidKeys } from "../src/lib/webpush.js";

const { privateJwk, publicKeyB64url } = await generateVapidKeys();

console.log("\n=== Public key (safe to commit) ===");
console.log("Paste this into wrangler.jsonc as vars.VAPID_PUBLIC_KEY:\n");
console.log(publicKeyB64url);

console.log("\n=== Private key (KEEP SECRET) ===");
console.log("Run this command and paste the JSON below when prompted:\n");
console.log("  npx wrangler secret put VAPID_PRIVATE_JWK\n");
console.log(JSON.stringify(privateJwk));
console.log("");
