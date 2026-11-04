// Mints an invite link directly against the hosted copy's
// databases — the operator's recovery door (issue #109).
//
// Run this when nobody can sign in to the hosted copy: the
// administrator's password is lost and no reset link can be
// minted from inside, or the first account was never finished.
// The link it prints is an ordinary invite: for a name that
// already has an account it is a password reset (spending it
// replaces the password and removes that account's passkeys
// and sessions, the same as any reset); for a new name it
// opens an account. Run it from a machine holding the
// deployment's Cloudflare credential — the same credential
// the deploy job uses — which never rests beside the running
// copy.
//
// Usage:
//   TASKSparkle_CF_TOKEN=... TASKSparkle_CF_ACCOUNT=... \
//   TASKSparkle_AUTH_DB_ID=... TASKSparkle_PUBLIC_BASE=https://app.example \
//   node scripts/recovery-invite.mjs "Their Name"
//
// TASKSparkle_AUTH_DB_ID names the sign-in database (the
// AUTH_DB the deployment binds). When the deployment keeps
// the sign-in tables in the main database instead, give
// TASKSparkle_DB_ID, the main database's id, and the invite
// lands there. The invite row written here is exactly the
// row the app's own mint writes (worker/auth.js mintInvite):
// the code's SHA-256 in code_hash, seven days to spend it,
// and the name's earlier unspent invites retired.

import { createHash, randomBytes } from "node:crypto";

const INVITE_MS = 7 * 24 * 60 * 60 * 1000;

function need(name) {
  const value = process.env[name];
  if (!value) {
    console.error("Set " + name + " in the environment and run again.");
    process.exit(2);
  }
  return value;
}

const name = (process.argv[2] || "").trim();
if (!name || /[@\u0000-\u001F\u007F]/.test(name)) {
  console.error('Usage: node scripts/recovery-invite.mjs "Their Name"');
  process.exit(2);
}
const token = need("TASKSparkle_CF_TOKEN");
const account = need("TASKSparkle_CF_ACCOUNT");
const dbId = process.env.TASKSparkle_AUTH_DB_ID || need("TASKSparkle_DB_ID");
const base = need("TASKSparkle_PUBLIC_BASE").replace(/\/+$/, "");

async function d1(sql, params) {
  const res = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" + account +
      "/d1/database/" + dbId + "/query",
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.success) {
    const why = body && body.errors && body.errors[0]
      ? body.errors[0].message : "HTTP " + res.status;
    throw new Error("The database refused the statement: " + why);
  }
  return body.result[0];
}

// The account key is the sign-in name folded the way the app
// folds it (worker/auth.js nameKey): trimmed and lower case.
const key = name.toLowerCase();
const code = randomBytes(24).toString("base64url");
const codeHash = createHash("sha256").update(code, "utf8").digest("hex");
const stamp = Date.now();

const standing = await d1(
  "SELECT key FROM accounts WHERE key = ?", [key]);
await d1("DELETE FROM invites WHERE key = ? AND used_at IS NULL", [key]);
await d1(
  "INSERT INTO invites (code_hash, key, name, created, expires, used_at) " +
  "VALUES (?, ?, ?, ?, ?, NULL)",
  [codeHash, key, name, stamp, stamp + INVITE_MS]);

console.log(
  (standing.results && standing.results.length
    ? "A reset link for the account standing under that name:"
    : "An invite link for a new account under that name:"));
console.log(base + "/invite/" + code);
console.log("Good for seven days. Anyone holding the link can spend it once.");
