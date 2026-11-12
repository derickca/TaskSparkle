// Mints a rig Access token for any email and name, signed with
// the rig key. Usage:
//   node tests/rig/mint.mjs <email> <name> [wrongiss]
// With "wrongiss" the token's issuer is a team domain that does
// not exist — the shape of the sessions stranded by a rename
// (issue #49) — and the Worker refuses it.
//
// The issuer is the rig's own Access team domain: rig.mjs wrote
// it into the rig folder's wrangler.toml from the run's chosen
// certs port, and this script stands in that folder, so the
// settings stand two levels up (issue #23). A copy run loose,
// with no rig settings beside it, falls back to the default rig
// address — the behaviour on the default ports is unchanged.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const email = process.argv[2];
const name = process.argv[3] || "";
const wrongiss = process.argv[4] === "wrongiss";
let issuer = "http://127.0.0.1:8791";
try {
  const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
  const named = toml.match(/ACCESS_TEAM_DOMAIN\s*=\s*"([^"]+)"/);
  if (named) issuer = named[1];
} catch { /* no rig settings beside this copy — the default stands */ }
const pem = readFileSync(new URL("./private.pem", import.meta.url), "utf8");
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const now = Math.floor(Date.now() / 1000);
const header = { alg: "RS256", kid: "rig1", typ: "JWT" };
const payload = {
  iss: wrongiss ? "https://oldteam.example.invalid" : issuer,
  aud: "rig-audience",
  email,
  name,
  iat: now - 60,
  nbf: now - 60,
  exp: now + 3600,
  sub: "rig-" + email,
  type: "app",
  country: "CA",
};
const data = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(payload));
const signer = createSign("RSA-SHA256");
signer.update(data);
console.log(data + "." + b64url(signer.sign(pem)));
