// TaskSparkle API drill: the standing end-to-end checks for the
// API, written to run against a throwaway rig or a throwaway
// self-host instance — never against production data. It works
// two throwaway owners through the scenario families the rounds
// have always drilled by hand: sign-in and the seeded state,
// isolation between owners, the card lifecycle, checklists,
// links, labels, projects, columns (including the delete that
// moves cards), boards (including copy and the keep-one rule),
// keys (mint, list, rename, revoke, the key-door rules), the
// write gate (unknown fields refused by name, stale writes), the
// version stamps, the directions, the push route's refusals and
// the stale-session cookie expiry (issue #49). The doors section
// (issues #61, #64, #65 and #66) holds what each door may see: a
// key's version and state answers carry no change stamp, no owner
// email and no key block, the person's answers keep them, a
// person's display name is theirs to set, a sign-in name claim
// refreshes the stored name without ever outranking the person's
// own, and the directions say a key's name is stamped on its work
// for good. The label colour modes section (issues #94 and #95)
// holds the board's labelColourMode — chip by default, set and
// validated on the board PATCH, carried by state and by board
// copies — and the end of the project colour: the field refused
// by name on project create and change, and no project answer or
// state read carrying one. One section times writes on a wide board (#71). The
// last family is erasure (issue #57): person B deletes
// themselves — a key's call gets a 403, the person's own call
// erases the whole owner cascade and expires their session, and
// a fresh start for B begins from the seed — and the directions
// checks that ride with it (issues #57 and #92).
//
// Usage:
//   Worker rig (fake Access certs, locally minted tokens):
//     node tests/api-drill.mjs --base https://localhost:PORT \
//       --agent-base https://127.0.0.1:PORT --mode worker \
//       --mint path/to/mint.mjs \
//       --password-a <drill A's own password> \
//       --password-b <drill B's own password> \
//       --setup-code <the rig's SETUP_CODE>
//     Person A enters through the setup page itself (the drill
//     first proves a press without the code, and one with a
//     wrong code, are refused); person B enters by spending the
//     invite A mints. The mint script is still called for the
//     transition family: `node mint.mjs <email> <name>` prints
//     an Access token the rig's Worker accepts, and with a
//     further argument "wrongiss" one whose issuer it refuses.
//     A ready-made rig lives in tests/rig/ (see tests/README.md).
//     The rig's OWNER_EMAILS names the drill people's account
//     keys ("drill a", "drill b") and their old addresses.
//   Self-host instance:
//     node tests/api-drill.mjs --base http://host:PORT --mode selfhost \
//       --password-a <drill A's own password> \
//       --password-b <drill B's own password> \
//       [--server-config <the instance's config file>]
//     (--password alone still works when both people share one
//     drill password value.) The instance's config holds no
//     people (issue #107); the two drill people are the accounts
//     named Drill A and Drill B, each of whom set the password
//     above by redeeming a name-carrying invite before the drill
//     starts — the harness mints both invites with the server's
//     --invite command and redeems them over HTTP. The agent
//     door is the same address. Self-host mode ends with the
//     hardening family (issues #55, #62, #67, #68) and the
//     invite family (issues #89, #107): the sign-in page's list
//     of account names, the sign-in throttle, the request-body
//     cap, the push hub's frame rules, and per-person passwords
//     set through single-use invite links. The server lifecycle
//     itself (first-run setup, the administrator's routes, the
//     old-config refusals, the bind option) is drilled by
//     tests/server-drill.mjs.
//
// The feedback family (issue #22) drills the deployment's
// feedback setting, and is told which state the copy under it
// stands in: --feedback on|off (off when unspoken — the state
// the harness's instance and the standing rig stand in). On
// names a target the drill itself holds open as a stand-in on
// port 8795: the copy's FEEDBACK_URL must point at
// http://127.0.0.1:8795/api/submit before the copy starts (on
// the Worker rig, the var stands in the rig folder's
// wrangler.toml; the self-host on-state is carried by the
// server drill instead, which writes its own configs).
//
// The two drill people are accounts named Drill A and Drill B
// on both homes (issue #109): the core keys their owners by
// the sign-in name folded to lower case ("drill a", "drill b"),
// so A and B below hold that string in both modes and the
// shared checks read the same. The sign-in family near the end
// (issue #109) drills the new door itself with an in-drill
// software authenticator: passkey enrolment and sign-in, the
// step-up rules, the hostile ceremony variants, a reset's
// revocation of sessions with its passkeys left standing (issue
// #122: a reset removes no passkey — only the reset form's own
// start-fresh choice does), the administrator's
// passkey removal, keys refused on every sign-in route, the
// throttle's two curves and its write budget, the claim flow,
// and — where the drill can write the data file — a stored
// hash with refused parameters. The same family holds the
// follow-on checks: a credential id sent with base64 padding
// signs in (issue #111's hardening), and the remembered name
// (issue #112) — the cookie a ticked sign-in stands and an
// unticked one expires, the name filled back into the hosted
// page's field or pre-picked on the home page's list, a
// passkey tap honouring the box, and the passkey button
// standing under the name entry on both pages.
import { request as httpsRequest } from "node:https";
import { request as httpRequest, createServer as httpCreateServer } from "node:http";
import { connect as netConnect } from "node:net";
import { randomBytes, generateKeyPairSync, createSign, createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { encodeCBOR, pbkdf2Chain } from "../worker/auth.js";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
}
const BASE = args.base;
const AGENT_BASE = args["agent-base"] || args.base;
const MODE = args.mode || "worker";
const MINT = args.mint;
const PASSWORD_A = args["password-a"] || args.password;
const PASSWORD_B = args["password-b"] || args.password;
const SETUP_CODE = args["setup-code"] || "";
if (!BASE || !PASSWORD_A || !PASSWORD_B ||
    (MODE === "worker" && (!MINT || !SETUP_CODE))) {
  console.error("usage: see the header of tests/api-drill.mjs");
  process.exit(2);
}
const NAME_A = "Drill A";
const NAME_B = "Drill B";
const A = "drill a";
const B = "drill b";

let failures = 0;
let count = 0;
function check(name, cond, detail) {
  count += 1;
  if (!cond) failures += 1;
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail ? "  — " + detail : ""));
}

function raw(base, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const lib = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = lib(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: body != null
          ? { ...headers, "Content-Length": Buffer.byteLength(body) }
          : headers,
        rejectUnauthorized: false,
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(text); } catch (e) { /* plain-text answers exist */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

// A caller: one person's way in — the session cookie the door
// issued, on both homes (issue #109). The cookie is kept in a
// small jar: the door rotates the session token at sign-in and
// at privilege changes, and the jar follows the rotation the
// way a browser does. Worker mode's people enter through the
// door itself: person A through the setup page (after the
// refused presses in setupPress below), person B by spending
// A's invite. The Access token survives only in the transition
// family, through accessCall below.
const formPostRaw = (base, path, fields, headers) => raw(base, "POST", path, {
  "Content-Type": "application/x-www-form-urlencoded", ...(headers || {}),
}, new URLSearchParams(fields).toString());

const sessionCookieOf = (res) => {
  const found = (res.headers["set-cookie"] || [])
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("ts_session=") && c.length > "ts_session=".length);
  return found || null;
};

const callers = {};
async function callerFor(email, name) {
  if (callers[email]) return callers[email];
  let cookie = null;
  if (MODE === "worker") {
    if (email === A) {
      cookie = await setupPress(NAME_A, PASSWORD_A, SETUP_CODE);
      if (!cookie) {
        // The account already stands (a drill re-run against a
        // kept rig): sign in the ordinary way instead.
        const res = await formPostRaw(BASE, "/login", { name: NAME_A, password: PASSWORD_A });
        cookie = sessionCookieOf(res);
      }
    } else {
      // Person B arrives by invite, minted by A through the
      // sign-in routes, spent through the invite page.
      const aCaller = await callerFor(A, NAME_A);
      const minted = await aCaller.call("POST", "/api/auth/invites", { name: NAME_B });
      const code = minted.json && minted.json.code;
      if (!code) throw new Error("A minted no invite for B (status " + minted.status + ")");
      const spent = await formPostRaw(BASE, "/invite/" + code,
        { name: NAME_B, password: PASSWORD_B, confirm: PASSWORD_B });
      cookie = sessionCookieOf(spent);
    }
  } else {
    // Self-host sign-in picks the person's name from the list
    // and types their password (issue #107): the form carries
    // the person's sign-in name — the one their invite carried —
    // exactly as the page's pick list sends it.
    const res = await formPostRaw(BASE, "/login", {
      name: email === B ? NAME_B : NAME_A,
      password: email === B ? PASSWORD_B : PASSWORD_A,
    });
    cookie = sessionCookieOf(res);
  }
  if (!cookie) throw new Error("sign-in for " + name + " set no session cookie");
  const headers = { Cookie: cookie };
  const caller = {
    headers,
    async call(method, path, body, extra) {
      const h = { ...headers, ...(extra || {}) };
      let payload = null;
      if (body != null) {
        h["Content-Type"] = "application/json";
        payload = typeof body === "string" ? body : JSON.stringify(body);
      }
      const res = await raw(BASE, method, path, h, payload);
      const rotated = sessionCookieOf(res);
      if (rotated) {
        headers.Cookie = rotated;
        caller.headers.Cookie = rotated;
      }
      return res;
    },
    agentCall(method, path, key) {
      const h = key ? { Authorization: "Bearer " + key } : {};
      let payload = null;
      return raw(AGENT_BASE, method, path, h, payload);
    },
  };
  callers[email] = caller;
  return caller;
}

// One press of the setup page's form, answering the session
// cookie it issued or null. Worker mode's person A enters this
// way; the family's checks below drive the refused presses.
async function setupPress(name, password, setupCode) {
  const fields = { name, password, confirm: password };
  if (setupCode != null) fields.code = setupCode;
  const res = await formPostRaw(BASE, "/setup", fields);
  return sessionCookieOf(res);
}

// A call through the transition door: a minted Access token for
// the given identity string, the way the hosted copy's callers
// arrived before the new door (worker mode only).
async function accessCall(identity, nameClaim, method, path, body) {
  const token = execFileSync(process.execPath, [MINT, identity, nameClaim || ""],
    { encoding: "utf8" }).trim();
  let payload = null;
  const h = { "Cf-Access-Jwt-Assertion": token };
  if (body != null) {
    h["Content-Type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  return raw(BASE, method, path, h, payload);
}

const state = async (caller) => (await caller.call("GET", "/api/v1/state")).json;
const boardByName = (st, name) => st.boards.find((b) => b.name === name);
const cardByTitle = (st, title) =>
  st.cards ? st.cards.find((c) => c.title === title) : null;

// A software authenticator: one credential, honestly built,
// with the knobs the hostile variants turn. It stands at
// module scope because two families work ceremonies with it:
// the sign-in family (issue #109) and the passkey-first setup
// family (issue #122), which runs against a fresh rig before
// any account stands.
const DRILL_ORIGIN = new URL(BASE).origin;
const DRILL_RP_ID = new URL(BASE).hostname;
const b64uDrill = (buf) => Buffer.from(buf).toString("base64url");
const b64uDrillToBuf = (text) => Buffer.from(text, "base64url");
function makeAuthenticator() {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const credId = randomBytes(16);
  let counter = 0;
  const cose = encodeCBOR(new Map([
    [1, 2], [3, -7], [-1, 1], [-2, b64uDrillToBuf(jwk.x)], [-3, b64uDrillToBuf(jwk.y)],
  ]));
  const clientData = (type, challenge, origin) => Buffer.from(JSON.stringify({
    type, challenge, origin: origin || DRILL_ORIGIN, crossOrigin: false,
  }));
  const rpHash = createHash("sha256").update(DRILL_RP_ID).digest();
  function attestation(challenge, opts) {
    opts = opts || {};
    counter += 1;
    const flags = 0x01 | 0x04 | 0x40; // present, verified, attested data
    const countBuf = Buffer.alloc(4); countBuf.writeUInt32BE(counter);
    const lenBuf = Buffer.alloc(2); lenBuf.writeUInt16BE(credId.length);
    const authData = Buffer.concat([rpHash, Buffer.from([flags]), countBuf,
      Buffer.alloc(16), lenBuf, credId, cose]);
    const attObj = encodeCBOR(new Map([
      ["fmt", "none"], ["attStmt", new Map()], ["authData", authData],
    ]));
    return {
      id: b64uDrill(credId), type: "public-key",
      response: {
        clientDataJSON: b64uDrill(clientData(opts.type || "webauthn.create", challenge, opts.origin)),
        attestationObject: b64uDrill(attObj),
        transports: ["internal"],
      },
    };
  }
  function assertion(challenge, userHandle, opts) {
    opts = opts || {};
    counter += 1;
    let flags = 0x01 | 0x04; // present, verified
    if (opts.uv === false) flags &= ~0x04;
    if (opts.up === false) flags &= ~0x01;
    const countBuf = Buffer.alloc(4); countBuf.writeUInt32BE(counter);
    const authData = Buffer.concat([rpHash, Buffer.from([flags]), countBuf]);
    const cd = clientData(opts.type || "webauthn.get", challenge, opts.origin);
    const signed = Buffer.concat([authData, createHash("sha256").update(cd).digest()]);
    const signer = createSign("SHA256");
    signer.update(signed);
    // An authenticator's ECDSA signature is DER-encoded —
    // Node's default — and the server converts it for
    // WebCrypto, as it does a real device's.
    const signature = signer.sign({ key: pair.privateKey });
    return {
      id: b64uDrill(credId), type: "public-key",
      response: {
        clientDataJSON: b64uDrill(cd),
        authenticatorData: b64uDrill(authData),
        signature: b64uDrill(signature),
        userHandle: userHandle == null ? null : b64uDrill(userHandle),
      },
    };
  }
  return { credIdB64u: b64uDrill(credId), attestation, assertion };
}

// --- The hosted setup door refuses without its code (worker mode) -------------
// Before person A stands: a press with no setup code, and one
// with a wrong one, are both refused and make no account —
// person A's own press, with the code, is the one that lands
// (in callerFor above). Once an account stands every later
// press is refused as taken instead; that word is drilled by
// tests/server-drill.mjs on the home copy.
if (MODE === "worker") {
  let refused = await formPostRaw(BASE, "/setup",
    { name: NAME_A, password: PASSWORD_A, confirm: PASSWORD_A });
  check("#109 setup: a press with no setup code is refused and makes no account",
    refused.status === 302 && !sessionCookieOf(refused) &&
      (refused.headers.location || "").includes("error=code"),
    "status " + refused.status + " location " + refused.headers.location);
  refused = await formPostRaw(BASE, "/setup",
    { name: NAME_A, password: PASSWORD_A, confirm: PASSWORD_A, code: "not-the-code" });
  check("#109 setup: a press with a wrong setup code is refused the same way",
    refused.status === 302 && !sessionCookieOf(refused) &&
      (refused.headers.location || "").includes("error=code"),
    "status " + refused.status + " location " + refused.headers.location);
  const loginPage = await raw(BASE, "GET", "/login", {});
  check("#109 setup: the hosted sign-in page takes a typed name and names no list",
    loginPage.status === 200 && /name="name"/.test(loginPage.text) &&
      !/type="radio"/.test(loginPage.text) && loginPage.text.includes("passkey"),
    "status " + loginPage.status);
}

// --- Sign-in and the seeded state -------------------------------------------
// --- The passkey-first setup spend (issue #122, fresh rig only) ------------------
// The setup page's second way to stand the first account up:
// the ceremony runs first and the account is created only when
// a credential verifies — born with no password and one
// passkey standing. This family needs a rig with no accounts
// at all, so it runs only when --setup-family is passed, ahead
// of every other family, and exits: the lane runs it against a
// fresh rig, then wipes the rig and runs the whole drill.
if (args["setup-family"]) {
  if (MODE !== "worker") {
    console.error("--setup-family runs in worker mode against a fresh rig");
    process.exit(2);
  }
  const NAME_S = "Drill Setup";
  const jsonPost = (path, body) => raw(BASE, "POST", path, {
    "Content-Type": "application/json",
  }, JSON.stringify(body || {}));
  const page0 = await raw(BASE, "GET", "/login", {});
  check("#122 setup: with no accounts standing, the setup page offers the passkey way standing first (issue #141)",
    page0.status === 200 && page0.text.includes('action="/setup"') &&
      page0.text.includes('id="spend-passkey-button"') &&
      page0.text.indexOf('id="spend-passkey-button"') < page0.text.indexOf('id="spend-password"'),
    "status " + page0.status);
  // One spend refusal names its reason on this door too
  // (issue #147): the setup door shares the refusal words
  // with the invite door. Only one press rides here — the
  // preamble's two refused presses and the ceremony's own
  // wrong-code press below are all noted on the same source,
  // and five notes lock it; the remaining shapes stand in
  // the #89 family and at the end of the drill, where the
  // notes can cost nothing. The press carries the right
  // setup code, so the refusal judged is the password's own.
  const rLengthS = await formPostRaw(BASE, "/setup",
    { name: "Drill Refusal Two", code: SETUP_CODE, password: "short", confirm: "short" });
  check("#147: a short password is refused as too short, on the setup door too",
    rLengthS.status === 302 &&
      (rLengthS.headers.location || "").includes("error=pwlength"),
    "status " + rLengthS.status + " location " + rLengthS.headers.location);
  // And the page it lands on — the sign-in address serves
  // the setup page while no account stands — speaks the
  // standing sentence the change form uses, word for word.
  const lengthPageS = await raw(BASE, "GET", "/login?error=pwlength", {});
  check("#147: the spend page's length refusal is the standing sentence, word for word",
    lengthPageS.status === 200 &&
      lengthPageS.text.includes("The password needs at least 12 characters."),
    "status " + lengthPageS.status);
  const authS = makeAuthenticator();
  const spendOptions = (fields) => jsonPost("/setup/passkey/options", fields);
  const spendVerify = (cred) => jsonPost("/setup/passkey/verify", { response: cred });
  const badCode = await spendOptions({ name: NAME_S, code: "not the setup code" });
  check("#122 setup: a wrong setup code refuses the ceremony before anything is minted",
    badCode.status === 400 && !sessionCookieOf(badCode),
    "status " + badCode.status);
  const opts1 = await spendOptions({ name: NAME_S, code: SETUP_CODE });
  check("#122 setup: the ceremony options carry the page's name and a handle minted for the spend",
    opts1.status === 200 && !!opts1.json && !!opts1.json.challenge &&
      !!opts1.json.user && !!opts1.json.user.id && opts1.json.user.name === NAME_S,
    "status " + opts1.status + " body " + (opts1.text || "").slice(0, 120));
  const stillSetup = await raw(BASE, "GET", "/login", {});
  check("#122 setup: an abandoned ceremony makes no account — the setup page still stands",
    stillSetup.status === 200 && stillSetup.text.includes('action="/setup"'),
    "status " + stillSetup.status);
  const opts2 = await spendOptions({ name: NAME_S, code: SETUP_CODE });
  const credS = authS.attestation(opts2.json.challenge);
  const verifyS = await spendVerify(credS);
  const cookieS = sessionCookieOf(verifyS);
  check("#122 setup: the ceremony lands, the account is created and the session begins",
    verifyS.status === 200 && !!cookieS, "status " + verifyS.status);
  check("#141: the setup spend stands the device's sign-in view up as the passkey view",
    (verifyS.headers["set-cookie"] || []).some((c) => c.startsWith("ts_view=passkey")),
    "cookies " + (verifyS.headers["set-cookie"] || []).map((c) => c.split("=")[0]).join(","));
  const meS = await raw(BASE, "GET", "/api/auth/me", { Cookie: cookieS || "" });
  check("#122 setup: the first account holds no password and one passkey",
    meS.status === 200 && meS.json && meS.json.hasPassword === false &&
      meS.json.passkeys.length === 1,
    "me " + meS.status + " body " + (meS.text || "").slice(0, 120));
  check("#122 setup: the session the spend begins is stamped with the passkey as its proof",
    meS.status === 200 && meS.json && meS.json.proofVia === "passkey",
    "proofVia " + (meS.json && meS.json.proofVia));
  const replayS = await spendVerify(credS);
  check("#122 setup: a replayed ceremony answer is refused — the challenge spent once",
    (replayS.status === 400 || replayS.status === 401) && !sessionCookieOf(replayS),
    "status " + replayS.status);
  const secondPress = await setupPress("Second Person", "second-person-password", SETUP_CODE);
  check("#122 setup: after the passkey-first account a setup press is refused — first-wins intact",
    !secondPress, "cookie " + !!secondPress);
  const handleS = b64uDrillToBuf(opts2.json.user.id);
  const tapOptsS = await jsonPost("/login/passkey/options", {});
  const tapS = await jsonPost("/login/passkey/verify",
    authS.assertion(tapOptsS.json.challenge, handleS));
  check("#122 setup: the passkey the account was born with signs its person in",
    tapS.status === 200 && !!sessionCookieOf(tapS), "status " + tapS.status);
  console.log(count + " checks, " + failures + " failures");
  process.exit(failures === 0 ? 0 : 1);
}

const a = await callerFor(A, "Drill A");
let res = await a.call("GET", "/api/v1/state");
check("sign-in: person A reads state", res.status === 200, "status " + res.status);
let stA = res.json;
check("state: me is person A", stA && stA.me && stA.me.email === A, stA && stA.me && stA.me.email);
check("state: seeded boards are Personal and Professional",
  !!boardByName(stA, "Personal") && !!boardByName(stA, "Professional"),
  stA.boards.map((b) => b.name).join(", "));
const personal = boardByName(stA, "Personal");
check("state: five seeded columns",
  personal.columns.length === 5 &&
    ["inbox", "ready", "doing", "waiting", "done"].every((k) =>
      personal.columns.some((c) => c.kind === k)),
  personal.columns.map((c) => c.kind).join(", "));
check("state: seeded labels ride along",
  Array.isArray(stA.labels) && stA.labels.filter((l) => l.boardId === personal.id).length === 4,
  "labels on Personal: " + stA.labels.filter((l) => l.boardId === personal.id).length);
check("state: version is a number and no key exists yet",
  typeof stA.version === "number" && stA.key && stA.key.has_key === false,
  "version " + stA.version);
check("state: agentHost is named", typeof stA.agentHost === "string" && stA.agentHost.length > 0, stA.agentHost);

// --- Cards, end to end -------------------------------------------------------
const MARKER = "Drill card " + Date.now();
res = await a.call("POST", "/api/v1/cards", {
  board_id: personal.id, column_id: "inbox", title: MARKER,
  notes: "drill notes", due_date: "2026-11-05",
});
check("cards: create answers 201", res.status === 201, "status " + res.status);
const cardId = res.json && res.json.card && res.json.card.id;
stA = await state(a);
let card = cardByTitle(stA, MARKER);
check("cards: the new card stands in the inbox",
  !!card && card.columnId === "inbox" && card.due === "2026-11-05" && card.notes === "drill notes",
  card ? card.columnId + " / " + card.due : "missing");
const vAfterCreate = stA.version;
check("cards: a change raises the version", vAfterCreate > 0, "version " + vAfterCreate);

res = await a.call("PATCH", "/api/v1/cards/" + cardId, { title: MARKER + " renamed", column_id: "doing" });
check("cards: rename and move answer 200", res.status === 200, "status " + res.status);
stA = await state(a);
card = cardByTitle(stA, MARKER + " renamed");
check("cards: the card stands in Doing under its new name",
  !!card && card.columnId === "doing", card && card.columnId);
check("versions: a person write stamps lastChange as owner",
  stA.lastChange && stA.lastChange.by === "owner", stA.lastChange && stA.lastChange.by);

// --- Checklist ---------------------------------------------------------------
res = await a.call("POST", "/api/v1/cards/" + cardId + "/steps", { text: "First step" });
check("steps: add answers 201", res.status === 201, "status " + res.status);
const step1 = res.json && res.json.step && res.json.step.id;
res = await a.call("POST", "/api/v1/cards/" + cardId + "/steps", { text: "Second step" });
const step2 = res.json && res.json.step && res.json.step.id;
res = await a.call("PATCH", "/api/v1/cards/" + cardId + "/steps/" + step1, { done: true });
check("steps: tick answers 200", res.status === 200, "status " + res.status);
res = await a.call("PATCH", "/api/v1/cards/" + cardId + "/steps/" + step2, { position: 0 });
stA = await state(a);
card = (stA.cards || []).find((c) => c.id === cardId);
check("steps: order and tick read back",
  !!card && card.steps.length === 2 && card.steps[0].text === "Second step" &&
    card.steps.find((s) => s.text === "First step").done === true,
  card ? card.steps.map((s) => s.text + (s.done ? "✓" : "")).join(" | ") : "missing");

// --- Links -------------------------------------------------------------------
res = await a.call("POST", "/api/v1/cards/" + cardId + "/links", { url: "example.com/drill" });
check("links: a bare host gains https", res.status === 201 && res.json.link && res.json.link.url === "https://example.com/drill",
  res.json && res.json.link && res.json.link.url);
const linkId = res.json && res.json.link && res.json.link.id;
res = await a.call("POST", "/api/v1/cards/" + cardId + "/links", { url: "ftp://example.com/x" });
check("links: a non-web address is refused", res.status === 400, "status " + res.status);
res = await a.call("DELETE", "/api/v1/cards/" + cardId + "/links/" + linkId);
check("links: delete answers 200", res.status === 200, "status " + res.status);

// --- Labels and projects -------------------------------------------------------
res = await a.call("POST", "/api/v1/labels", { board_id: personal.id, name: "Drill label", colour: "red" });
check("labels: create answers 201", res.status === 201, "status " + res.status);
const labelId = res.json && res.json.label && res.json.label.id;
res = await a.call("PATCH", "/api/v1/cards/" + cardId, { labels: [labelId] });
stA = await state(a);
card = (stA.cards || []).find((c) => c.id === cardId);
check("labels: the label stands on the card",
  !!card && JSON.stringify(card.labels).includes(labelId), JSON.stringify(card && card.labels));
res = await a.call("POST", "/api/v1/projects", { board_id: personal.id, name: "Drill project" });
const projectId = res.json && res.json.project && res.json.project.id;
check("projects: create answers 201", res.status === 201, "status " + res.status);
res = await a.call("PATCH", "/api/v1/cards/" + cardId, { project_id: projectId });
stA = await state(a);
card = (stA.cards || []).find((c) => c.id === cardId);
check("projects: the card carries the project", !!card && card.projectId === projectId, card && card.projectId);
res = await a.call("DELETE", "/api/v1/projects/" + projectId);
stA = await state(a);
card = (stA.cards || []).find((c) => c.id === cardId);
check("projects: deleting the project clears the card's project",
  res.status === 200 && !!card && card.projectId === null, "status " + res.status);
res = await a.call("DELETE", "/api/v1/labels/" + labelId);
check("labels: delete answers 200", res.status === 200, "status " + res.status);

// --- Label colour modes, and the end of the project colour (issues #94, #95) ---
// A board carries labelColourMode: how the app paints a card's
// first label colour on the board. It starts at chip, a board
// PATCH sets it, an unknown value is refused whole, state
// carries it and a board copy copies it. A project no longer
// carries a colour at all: the field is refused by name on
// create and on change, and no project answer or state read
// carries one — the colour column itself rests in the schema.
stA = await state(a);
check("modes: a board starts at chip",
  !!boardByName(stA, "Personal") && boardByName(stA, "Personal").labelColourMode === "chip",
  boardByName(stA, "Personal") && boardByName(stA, "Personal").labelColourMode);
res = await a.call("PATCH", "/api/v1/boards/" + personal.id, { label_colour_mode: "trim" });
check("modes: setting a mode answers the board carrying it",
  res.status === 200 && res.json.board && res.json.board.labelColourMode === "trim",
  "status " + res.status + " mode " + (res.json && res.json.board && res.json.board.labelColourMode));
stA = await state(a);
check("modes: state carries the board's mode",
  boardByName(stA, "Personal").labelColourMode === "trim",
  boardByName(stA, "Personal").labelColourMode);
res = await a.call("PATCH", "/api/v1/boards/" + personal.id, { label_colour_mode: "loud" });
check("modes: an unknown mode is refused",
  res.status === 400 && /label_colour_mode/.test(res.json.error || ""), res.json && res.json.error);
stA = await state(a);
check("modes: the refused write left the mode standing",
  boardByName(stA, "Personal").labelColourMode === "trim",
  boardByName(stA, "Personal").labelColourMode);
res = await a.call("POST", "/api/v1/boards/" + personal.id + "/copy",
  { name: "Mode Copy", columns: true, labels: true, projects: true, cards: false });
check("modes: a board copy copies the mode",
  res.status === 201 && res.json.board && res.json.board.labelColourMode === "trim",
  "status " + res.status + " mode " + (res.json && res.json.board && res.json.board.labelColourMode));
const modeCopyId = res.json && res.json.board && res.json.board.id;
res = await a.call("DELETE", "/api/v1/boards/" + modeCopyId);
check("modes: the copy deletes again", res.status === 200, "status " + res.status);
res = await a.call("PATCH", "/api/v1/boards/" + personal.id, { label_colour_mode: "chip" });
check("modes: the mode returns to chip", res.status === 200, "status " + res.status);

res = await a.call("POST", "/api/v1/projects", { board_id: personal.id, name: "Colour refusal", colour: "#123456" });
check("projects: a colour on create is refused by name",
  res.status === 400 && /colour/.test(res.json.error || "") && /is not part of this call/.test(res.json.error || ""),
  res.json && res.json.error);
res = await a.call("POST", "/api/v1/projects", { board_id: personal.id, name: "Plain project" });
check("projects: a create answers the project with no colour on it",
  res.status === 201 && res.json.project && !("colour" in res.json.project) &&
    typeof res.json.project.name === "string" && typeof res.json.project.boardId === "string",
  "status " + res.status + " keys " + (res.json && res.json.project && Object.keys(res.json.project).join(",")));
const plainProjectId = res.json && res.json.project && res.json.project.id;
res = await a.call("PATCH", "/api/v1/projects/" + plainProjectId, { colour: "#123456" });
check("projects: a colour on change is refused by name",
  res.status === 400 && /colour/.test(res.json.error || "") && /is not part of this call/.test(res.json.error || ""),
  res.json && res.json.error);
stA = await state(a);
check("projects: no project in state carries a colour",
  (stA.projects || []).every((pr) => !("colour" in pr)), "projects " + (stA.projects || []).length);
res = await a.call("DELETE", "/api/v1/projects/" + plainProjectId);
check("projects: the plain project deletes", res.status === 200, "status " + res.status);

// --- Columns, including the delete that moves cards ---------------------------
res = await a.call("POST", "/api/v1/columns", { board_id: personal.id, name: "Someday", kind: "someday" });
check("columns: add answers 201", res.status === 201, "status " + res.status);
const somedayId = res.json && res.json.column && res.json.column.id;
res = await a.call("PATCH", "/api/v1/cards/" + cardId, { column_id: "someday" });
check("cards: move into the new column", res.status === 200, "status " + res.status);
res = await a.call("DELETE", "/api/v1/columns/" + somedayId, { move_to_column_id: "inbox" });
check("columns: delete with a destination answers 200", res.status === 200, "status " + res.status);
stA = await state(a);
card = (stA.cards || []).find((c) => c.id === cardId);
check("columns: the card landed in the inbox", !!card && card.columnId === "inbox", card && card.columnId);
res = await a.call("DELETE", "/api/v1/columns/" + somedayId);
check("columns: deleting a gone column is a 404", res.status === 404, "status " + res.status);

// --- Boards: make, copy, delete rules (on person B, kept tidy) -----------------
// Person B's name comes from the invite their account was made
// with, on both homes; the transition section below watches a
// name claim at the old door refresh the stored name behind it
// (issue #66), and B's own name outrank the claim.
const b = await callerFor(B, "");
let stB = await state(b);
check("isolation: person B sees none of person A's cards",
  !(stB.cards || []).some((c) => String(c.title).includes("Drill card")), "B cards: " + (stB.cards || []).length);
const bPersonal = boardByName(stB, "Personal");
const bProfessional = boardByName(stB, "Professional");
res = await b.call("POST", "/api/v1/boards/" + bPersonal.id + "/copy",
  { name: "Drill Copy", columns: true, labels: true, projects: true, cards: true });
check("boards: copy answers 201 with the seeded structure",
  res.status === 201 && res.json.board && res.json.board.columns.length === 5, "status " + res.status);
const copyId = res.json.board.id;
res = await b.call("DELETE", "/api/v1/boards/" + bProfessional.id);
check("boards: an empty board deletes", res.status === 200, "status " + res.status);
res = await b.call("DELETE", "/api/v1/boards/" + copyId);
check("boards: the copied board deletes", res.status === 200, "status " + res.status);
// A board holding cards deletes whole (issue #134): the
// cards go with it — and in self-host mode the data file
// proves the cascade, leaving no card, step, column, label
// or project row of the board's standing.
res = await b.call("POST", "/api/v1/boards", { name: "Delete Whole" });
check("boards: a board to delete whole is made",
  res.status === 201 && !!res.json.board, "status " + res.status);
const wholeId = res.json.board.id;
res = await b.call("POST", "/api/v1/cards", { board_id: wholeId, column_id: "inbox", title: "Whole one" });
const wholeCard1 = res.json && res.json.card && res.json.card.id;
res = await b.call("POST", "/api/v1/cards/" + wholeCard1 + "/steps", { text: "A step that goes too" });
res = await b.call("POST", "/api/v1/cards", { board_id: wholeId, column_id: "inbox", title: "Whole two" });
const wholeCard2 = res.json && res.json.card && res.json.card.id;
check("boards: the board holds two cards", !!wholeCard1 && !!wholeCard2,
  "cards " + wholeCard1 + " " + wholeCard2);
res = await b.call("DELETE", "/api/v1/boards/" + wholeId);
check("#134: a board holding cards deletes", res.status === 200, "status " + res.status);
stB = await state(b);
check("#134: the board and its cards are gone from the state",
  !boardByName(stB, "Delete Whole") && !(stB.cards || []).some((c) => c.boardId === wholeId),
  "boards " + (stB.boards || []).length + " cards " + (stB.cards || []).length);
if (MODE === "selfhost" && args["server-config"]) {
  const cfgW = JSON.parse(readFileSync(args["server-config"], "utf8"));
  const fileW = join(dirname(args["server-config"]), String(cfgW.dataDir || "data"), "tasksparkle.sqlite");
  const roW = new DatabaseSync(fileW, { readOnly: true });
  const leftW = (sql, ...binds) => roW.prepare(sql).get(...binds).n;
  const leftoversW =
    leftW("SELECT COUNT(*) AS n FROM boards WHERE id = ?", wholeId) +
    leftW("SELECT COUNT(*) AS n FROM cards WHERE board_id = ?", wholeId) +
    leftW("SELECT COUNT(*) AS n FROM checklist_items WHERE card_id IN (?, ?)", wholeCard1, wholeCard2) +
    leftW("SELECT COUNT(*) AS n FROM \"columns\" WHERE board_id = ?", wholeId) +
    leftW("SELECT COUNT(*) AS n FROM labels WHERE board_id = ?", wholeId) +
    leftW("SELECT COUNT(*) AS n FROM projects WHERE board_id = ?", wholeId);
  roW.close();
  check("#134: the data file holds nothing of the board — the cascade took every row",
    leftoversW === 0, "leftover rows " + leftoversW);
}
res = await b.call("DELETE", "/api/v1/boards/" + bPersonal.id);
check("boards: the last board is kept", res.status === 400 && /at least one board/.test(res.json.error || ""),
  "status " + res.status);

// --- The write gate -------------------------------------------------------------
stA = await state(a);
res = await a.call("POST", "/api/v1/cards", { board_id: personal.id, column_id: "inbox", title: "Gate check", bogus: 1 });
check("gate: an unknown field is refused by name",
  res.status === 400 && /bogus/.test(res.json.error || ""), res.json && res.json.error);
res = await a.call("POST", "/api/v1/cards", "{not json");
check("gate: a non-JSON body is refused", res.status === 400 && /not JSON/.test(res.json.error || ""), res.json && res.json.error);
const vNow = stA.version;
res = await a.call("PATCH", "/api/v1/cards/" + cardId, { title: MARKER + " renamed", baseVersion: vNow });
check("gate: a no-change write keeps the version",
  res.status === 200 && res.json.version === vNow, "version " + (res.json && res.json.version) + " vs " + vNow);
res = await a.call("PATCH", "/api/v1/cards/" + cardId, { notes: "based on the current version", baseVersion: vNow });
check("gate: a write on the current base lands", res.status === 200 && res.json.version === vNow + 1,
  "version " + (res.json && res.json.version));
res = await a.call("PATCH", "/api/v1/cards/" + cardId, { notes: "stale", baseVersion: vNow });
check("gate: the same base again is refused as stale",
  res.status === 409 && /changed since you read/.test(res.json.error || ""), "status " + res.status);

// --- Keys -----------------------------------------------------------------------
res = await a.call("GET", "/api/v1/me/token");
check("keys: the list starts empty", res.status === 200 && res.json.keys.length === 0, "status " + res.status);
res = await a.call("POST", "/api/v1/me/token", { name: "Drill Key" });
check("keys: mint answers 201 with the whole key once",
  res.status === 201 && typeof res.json.key === "string" && res.json.key.startsWith("tsk_live_") &&
    res.json.last4 === res.json.key.slice(-4), "status " + res.status);
const key1 = res.json.key; const key1Id = res.json.id;
res = await a.call("POST", "/api/v1/me/token", { name: "Second Key" });
const key2 = res.json.key; const key2Id = res.json.id;
res = await a.agentCall("GET", "/api/v1/state", key1);
check("keys: a key reads its owner's boards at the agent door, with no owner email (issue #65)",
  res.status === 200 && res.json.me && res.json.me.email === undefined && Array.isArray(res.json.boards),
  "status " + res.status);
res = await raw(AGENT_BASE, "PATCH", "/api/v1/cards/" + cardId, {
  Authorization: "Bearer " + key1, "Content-Type": "application/json",
}, JSON.stringify({ notes: "written by the key" }));
check("keys: a key write answers 200", res.status === 200, "status " + res.status);
stA = await state(a);
check("versions: a key write stamps lastChange as agent",
  stA.lastChange && stA.lastChange.by === "agent", stA.lastChange && stA.lastChange.by);
res = await a.agentCall("GET", "/api/v1/me/token", key1);
check("keys: a key cannot list keys", res.status === 403, "status " + res.status);
res = await a.call("PATCH", "/api/v1/me/token/" + key1Id, { name: "Renamed Key" });
check("keys: rename answers 200 and the list shows it",
  res.status === 200 && res.json.key.name === "Renamed Key", "status " + res.status);
res = await a.call("DELETE", "/api/v1/me/token");
check("keys: a collection delete names no key and is refused", res.status === 400, "status " + res.status);
res = await a.call("DELETE", "/api/v1/me/token/" + key1Id);
check("keys: revoke answers 200", res.status === 200, "status " + res.status);
res = await a.agentCall("GET", "/api/v1/state", key1);
check("keys: a revoked key stops at once", res.status === 401, "status " + res.status);
res = await a.agentCall("GET", "/api/v1/state", key2);
check("keys: the other key still works", res.status === 200, "status " + res.status);

// --- Directions ------------------------------------------------------------------
res = await a.agentCall("GET", "/api/v1/directions", key2);
check("directions: a key reads them as plain text",
  res.status === 200 && /text\/plain/.test(res.headers["content-type"] || ""), "status " + res.status);
const baseLine = (res.text.split("\n").find((l) => l.startsWith("Base address:")) || "");
check("directions: the base address names the agent door",
  baseLine.includes(stA.agentHost), baseLine);
if (MODE === "selfhost") {
  check("directions: self-host directions carry the local http address",
    baseLine.startsWith("Base address: http://"), baseLine);
}
check("directions: the build stamp rides at the top", /^Build: r20/.test(res.text.split("\n")[1] || res.text.split("\n")[0] || ""),
  res.text.split("\n").slice(0, 2).join(" | "));

// --- Doors, identity and the key's view (issues #61, #64, #65, #66) -----------------
// What a caller sees depends on the door it came through. The
// change stamp (who last changed the boards, and when) is the
// person's own signal: it rides the person's version and state
// answers and no one else's, so a key polling for changes learns
// the version number and nothing about the person's presence
// (issue #64). A key's state likewise carries the boards and the
// owner's name — the work — without the owner's email, the key
// block or the stamp (issue #65). A person's display name is
// theirs to set in the app; a key cannot set it. A name claim at
// sign-in refreshes the stored name, a guess from the address
// never outranks a real name, and the person's own name outranks
// both (issue #66). The directions tell an agent plainly that
// its key's name is stamped on its work and stays (issue #61).
res = await a.agentCall("GET", "/api/v1/version", key2);
check("#64: a key's version answer carries the number and the build, and no change stamp",
  res.status === 200 && typeof res.json.version === "number" && typeof res.json.build === "string" &&
    !("lastChange" in res.json), JSON.stringify(res.json));
res = await a.call("GET", "/api/v1/version");
check("#64: the person's version answer keeps the change stamp",
  res.status === 200 && !!res.json.lastChange && typeof res.json.lastChange.by === "string",
  JSON.stringify(res.json && res.json.lastChange));
res = await a.agentCall("GET", "/api/v1/state", key2);
check("#65: a key's state carries boards and the owner's name, and no email, key block or stamp",
  res.status === 200 && Array.isArray(res.json.boards) && !!res.json.me &&
    typeof res.json.me.name === "string" && res.json.me.name.length > 0 &&
    res.json.me.email === undefined && !("key" in res.json) && !("lastChange" in res.json),
  "status " + res.status + " me keys: " + (res.json && res.json.me ? Object.keys(res.json.me).join(",") : "none"));
stA = await state(a);
check("#65: the person's state keeps their email, the key block and the change stamp",
  stA.me.email === A && !!stA.key && stA.key.has_key === true && !!stA.lastChange,
  "me keys: " + Object.keys(stA.me).join(","));
res = await a.agentCall("GET", "/api/v1/me", key2);
check("#65: the key's /me answer names the person and carries no email",
  res.status === 200 && typeof res.json.name === "string" && res.json.name.length > 0 &&
    res.json.email === undefined && res.text.indexOf(A) === -1,
  "status " + res.status + " body " + res.text.slice(0, 120));

res = await a.call("PATCH", "/api/v1/me", { name: "Drill Person A" });
check("#66: the person sets their display name",
  res.status === 200 && res.json.name === "Drill Person A", "status " + res.status + " name " + (res.json && res.json.name));
res = await a.call("GET", "/api/v1/me");
check("#66: the display name reads back on /me, and the person's /me keeps their email",
  res.status === 200 && res.json.name === "Drill Person A" && res.json.email === A, res.json && res.json.name);
stA = await state(a);
check("#66: the state carries the display name",
  stA.me.name === "Drill Person A", stA.me.name);
res = await a.call("PATCH", "/api/v1/me", { name: "   " });
check("#66: an empty display name is refused",
  res.status === 400, "status " + res.status);
res = await raw(AGENT_BASE, "PATCH", "/api/v1/me", {
  Authorization: "Bearer " + key2, "Content-Type": "application/json",
}, JSON.stringify({ name: "Agent Rename" }));
check("#66: a key cannot rename the person",
  res.status === 403, "status " + res.status);
res = await a.call("GET", "/api/v1/me");
check("#66: the name stands after the key's try",
  res.status === 200 && res.json.name === "Drill Person A", res.json && res.json.name);
// Issue #131: the rename is the sign-in name's rename too.
// The name a person types to sign in, the name the Admin
// roster lists and the name the account answers to all move
// in the same act — one name, true everywhere.
const oldNameSignIn = await formPostRaw(BASE, "/login",
  { name: NAME_A, password: PASSWORD_A });
check("#131: signing in under the old name is refused once the rename stands",
  !sessionCookieOf(oldNameSignIn), "status " + oldNameSignIn.status);
const newNameSignIn = await formPostRaw(BASE, "/login",
  { name: "Drill Person A", password: PASSWORD_A });
check("#131: signing in under the new name works",
  !!sessionCookieOf(newNameSignIn), "status " + newNameSignIn.status);
const rosterAfterRename = await a.call("GET", "/api/auth/people");
const rosterNames = ((rosterAfterRename.json || {}).people || []).map((p) => p.name);
check("#131: the Admin roster lists the new name and not the old",
  rosterAfterRename.status === 200 && rosterNames.includes("Drill Person A") &&
    !rosterNames.includes(NAME_A),
  "roster " + JSON.stringify(rosterNames));
res = await a.call("PATCH", "/api/v1/me", { name: "Drill Person A" });
check("#131: the name is set back for the families that follow",
  res.status === 200 && res.json.name === "Drill Person A",
  "status " + res.status + " body " + (res.text || "").slice(0, 120));
const restoredSignIn = await formPostRaw(BASE, "/login",
  { name: "Drill Person A", password: PASSWORD_A });
check("#131: signing in under the restored name works again",
  !!sessionCookieOf(restoredSignIn), "status " + restoredSignIn.status);

res = await a.agentCall("GET", "/api/v1/directions", key2);
check("#61: the directions tell an agent a key's name resolves live on all its work — cards, comments and hand-overs alike",
  res.status === 200 && res.text.includes("the key itself, never its name") &&
    res.text.includes("renames its name on the work everywhere at once"),
  "directions read, " + (res.text || "").length + " chars");
check("#64/#65: the directions describe the version answer a key actually gets",
  res.text.includes("{version, build}") && !res.text.includes("me (the owner's name and email)"),
  "state and version descriptions checked");

if (MODE === "worker") {
  // The transition door (issue #109): while Access still stands
  // beside the new door, its tokens resolve only owner rows
  // that already stand — person B's row stands under their
  // account key — and a name claim arriving with the token
  // still refreshes the stored name behind the person's own
  // (issue #66). A token for an identity with no standing row
  // is refused, and the refusal creates nothing: the frozen
  // property the cutover depends on.
  const meAs = (name) => accessCall(B, name, "GET", "/api/v1/me");
  res = await meAs("");
  check("transition: a token resolves the standing row under B's account key",
    res.status === 200 && res.json.name === "Drill B", res.json && res.json.name);
  res = await meAs("Bee Keeper");
  check("#66: a real name from the old door replaces the stored name",
    res.status === 200 && res.json.name === "Bee Keeper", res.json && res.json.name);
  res = await meAs("");
  check("#66: a later empty claim changes nothing",
    res.status === 200 && res.json.name === "Bee Keeper", res.json && res.json.name);
  res = await meAs("Bee Keeper II");
  check("#66: a changed name at the old door refreshes the stored name",
    res.status === 200 && res.json.name === "Bee Keeper II", res.json && res.json.name);
  res = await b.call("PATCH", "/api/v1/me", { name: "Bee in Charge" });
  check("#66: the person's own name saves",
    res.status === 200 && res.json.name === "Bee in Charge", res.json && res.json.name);
  res = await meAs("Someone Else");
  check("#66: the person's own name outranks the next claim",
    res.status === 200 && res.json.name === "Bee in Charge", res.json && res.json.name);
  res = await accessCall("drill-b@example.test", "Drill B", "GET", "/api/v1/state");
  check("transition: a token for an address with no standing row is refused (the door is frozen)",
    res.status === 403, "status " + res.status);
  res = await accessCall("nobody@example.test", "Nobody", "GET", "/api/v1/state");
  check("transition: a token for an unknown address is refused the same way",
    res.status === 403, "status " + res.status);
  const peopleView = await a.call("GET", "/api/auth/people");
  check("transition: the refused tokens created no board set (the claim list holds none for them)",
    peopleView.status === 200 && (peopleView.json.unclaimed || []).length === 0,
    "unclaimed: " + JSON.stringify((peopleView.json && peopleView.json.unclaimed) || null));
  check("#114: an unclaimed set is carried by shape only — no address rides the list",
    (peopleView.json.unclaimed || []).every((s) => !("email" in s)),
    "keys: " + JSON.stringify((peopleView.json.unclaimed || []).map((s) => Object.keys(s))));
  // Issue #131: B's rename here was a real sign-in rename
  // too, so the families that follow — which sign B in by
  // the drill name — need the name set back through the
  // same Account door.
  res = await b.call("PATCH", "/api/v1/me", { name: NAME_B });
  check("#131: B's name is set back through the Account rename",
    res.status === 200 && res.json.name === NAME_B,
    "status " + res.status + " body " + (res.text || "").slice(0, 120));
  const bNameBack = await formPostRaw(BASE, "/login",
    { name: NAME_B, password: PASSWORD_B });
  check("#131: B signs in under the restored name",
    !!sessionCookieOf(bNameBack), "status " + bNameBack.status);
}

// --- Creators and comments (issues #50, #51) ---------------------------------------
// A card made with a key is stamped with that key as its
// creator; a card the person makes carries no stamp. The
// stamp records the key itself, never its name (issues #120,
// #121): the name reads from the key's record as the card is
// read, so renaming the key renames the maker name on the
// card with it, and revoking it leaves the name standing on
// the standing row — the rename-and-revoke checks below read
// that way, and the #121 section proves the whole rule for
// the creator stamp and the step. A comment's author follows
// the same rule (issue #120). A board copy takes the copier
// as creator while leaving the source's comments behind.
async function agentPost(path, key, body) {
  return raw(AGENT_BASE, "POST", path, {
    Authorization: "Bearer " + key, "Content-Type": "application/json",
  }, JSON.stringify(body));
}

res = await a.call("POST", "/api/v1/cards", { board_id: personal.id, column_id: "inbox", title: "Person-made card" });
check("creators: a person-made card answers with no creator",
  res.status === 201 && res.json.card && res.json.card.creatorKeyName === null &&
    res.json.card.creatorKeyId === null,
  "status " + res.status + " creator " + (res.json && res.json.card && res.json.card.creatorKeyName) +
    " id " + (res.json && res.json.card && res.json.card.creatorKeyId));
res = await agentPost("/api/v1/cards", key2, { board_id: personal.id, column_id: "inbox", title: "Key-made card" });
check("creators: a key-made card answers with the key's name",
  res.status === 201 && res.json.card && res.json.card.creatorKeyName === "Second Key",
  "status " + res.status + " creator " + (res.json && res.json.card && res.json.card.creatorKeyName));
check("#123: a key-made card answers with its maker's key id beside the name",
  res.status === 201 && res.json.card && res.json.card.creatorKeyId === key2Id,
  "creator id " + (res.json && res.json.card && res.json.card.creatorKeyId) + " vs key " + key2Id);
const keyCardId = res.json && res.json.card && res.json.card.id;

// Comments: the person and the key each write one on the drill
// card; both read back in order with the right tags, and the
// person's comment raises the version exactly once.
stA = await state(a);
const vBeforeComment = stA.version;
res = await a.call("POST", "/api/v1/cards/" + cardId + "/comments", { body: "Person update" });
check("comments: a person comment answers 201, untagged, one version rise",
  res.status === 201 && res.json.comment && res.json.comment.authorKeyName === null &&
    res.json.version === vBeforeComment + 1,
  "status " + res.status + " version " + (res.json && res.json.version) + " vs " + vBeforeComment);
const personCommentId = res.json && res.json.comment && res.json.comment.id;
res = await agentPost("/api/v1/cards/" + cardId + "/comments", key2, { body: "Agent update" });
check("comments: a key comment answers 201 wearing the key's name",
  res.status === 201 && res.json.comment && res.json.comment.authorKeyName === "Second Key",
  "status " + res.status + " author " + (res.json && res.json.comment && res.json.comment.authorKeyName));
const agentCommentId = res.json && res.json.comment && res.json.comment.id;
stA = await state(a);
card = (stA.cards || []).find((c) => c.id === cardId);
check("comments: both read back on the card, in order, with their tags",
  !!card && card.comments.length === 2 && card.comments[0].body === "Person update" &&
    card.comments[0].authorKeyName === null && card.comments[1].body === "Agent update" &&
    card.comments[1].authorKeyName === "Second Key",
  card ? JSON.stringify(card.comments.map((c) => c.authorKeyName)) : "missing");
res = await b.call("POST", "/api/v1/cards/" + cardId + "/comments", { body: "Not my card" });
check("comments: another owner's card is not found", res.status === 404, "status " + res.status);
res = await a.call("POST", "/api/v1/cards/" + cardId + "/comments", { body: "x".repeat(2001) });
check("comments: a body past the cap is refused", res.status === 400, "status " + res.status);

// A board copy made with the key: the copied cards take the
// copier as creator, and the source's comments stay behind.
res = await agentPost("/api/v1/boards/" + personal.id + "/copy", key2,
  { name: "Creator Copy", columns: true, labels: true, projects: true, cards: true });
check("creators: a copy made with a key answers 201", res.status === 201, "status " + res.status);
stA = await state(a);
const copiedBoard = boardByName(stA, "Creator Copy");
const copiedCards = copiedBoard ? stA.cards.filter((c) => c.boardId === copiedBoard.id) : [];
const copiedDrill = copiedCards.find((c) => String(c.title).includes("Drill card"));
check("creators: every copied card takes the copier as its creator",
  copiedCards.length > 0 && copiedCards.every((c) => c.creatorKeyName === "Second Key"),
  "copied cards: " + copiedCards.length);
check("comments: a copied card starts with no comments",
  !!copiedDrill && copiedDrill.comments.length === 0,
  copiedDrill ? "comments " + copiedDrill.comments.length : "missing");

// The names resolve live (issues #120, #121): rename the
// key and the card's maker name and the comment's author
// rename with it; revoke it and both still resolve, because
// the key's row stands as its record.
res = await a.call("PATCH", "/api/v1/me/token/" + key2Id, { name: "Renamed Second" });
check("creators: the key renames", res.status === 200, "status " + res.status);
stA = await state(a);
card = (stA.cards || []).find((c) => c.id === cardId);
let keyCard = (stA.cards || []).find((c) => c.id === keyCardId);
check("#121: a renamed key renames the maker name on the card it made",
  !!keyCard && keyCard.creatorKeyName === "Renamed Second",
  keyCard && keyCard.creatorKeyName);
check("#120: the same rename renames the key's standing comment's author",
  !!card && card.comments.some((c) => c.authorKeyName === "Renamed Second" &&
    c.authorName === "Renamed Second"),
  card ? JSON.stringify(card.comments.map((c) => c.authorKeyName)) : "missing");
res = await a.call("DELETE", "/api/v1/me/token/" + key2Id);
check("creators: the key revokes", res.status === 200, "status " + res.status);
stA = await state(a);
keyCard = (stA.cards || []).find((c) => c.id === keyCardId);
check("#121: a deleted key's maker name still resolves from its standing row",
  !!keyCard && keyCard.creatorKeyName === "Renamed Second", keyCard && keyCard.creatorKeyName);
res = await a.call("DELETE", "/api/v1/cards/" + cardId + "/comments/" + agentCommentId);
stA = await state(a);
card = (stA.cards || []).find((c) => c.id === cardId);
check("comments: a delete removes just that comment",
  res.status === 200 && !!card && card.comments.length === 1 && card.comments[0].id === personCommentId,
  "status " + res.status);

// --- Comment author names (issue #120) --------------------------------------------
// Every comment names its author: authorName carries the
// person's name for their comment and the key's name for a
// key's, beside authorKeyName naming the writing key. The
// comment stores only who wrote it — an identity, never the
// name — and the name resolves as the comment is read. So a
// rename, of the person or of the key, renames the author on
// every standing comment at once. The person's display name
// stands as "Drill Person A" from the #66 section above.
res = await a.call("POST", "/api/v1/me/token", { name: "Author Key" });
const authorKey = res.json && res.json.key; const authorKeyId = res.json && res.json.id;
check("#120: a fresh key stands for the author checks",
  res.status === 201 && typeof authorKey === "string", "status " + res.status);
res = await a.call("POST", "/api/v1/cards/" + cardId + "/comments", { body: "Person update, named" });
check("#120: a person comment answers with the person's name as its author",
  res.status === 201 && res.json.comment && res.json.comment.authorKeyName === null &&
    res.json.comment.authorName === "Drill Person A",
  "status " + res.status + " author " + (res.json && res.json.comment && res.json.comment.authorName));
res = await agentPost("/api/v1/cards/" + cardId + "/comments", authorKey, { body: "Agent update, named" });
check("#120: a key comment answers with the key's name as its author, both fields naming it",
  res.status === 201 && res.json.comment && res.json.comment.authorKeyName === "Author Key" &&
    res.json.comment.authorName === "Author Key",
  "status " + res.status + " author " + (res.json && res.json.comment && res.json.comment.authorName));
stA = await state(a);
card = (stA.cards || []).find((c) => c.id === cardId);
const namedPerson = card && card.comments.find((c) => c.body === "Person update, named");
const namedAgent = card && card.comments.find((c) => c.body === "Agent update, named");
check("#120: both names read back in the state, on the card's comments",
  !!namedPerson && namedPerson.authorName === "Drill Person A" && namedPerson.authorKeyName === null &&
    !!namedAgent && namedAgent.authorName === "Author Key" && namedAgent.authorKeyName === "Author Key",
  card ? JSON.stringify(card.comments.map((c) => c.authorName)) : "missing");
res = await a.call("PATCH", "/api/v1/me/token/" + authorKeyId, { name: "Author Key Renamed" });
check("#120: the author key renames", res.status === 200, "status " + res.status);
res = await a.call("PATCH", "/api/v1/me", { name: "Drill Person A Renamed" });
check("#120: the person renames", res.status === 200 && res.json.name === "Drill Person A Renamed",
  "status " + res.status);
stA = await state(a);
card = (stA.cards || []).find((c) => c.id === cardId);
const namedPersonAfter = card && card.comments.find((c) => c.body === "Person update, named");
const namedAgentAfter = card && card.comments.find((c) => c.body === "Agent update, named");
check("#120: the renames rename the standing comments' authors at once",
  !!namedPersonAfter && namedPersonAfter.authorName === "Drill Person A Renamed" &&
    !!namedAgentAfter && namedAgentAfter.authorName === "Author Key Renamed" &&
    namedAgentAfter.authorKeyName === "Author Key Renamed",
  card ? JSON.stringify(card.comments.map((c) => c.authorName)) : "missing");
res = await a.call("DELETE", "/api/v1/me/token/" + authorKeyId);
check("#120: the author key is deleted (revoked — its row stands)", res.status === 200, "status " + res.status);
stA = await state(a);
card = (stA.cards || []).find((c) => c.id === cardId);
const namedAgentRevoked = card && card.comments.find((c) => c.body === "Agent update, named");
check("#120: a deleted key's comments still resolve its name from the standing row",
  !!namedAgentRevoked && namedAgentRevoked.authorName === "Author Key Renamed" &&
    namedAgentRevoked.authorKeyName === "Author Key Renamed",
  card ? JSON.stringify(card.comments.map((c) => c.authorName)) : "missing");
res = await a.call("PATCH", "/api/v1/me", { name: "Drill Person A" });
check("#120: the person's name is put back for the sections after",
  res.status === 200 && res.json.name === "Drill Person A", "status " + res.status);

// --- Handing over (issue #119) ---------------------------------------------------
// Every card names whose turn its next step is: the person,
// one of their keys, or no one. A hand-over stamps the moment
// and the hander and marks the card waiting; the holder's
// first write to the card is the pickup, and nobody else's
// write is. The queue read names the caller's cards. Deleting
// a key hands its cards back to the person.
const keyCall = (method, path, key, body) => raw(AGENT_BASE, method, path,
  { Authorization: "Bearer " + key, "Content-Type": "application/json" },
  body != null ? JSON.stringify(body) : null);

res = await a.call("POST", "/api/v1/me/token", { name: "Handover One" });
const hKey1 = res.json.key; const hKey1Id = res.json.id;
res = await a.call("POST", "/api/v1/me/token", { name: "Handover Two" });
const hKey2 = res.json.key; const hKey2Id = res.json.id;

res = await a.agentCall("GET", "/api/v1/directions", hKey1);
check("#119: the directions carry the hand-over contract and the queue",
  res.status === 200 && /Handing over/.test(res.text) && /GET \/queue/.test(res.text),
  "status " + res.status);
stA = await state(a);
check("#119: the state carries the owner's live keys by id and name",
  Array.isArray(stA.keys) &&
    stA.keys.some((k) => k.id === hKey1Id && k.name === "Handover One") &&
    stA.keys.some((k) => k.id === hKey2Id && k.name === "Handover Two"),
  "keys: " + JSON.stringify((stA.keys || []).map((k) => k.name)));

res = await a.call("POST", "/api/v1/cards", { board_id: personal.id, column_id: "inbox", title: "Handover person card" });
check("#119: a person-made card starts as the person's step, not waiting",
  res.status === 201 && res.json.card.step &&
    res.json.card.step.holder === "owner" && res.json.card.step.keyId === null &&
    res.json.card.step.waiting === false && res.json.card.step.handedAt === null,
  "step " + JSON.stringify(res.json && res.json.card && res.json.card.step));
const hPersonCard = res.json.card.id;
res = await agentPost("/api/v1/cards", hKey1, { board_id: personal.id, column_id: "inbox", title: "Handover key card" });
check("#119: a key-made card starts as that key's step, not waiting",
  res.status === 201 && res.json.card.step &&
    res.json.card.step.holder === "agent" && res.json.card.step.keyId === hKey1Id &&
    res.json.card.step.keyName === "Handover One" && res.json.card.step.waiting === false,
  "step " + JSON.stringify(res.json && res.json.card && res.json.card.step));
const hKeyCard = res.json.card.id;
res = await agentPost("/api/v1/cards", hKey1, { board_id: personal.id, column_id: "inbox", title: "Handover created handed", next_step: hKey2Id });
check("#119: a card created handed to another key waits, stamped with its hander",
  res.status === 201 && res.json.card.step &&
    res.json.card.step.holder === "agent" && res.json.card.step.keyId === hKey2Id &&
    res.json.card.step.waiting === true && !!res.json.card.step.handedAt &&
    res.json.card.step.handedByKeyName === "Handover One",
  "step " + JSON.stringify(res.json && res.json.card && res.json.card.step));
const hCreatedHanded = res.json.card.id;

res = await a.call("POST", "/api/v1/cards", { board_id: personal.id, column_id: "inbox", title: "Handover refused", next_step: "token-not-a-key" });
check("#119: a next_step naming no key of the owner's is refused",
  res.status === 400, "status " + res.status);
res = await b.call("POST", "/api/v1/me/token", { name: "Foreign Key" });
const foreignKeyId = res.json.id;
res = await a.call("PATCH", "/api/v1/cards/" + hPersonCard, { next_step: foreignKeyId });
check("#119: another owner's key id is refused as a holder",
  res.status === 400, "status " + res.status);
res = await b.call("DELETE", "/api/v1/me/token/" + foreignKeyId);

// The flip, person to key, with the comment riding: one act,
// one version rise, the card waiting on the key.
stA = await state(a);
const vFlip = stA.version;
res = await a.call("PATCH", "/api/v1/cards/" + hPersonCard, { next_step: hKey1Id, comment: "Please take this one." });
check("#119: a hand-over with a riding comment flips the step and posts the comment",
  res.status === 200 && res.json.card.step.holder === "agent" &&
    res.json.card.step.keyId === hKey1Id && res.json.card.step.keyName === "Handover One" &&
    res.json.card.step.waiting === true && res.json.card.step.handedByKeyName === null &&
    res.json.card.comments.some((c) => c.body === "Please take this one." && c.authorKeyName === null),
  "step " + JSON.stringify(res.json && res.json.card && res.json.card.step));
check("#119: the comment and the flip together rise the version exactly once",
  res.json.version === vFlip + 1, "version " + (res.json && res.json.version) + " vs " + vFlip);

// A write by another key does not pick the card up; the
// holder's first write does.
res = await agentPost("/api/v1/cards/" + hPersonCard + "/comments", hKey2, { body: "Not mine, just noting." });
stA = await state(a);
card = (stA.cards || []).find((c) => c.id === hPersonCard);
check("#119: a write by another key leaves the card waiting",
  res.status === 201 && !!card && card.step.waiting === true,
  "waiting " + (card && card.step.waiting));
res = await agentPost("/api/v1/cards/" + hPersonCard + "/steps", hKey1, { text: "Picked up and started" });
stA = await state(a);
card = (stA.cards || []).find((c) => c.id === hPersonCard);
check("#119: the holder's first write picks the card up",
  res.status === 201 && !!card && card.step.waiting === false,
  "waiting " + (card && card.step.waiting));

// The flip back, key to person, again with a riding comment.
stA = await state(a);
const vBack = stA.version;
res = await keyCall("PATCH", "/api/v1/cards/" + hPersonCard, hKey1, { next_step: "owner", comment: "Back to you: needs a decision." });
check("#119: a key hands back to the person, stamped with the key, waiting on the person",
  res.status === 200 && res.json.card.step.holder === "owner" &&
    res.json.card.step.waiting === true && res.json.card.step.handedByKeyName === "Handover One" &&
    res.json.card.comments.some((c) => c.body === "Back to you: needs a decision." && c.authorKeyName === "Handover One") &&
    res.json.version === vBack + 1,
  "step " + JSON.stringify(res.json && res.json.card && res.json.card.step) + " version " + (res.json && res.json.version));
res = await a.call("POST", "/api/v1/cards/" + hPersonCard + "/comments", { body: "Got it, deciding now." });
stA = await state(a);
card = (stA.cards || []).find((c) => c.id === hPersonCard);
check("#119: the person's first write picks their card up",
  res.status === 201 && !!card && card.step.waiting === false,
  "waiting " + (card && card.step.waiting));

// A riding comment with no flip posts on its own; an empty
// one is refused; naming the standing holder changes nothing.
stA = await state(a);
const vNote = stA.version;
res = await a.call("PATCH", "/api/v1/cards/" + hPersonCard, { comment: "A note with no flip." });
check("#119: a comment can ride a card edit with no hand-over",
  res.status === 200 && res.json.version === vNote + 1 &&
    res.json.card.comments.some((c) => c.body === "A note with no flip."),
  "version " + (res.json && res.json.version) + " vs " + vNote);
res = await a.call("PATCH", "/api/v1/cards/" + hPersonCard, { comment: "   " });
check("#119: an empty riding comment is refused", res.status === 400, "status " + res.status);
stA = await state(a);
const vSame = stA.version;
res = await a.call("PATCH", "/api/v1/cards/" + hPersonCard, { next_step: "owner" });
check("#119: naming the holder the card already has changes nothing",
  res.status === 200 && res.json.version === vSame,
  "version " + (res.json && res.json.version) + " vs " + vSame);

// Hand to no one; the queue reads; archiving clears.
res = await a.call("PATCH", "/api/v1/cards/" + hPersonCard, { next_step: "none" });
check("#119: a hand-over to no one lands, not waiting",
  res.status === 200 && res.json.card.step.holder === "none" && res.json.card.step.waiting === false,
  "step " + JSON.stringify(res.json && res.json.card && res.json.card.step));
res = await a.call("PATCH", "/api/v1/cards/" + hPersonCard, { next_step: hKey2Id });
res = await keyCall("GET", "/api/v1/queue", hKey1);
check("#119: a key's queue holds only that key's cards",
  res.status === 200 && Array.isArray(res.json.cards) &&
    res.json.cards.some((c) => c.id === hKeyCard) &&
    !res.json.cards.some((c) => c.id === hPersonCard) &&
    !res.json.cards.some((c) => c.id === hCreatedHanded) &&
    res.json.cards.every((c) => c.step.holder === "agent" && c.step.keyId === hKey1Id),
  "queue " + JSON.stringify((res.json.cards || []).map((c) => c.title)));
res = await keyCall("GET", "/api/v1/queue", hKey2);
check("#119: the second key's queue holds its own cards",
  res.status === 200 &&
    res.json.cards.some((c) => c.id === hPersonCard) &&
    res.json.cards.some((c) => c.id === hCreatedHanded) &&
    !res.json.cards.some((c) => c.id === hKeyCard),
  "queue " + JSON.stringify((res.json.cards || []).map((c) => c.title)));
res = await a.call("GET", "/api/v1/queue");
check("#119: the person's queue holds the cards whose step is theirs",
  res.status === 200 &&
    res.json.cards.some((c) => c.title === "Person-made card") &&
    !res.json.cards.some((c) => c.id === hPersonCard) &&
    !res.json.cards.some((c) => c.id === hKeyCard) &&
    res.json.cards.every((c) => c.step.holder === "owner" && !c.archived),
  "queue " + JSON.stringify((res.json.cards || []).map((c) => c.title)));

res = await a.call("PATCH", "/api/v1/cards/" + hPersonCard, { archived: true });
stA = await state(a);
card = (stA.cards || []).find((c) => c.id === hPersonCard);
check("#119: archiving a card clears its step to no one",
  res.status === 200 && !!card && card.step.holder === "none" && card.step.waiting === false,
  "step " + JSON.stringify(card && card.step));
res = await a.call("PATCH", "/api/v1/cards/" + hPersonCard, { archived: false });
stA = await state(a);
card = (stA.cards || []).find((c) => c.id === hPersonCard);
check("#119: a restored card keeps no holder",
  res.status === 200 && !!card && card.step.holder === "none",
  "step " + JSON.stringify(card && card.step));

// Deleting a key hands its waiting cards back to the person.
res = await a.call("POST", "/api/v1/cards", { board_id: personal.id, column_id: "inbox", title: "Handover fallback card" });
const hFallbackCard = res.json.card.id;
res = await a.call("PATCH", "/api/v1/cards/" + hFallbackCard, { next_step: hKey2Id });
stA = await state(a);
card = (stA.cards || []).find((c) => c.id === hFallbackCard);
check("#119: the fallback card waits on the second key before the delete",
  !!card && card.step.holder === "agent" && card.step.keyId === hKey2Id && card.step.waiting === true,
  "step " + JSON.stringify(card && card.step));
res = await a.call("DELETE", "/api/v1/me/token/" + hKey2Id);
stA = await state(a);
card = (stA.cards || []).find((c) => c.id === hFallbackCard);
const handedCardAfter = (stA.cards || []).find((c) => c.id === hCreatedHanded);
check("#119: deleting a key returns its cards to the person, not waiting",
  res.status === 200 && !!card && card.step.holder === "owner" && card.step.keyId === null &&
    card.step.waiting === false && !!handedCardAfter && handedCardAfter.step.holder === "owner",
  "step " + JSON.stringify(card && card.step));
res = await a.agentCall("GET", "/api/v1/queue", hKey2);
check("#119: the deleted key's queue is closed with the key",
  res.status === 401, "status " + res.status);
res = await a.call("DELETE", "/api/v1/me/token/" + hKey1Id);
check("#119: the drill's handover keys clean up", res.status === 200, "status " + res.status);

// --- Names resolve live (issue #121) -------------------------------------------------
// One rule for every name on the work (Derick): a card's
// maker, its step's holder and its last hander record WHO —
// a key's id, or the person — and the name reads from that
// record as the card is read, never from a copy stored on
// the card. Rename the key or the person and the names
// follow at once; revoke the key and its names still
// resolve from its standing row. (Comment authors carry the
// same rule from issue #120; this section proves it for the
// creator stamp and the step.) The person's display name
// stands as "Drill Person A" from the sections above.
res = await a.call("POST", "/api/v1/me/token", { name: "Names One" });
const nKey1 = res.json.key; const nKey1Id = res.json.id;
res = await a.call("POST", "/api/v1/me/token", { name: "Names Two" });
const nKey2 = res.json.key; const nKey2Id = res.json.id;
check("#121: two keys stand for the name checks", !!nKey1 && !!nKey2, "keys minted");

res = await agentPost("/api/v1/cards", nKey1, { board_id: personal.id, column_id: "inbox", title: "Names key card" });
const nKeyCard = res.json.card.id;
check("#121: a key-made card names its maker, and holds its maker's step under the same name",
  res.status === 201 && res.json.card.creatorKeyName === "Names One" &&
    res.json.card.step.holder === "agent" && res.json.card.step.keyName === "Names One",
  "card " + JSON.stringify(res.json.card && { creator: res.json.card.creatorKeyName, step: res.json.card.step }));
check("#123: the maker's key id and the step's key id read as the same id on its own card",
  res.status === 201 && res.json.card.creatorKeyId === nKey1Id &&
    res.json.card.step.keyId === nKey1Id,
  "creator id " + (res.json.card && res.json.card.creatorKeyId) + " step id " +
    (res.json.card && res.json.card.step && res.json.card.step.keyId) + " vs key " + nKey1Id);

res = await a.call("POST", "/api/v1/cards", { board_id: personal.id, column_id: "inbox", title: "Names person card" });
const nPersonCard = res.json.card.id;
res = await a.call("PATCH", "/api/v1/cards/" + nPersonCard, { next_step: nKey1Id });
check("#121: a step the person hands over names the person as its hander",
  res.status === 200 && res.json.card.step.handedByKeyName === null &&
    res.json.card.step.handedByName === "Drill Person A",
  "step " + JSON.stringify(res.json.card && res.json.card.step));
res = await keyCall("PATCH", "/api/v1/cards/" + nPersonCard, nKey1, { next_step: nKey2Id });
check("#121: a step a key hands over names the key as its hander, both fields",
  res.status === 200 && res.json.card.step.holder === "agent" && res.json.card.step.keyId === nKey2Id &&
    res.json.card.step.keyName === "Names Two" &&
    res.json.card.step.handedByKeyName === "Names One" && res.json.card.step.handedByName === "Names One",
  "step " + JSON.stringify(res.json.card && res.json.card.step));

// The renames: the key first, then the person. Every
// standing name follows at once.
res = await a.call("PATCH", "/api/v1/me/token/" + nKey1Id, { name: "Names One Renamed" });
check("#121: the first key renames", res.status === 200, "status " + res.status);
stA = await state(a);
const nKeyCardAfter = (stA.cards || []).find((c) => c.id === nKeyCard);
const nPersonAfter = (stA.cards || []).find((c) => c.id === nPersonCard);
check("#121: the rename renames the maker name and the holder name on the key's card",
  !!nKeyCardAfter && nKeyCardAfter.creatorKeyName === "Names One Renamed" &&
    nKeyCardAfter.step.keyName === "Names One Renamed",
  JSON.stringify(nKeyCardAfter && { creator: nKeyCardAfter.creatorKeyName, step: nKeyCardAfter.step }));
check("#123: the maker's key id stands unchanged through the rename — names move, ids do not",
  !!nKeyCardAfter && nKeyCardAfter.creatorKeyId === nKey1Id &&
    nKeyCardAfter.step.keyId === nKey1Id,
  JSON.stringify(nKeyCardAfter && { creatorId: nKeyCardAfter.creatorKeyId, stepId: nKeyCardAfter.step.keyId }));
check("#121: the rename renames the hander name the key left on another card",
  !!nPersonAfter && nPersonAfter.step.handedByKeyName === "Names One Renamed" &&
    nPersonAfter.step.handedByName === "Names One Renamed",
  JSON.stringify(nPersonAfter && nPersonAfter.step));
res = await a.call("PATCH", "/api/v1/me", { name: "Drill Person A Renamed" });
check("#121: the person renames", res.status === 200, "status " + res.status);
res = await a.call("POST", "/api/v1/cards", { board_id: personal.id, column_id: "inbox", title: "Names handed card" });
const nHandedCard = res.json.card.id;
res = await a.call("PATCH", "/api/v1/cards/" + nHandedCard, { next_step: nKey2Id });
check("#121: a hand-over by the renamed person names them by their new name",
  res.status === 200 && res.json.card.step.handedByName === "Drill Person A Renamed" &&
    res.json.card.step.handedByKeyName === null,
  "step " + JSON.stringify(res.json.card && res.json.card.step));
res = await a.call("PATCH", "/api/v1/me", { name: "Drill Person A" });
check("#121: the person's name is put back", res.status === 200, "status " + res.status);
stA = await state(a);
const nHandedAfter = (stA.cards || []).find((c) => c.id === nHandedCard);
check("#121: the name put back renames the hander on the standing card too — it was never stored",
  !!nHandedAfter && nHandedAfter.step.handedByName === "Drill Person A",
  JSON.stringify(nHandedAfter && nHandedAfter.step));

// The revoke: the row stands, so every name the key left
// still resolves. The cards it held come back to the person
// (issue #119), but its maker tags and hander names read on.
res = await a.call("DELETE", "/api/v1/me/token/" + nKey1Id);
check("#121: the first key is deleted (revoked — its row stands)", res.status === 200, "status " + res.status);
stA = await state(a);
const nKeyCardRevoked = (stA.cards || []).find((c) => c.id === nKeyCard);
const nPersonRevoked = (stA.cards || []).find((c) => c.id === nPersonCard);
check("#121: a deleted key's maker name and hander name still resolve from its row",
  !!nKeyCardRevoked && nKeyCardRevoked.creatorKeyName === "Names One Renamed" &&
    nKeyCardRevoked.creatorKeyId === nKey1Id &&
    nKeyCardRevoked.step.holder === "owner" &&
    !!nPersonRevoked && nPersonRevoked.step.handedByKeyName === "Names One Renamed" &&
    nPersonRevoked.step.handedByName === "Names One Renamed",
  JSON.stringify({ maker: nKeyCardRevoked && nKeyCardRevoked.creatorKeyName, hander: nPersonRevoked && nPersonRevoked.step.handedByName }));
res = await a.call("DELETE", "/api/v1/me/token/" + nKey2Id);
check("#121: the name checks' keys clean up", res.status === 200, "status " + res.status);

// Issue #131's consequence for this drill: the renames in
// the sections above were real sign-in renames, so the
// drill name is restored through the same Account door
// here — the families below sign A in by it and read it on
// the sign-in page's pick list.
res = await a.call("PATCH", "/api/v1/me", { name: NAME_A });
check("#131: A's name is the drill name again for the families below",
  res.status === 200 && res.json.name === NAME_A,
  "status " + res.status + " body " + (res.text || "").slice(0, 120));

// --- Moving a card to another board (issue #163) ------------------------------
// One card edit names the new board, the column on it and the
// project on it, and the move lands as one act with one version
// rise. Labels cross by name — the destination board's own label
// is worn there — and a label with no match is left behind.
// Everything else travels: steps, links, comments, the due date,
// the archived state and whose step is next. A key can make the
// move too. The destination's card cap and another person's
// board both refuse the move whole, before anything is written.
{
  res = await a.call("POST", "/api/v1/boards", { name: "Move Source 163" });
  const mvSrc = res.json && res.json.board;
  res = await a.call("POST", "/api/v1/boards", { name: "Move Dest 163" });
  const mvDst = res.json && res.json.board;
  check("#163: two boards stand for the move checks", !!mvSrc && !!mvDst,
    "boards " + (mvSrc && mvSrc.id) + " / " + (mvDst && mvDst.id));
  res = await a.call("POST", "/api/v1/columns", { board_id: mvDst.id, name: "In Progress", kind: "in-progress-163" });
  check("#163: the destination's own column stands", res.status === 201, "status " + res.status);
  const mkLabel = async (boardId, name, colour) =>
    (await a.call("POST", "/api/v1/labels", { board_id: boardId, name, colour })).json.label;
  const srcCross = await mkLabel(mvSrc.id, "Crossing 163", "red");
  const srcOnly = await mkLabel(mvSrc.id, "Source Only 163", "green");
  const dstCross = await mkLabel(mvDst.id, "Crossing 163", "blue");
  const mkProject = async (boardId, name) =>
    (await a.call("POST", "/api/v1/projects", { board_id: boardId, name })).json.project;
  const srcProject = await mkProject(mvSrc.id, "Shared Project 163");
  const dstProject = await mkProject(mvDst.id, "Shared Project 163");
  const dstOwnProject = await mkProject(mvDst.id, "Dest Project 163");
  check("#163: the labels and projects stand on both boards",
    !!srcCross && !!srcOnly && !!dstCross && !!srcProject && !!dstProject && !!dstOwnProject, "fixtures made");

  res = await a.call("POST", "/api/v1/me/token", { name: "Move Key 163" });
  const mvKey = res.json && res.json.key; const mvKeyId = res.json && res.json.id;
  check("#163: a key stands for the move", res.status === 201 && !!mvKey, "status " + res.status);

  res = await a.call("POST", "/api/v1/cards", {
    board_id: mvDst.id, column_id: "in-progress-163", title: "Already Here 163",
  });
  const mvThere = res.json.card;
  res = await a.call("POST", "/api/v1/cards", {
    board_id: mvSrc.id, column_id: "doing", title: "Move Me 163",
    notes: "Notes that travel", due_date: "2026-12-24",
    labels: [srcCross.id, srcOnly.id], project_id: srcProject.id,
  });
  const mvCard = res.json.card;
  check("#163: the card to move stands on the source board",
    res.status === 201 && !!mvCard && mvCard.boardId === mvSrc.id && mvCard.columnId === "doing",
    "status " + res.status);
  await a.call("POST", "/api/v1/cards/" + mvCard.id + "/steps", { text: "First travel step" });
  await a.call("POST", "/api/v1/cards/" + mvCard.id + "/steps", { text: "Second travel step", done: true });
  await a.call("POST", "/api/v1/cards/" + mvCard.id + "/links", { url: "example.com/move-163", name: "Travel link" });
  await a.call("POST", "/api/v1/cards/" + mvCard.id + "/comments", { body: "A comment that travels" });
  res = await a.call("PATCH", "/api/v1/cards/" + mvCard.id, { next_step: mvKeyId });
  check("#163: the card's next step is handed to the key before the move",
    res.status === 200 && res.json.card && res.json.card.step.holder === "agent" &&
      res.json.card.step.keyId === mvKeyId,
    "status " + res.status + " step " + JSON.stringify(res.json.card && res.json.card.step));

  const stBeforeMove = await state(a);
  // The key makes the move: board, column and project in one edit.
  res = await keyCall("PATCH", "/api/v1/cards/" + mvCard.id, mvKey, {
    board_id: mvDst.id, column_id: "in-progress-163", project_id: dstOwnProject.id,
  });
  check("#163: a key's move answers 200 with the card on the new board",
    res.status === 200 && res.json.card && res.json.card.boardId === mvDst.id &&
      res.json.card.columnId === "in-progress-163" && res.json.card.projectId === dstOwnProject.id,
    "status " + res.status + " body " + (res.text || "").slice(0, 160));
  check("#163: the move is one act — the version rises by exactly one",
    !!res.json && res.json.version === stBeforeMove.version + 1,
    "before " + stBeforeMove.version + " answer " + (res.json && res.json.version));
  const stAfterMove = await state(a);
  const moved = stAfterMove.cards.find((c) => c.id === mvCard.id);
  check("#163: the card stands on the destination board in the state",
    !!moved && moved.boardId === mvDst.id && moved.columnId === "in-progress-163",
    "board " + (moved && moved.boardId) + " column " + (moved && moved.columnId));
  check("#163: the matching label crossed as the destination board's own label, and the unmatched one stayed behind",
    !!moved && JSON.stringify(moved.labels) === JSON.stringify([dstCross.id]),
    "labels " + JSON.stringify(moved && moved.labels) + " wanted [" + dstCross.id + "]");
  check("#163: steps, links, comments, notes and the due date travelled",
    !!moved && moved.notes === "Notes that travel" && moved.due === "2026-12-24" &&
      moved.steps.length === 2 && moved.steps[0].text === "First travel step" && moved.steps[1].done === true &&
      moved.links.length === 1 && /move-163/.test(moved.links[0].url) &&
      moved.comments.length === 1 && moved.comments[0].body === "A comment that travels",
    "steps " + (moved && moved.steps.length) + " links " + (moved && moved.links.length) +
      " comments " + (moved && moved.comments.length));
  check("#163: the next step's holder travelled — the key still holds it",
    !!moved && moved.step.holder === "agent" && moved.step.keyId === mvKeyId,
    "step " + JSON.stringify(moved && moved.step));
  const thereNow = stAfterMove.cards.find((c) => c.id === mvThere.id);
  check("#163: the moved card lands at the end of its new column",
    !!moved && !!thereNow && moved.position > thereNow.position,
    "positions moved " + (moved && moved.position) + " standing " + (thereNow && thereNow.position));
  // The change watch reads moves from exactly this: one version
  // rise, and the same card standing at both ends of the diff,
  // its boards and columns named by each snapshot.
  const nameEnds = (st) => {
    const c = st.cards.find((x) => x.id === mvCard.id);
    const b = st.boards.find((x) => x.id === c.boardId);
    const col = b.columns.find((x) => x.kind === c.columnId);
    return b.name + " / " + col.name;
  };
  check("#163: the one-version diff names the board and column left and joined",
    nameEnds(stBeforeMove) === "Move Source 163 / Doing" &&
      nameEnds(stAfterMove) === "Move Dest 163 / In Progress",
    nameEnds(stBeforeMove) + " -> " + nameEnds(stAfterMove));
  res = await a.agentCall("GET", "/api/v1/directions", mvKey);
  check("#163: the directions describe the move in the product's words",
    res.status === 200 && /board_id moves the card to another board/.test(res.text || "") &&
      /Labels cross by name/.test(res.text || ""),
    "status " + res.status);

  // A move naming only the board: the project follows by name
  // and the labels cross by name, the way the dialog's defaults go.
  res = await a.call("POST", "/api/v1/cards", {
    board_id: mvSrc.id, column_id: "doing", title: "Move Me Too 163",
    labels: [srcCross.id, srcOnly.id], project_id: srcProject.id,
  });
  const mvCard2 = res.json.card;
  res = await a.call("PATCH", "/api/v1/cards/" + mvCard2.id, { board_id: mvDst.id });
  const stSecond = await state(a);
  const moved2 = stSecond.cards.find((c) => c.id === mvCard2.id);
  check("#163: a board-only move takes the same-name project and crosses labels by name",
    res.status === 200 && !!moved2 && moved2.boardId === mvDst.id &&
      moved2.projectId === dstProject.id &&
      JSON.stringify(moved2.labels) === JSON.stringify([dstCross.id]),
    "status " + res.status + " project " + (moved2 && moved2.projectId) +
      " labels " + JSON.stringify(moved2 && moved2.labels));

  // The archived state travels as it stands.
  res = await a.call("POST", "/api/v1/cards", { board_id: mvSrc.id, column_id: "inbox", title: "Move Archived 163" });
  const mvArch = res.json.card;
  await a.call("PATCH", "/api/v1/cards/" + mvArch.id, { archived: true });
  res = await a.call("PATCH", "/api/v1/cards/" + mvArch.id, { board_id: mvDst.id, column_id: "done" });
  const stThird = await state(a);
  const movedArch = stThird.cards.find((c) => c.id === mvArch.id);
  check("#163: an archived card moves boards and stays archived",
    res.status === 200 && !!movedArch && movedArch.boardId === mvDst.id &&
      movedArch.columnId === "done" && movedArch.archived === true,
    "status " + res.status + " archived " + (movedArch && movedArch.archived));

  // Another person's board refuses the move whole.
  const stB163 = await state(b);
  const foreignBoard = stB163.boards[0];
  res = await a.call("POST", "/api/v1/cards", { board_id: mvSrc.id, column_id: "inbox", title: "Move Refused 163" });
  const mvStay = res.json.card;
  const stBeforeRefusal = await state(a);
  res = await a.call("PATCH", "/api/v1/cards/" + mvStay.id, { board_id: foreignBoard.id });
  const stAfterRefusal = await state(a);
  const stayed = stAfterRefusal.cards.find((c) => c.id === mvStay.id);
  check("#163: a move to a board the caller does not own is refused, and nothing changes",
    res.status === 400 && /does not belong to this caller/.test(res.json.error || "") &&
      !!stayed && stayed.boardId === mvSrc.id && stAfterRefusal.version === stBeforeRefusal.version,
    "status " + res.status + " error " + (res.json.error || ""));

  // The cap: a destination board already holding its card cap
  // refuses the move, with the plain reason, and nothing lands.
  // The drill fills the board at the database the instance runs
  // on — the self-host file, or the Worker rig's local database
  // found from the mint's folder — because making 2,000 cards
  // through the API would swamp the drill.
  res = await a.call("POST", "/api/v1/boards", { name: "Move Full 163" });
  const mvFull = res.json.board;
  const fullInbox = mvFull.columns.find((c) => c.kind === "inbox");
  let capDbFile = null;
  let capFindError = "";
  if (MODE === "selfhost" && args["server-config"]) {
    const cfgF = JSON.parse(readFileSync(args["server-config"], "utf8"));
    capDbFile = join(dirname(args["server-config"]), String(cfgF.dataDir || "data"), "tasksparkle.sqlite");
  } else if (MODE === "worker" && args.mint) {
    try {
      const mintAbs = args.mint.startsWith("/") ? args.mint : join(process.cwd(), args.mint);
      const d1Dir = join(dirname(dirname(dirname(mintAbs))), ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
      for (const name of readdirSync(d1Dir)) {
        if (!name.endsWith(".sqlite")) continue;
        const candidate = join(d1Dir, name);
        try {
          const ro = new DatabaseSync(candidate, { readOnly: true });
          const hit = ro.prepare("SELECT id FROM boards WHERE id = ?").get(mvFull.id);
          ro.close();
          if (hit) { capDbFile = candidate; break; }
        } catch (e) { /* a database that is not the boards one */ }
      }
      if (!capDbFile) capFindError = "no rig database holds the cap board";
    } catch (e) { capFindError = String((e && e.message) || e); }
  }
  let seeded = false;
  if (capDbFile && fullInbox) {
    try {
      const rw = new DatabaseSync(capDbFile);
      rw.exec("PRAGMA busy_timeout = 10000");
      const ins = rw.prepare("INSERT INTO cards (id, board_id, column_id, title, notes, position) VALUES (?, ?, ?, ?, '', ?)");
      rw.exec("BEGIN");
      for (let i = 0; i < 2000; i++) ins.run("card_cap163_" + i, mvFull.id, fullInbox.id, "Cap filler " + i, i);
      rw.exec("COMMIT");
      rw.close();
      seeded = true;
    } catch (e) { capFindError = String((e && e.message) || e); }
  }
  check("#163: the cap board stands filled to the cap for the refusal check",
    seeded, capFindError || "no database found");
  const stBeforeCap = await state(a);
  res = await a.call("PATCH", "/api/v1/cards/" + mvStay.id, { board_id: mvFull.id, column_id: "inbox" });
  const stAfterCap = await state(a);
  const stayedCap = stAfterCap.cards.find((c) => c.id === mvStay.id);
  check("#163: a move into a full board is refused with the plain reason, and nothing changes",
    res.status === 400 && (res.json.error || "") === "That is as many cards as one board holds." &&
      !!stayedCap && stayedCap.boardId === mvSrc.id && stAfterCap.version === stBeforeCap.version,
    "status " + res.status + " error " + (res.json.error || ""));
  res = await a.call("DELETE", "/api/v1/boards/" + mvFull.id);
  check("#163: the cap board is deleted again", res.status === 200, "status " + res.status);
  res = await a.call("DELETE", "/api/v1/me/token/" + mvKeyId);
  check("#163: the move key cleans up", res.status === 200, "status " + res.status);
}

// --- The push route's refusals -----------------------------------------------------
res = await a.call("GET", "/api/v1/push");
check("push: a plain GET is refused 400", res.status === 400, "status " + res.status);
if (MODE === "worker") {
  // The rig binds no push object, so an upgrade is answered 501,
  // the unconfigured answer. The self-host hub is exercised by
  // tests/ui-drill.mjs and the websocket check below instead.
  res = await raw(BASE, "GET", "/api/v1/push", {
    ...a.headers, Upgrade: "websocket", Connection: "Upgrade",
    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13",
  });
  check("push: an upgrade on an unconfigured deployment is 501", res.status === 501, "status " + res.status);
}

// --- Self-host hardening (issues #55, #62, #67, #68, #89, #107) --------------------
// Self-host mode only, and last on purpose: the throttle family
// at the end locks the drill's own address out of /login for a
// few seconds, so nothing after it may need the login page.
// Pass --server-config <path> and the drill also mints invites
// against the instance (the invite family) and reads the config
// and the data file back: no password rests in the config at
// all, and each person's password rests in the data file only
// as a salted hash.
if (MODE === "selfhost") {
  const anon = await raw(BASE, "GET", "/login", {});
  // The sign-in page lists the accounts that stand — the names
  // people made for themselves, offered as a pick list (issue
  // #107). That is the family's own list, shown on purpose; what
  // the page still never carries is an email field or the word.
  check("#107: the sign-in page lists the accounts' names to pick from, and no email field or word",
    anon.status === 200 && anon.text.includes(NAME_A) && anon.text.includes(NAME_B) &&
      /type="radio"/.test(anon.text) && /name="password"/.test(anon.text) &&
      !/name="email"/.test(anon.text) && !/email/i.test(anon.text),
    "status " + anon.status);
  check("#89: the sign-in page takes a pasted invite code",
    anon.status === 200 && /name="code"/.test(anon.text) && /invite/.test(anon.text),
    "status " + anon.status);

  const serverConfigPath = args["server-config"] || null;
  let cfg = null;
  if (serverConfigPath) {
    try { cfg = JSON.parse(readFileSync(serverConfigPath, "utf8")); } catch (e) { /* named below */ }
  }
  check("#89: the config rests no password in any field",
    !!cfg && !("householdPassword" in cfg) && !("householdPasswordHash" in cfg),
    cfg ? "fields: " + Object.keys(cfg).join(", ") : "no --server-config given");
  const dataFile = cfg
    ? join(dirname(serverConfigPath), String(cfg.dataDir || "data"), "tasksparkle.sqlite")
    : null;
  let pwRow = null;
  if (dataFile) {
    try {
      const ro = new DatabaseSync(dataFile, { readOnly: true });
      pwRow = ro.prepare("SELECT password_hash AS hash FROM accounts WHERE key = ?").get(B);
      ro.close();
    } catch (e) { /* named below */ }
  }
  check("#109: a person's password rests in the data file only as the PHC scrypt hash",
    !!pwRow && typeof pwRow.hash === "string" && pwRow.hash.startsWith("$scrypt$ln=15,r=8,p=3$") &&
      !pwRow.hash.includes(PASSWORD_B),
    pwRow ? "stored: " + String(pwRow.hash).split("$").slice(0, 2).join("$") + "$…" : "no row read");

  // The body cap answers before authentication and does not
  // buffer the flood: an unauthenticated POST past the cap is a
  // 413, and the server answers the next request as usual.
  const flood = await raw(BASE, "POST", "/api/v1/state",
    { "Content-Type": "application/json" }, Buffer.alloc(1500000, 0x61));
  check("#67: a body past the cap is refused 413 before any auth",
    flood.status === 413, "status " + flood.status);
  const alive = await raw(BASE, "GET", "/login", {});
  check("#67: the server answers as usual after the flood",
    alive.status === 200, "status " + alive.status);

  // The push hub: a ping is answered, an oversized declared
  // frame closes the socket, and an unmasked client frame
  // closes it too (RFC 6455 makes masking the client's duty).
  const cookie = callers[A].headers.Cookie;
  const wsFrame = (opcode, payload, masked = true, declared = null) => {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ""));
    const length = declared != null ? declared : body.length;
    const bit = masked ? 0x80 : 0;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, bit | length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = bit | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = bit | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    if (!masked) return Buffer.concat([header, body]);
    const mask = randomBytes(4);
    const maskedBody = Buffer.from(body);
    for (let i = 0; i < maskedBody.length; i++) maskedBody[i] ^= mask[i % 4];
    return Buffer.concat([header, mask, maskedBody]);
  };
  const wsProbe = (frames, waitMs) => new Promise((resolve) => {
    const url = new URL(BASE);
    const socket = netConnect(Number(url.port), url.hostname);
    let buf = Buffer.alloc(0);
    let handshaken = false;
    let pong = false;
    let closed = false;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (e) { /* already gone */ }
      resolve({ handshaken, pong, closed });
    };
    const timer = setTimeout(settle, waitMs);
    socket.on("connect", () => {
      socket.write(
        "GET /api/v1/push HTTP/1.1\r\nHost: " + url.host +
        "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " +
        randomBytes(16).toString("base64") +
        "\r\nSec-WebSocket-Version: 13\r\nCookie: " + cookie + "\r\n\r\n");
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        handshaken = /^HTTP\/1\.1 101/.test(buf.slice(0, idx).toString("latin1"));
        buf = buf.slice(idx + 4);
        if (!handshaken) { clearTimeout(timer); settle(); return; }
        for (const f of frames) socket.write(f);
      }
      // A pong's first byte is 0x8A; the version pushes are
      // ASCII digits and never carry that byte.
      if (buf.includes(0x8a)) pong = true;
    });
    socket.on("close", () => { closed = true; clearTimeout(timer); settle(); });
    socket.on("error", () => { closed = true; clearTimeout(timer); settle(); });
  });

  const ping = await wsProbe([wsFrame(0x9, "")], 1500);
  check("#68: a masked ping is answered with a pong and the socket stays open",
    ping.handshaken && ping.pong && !ping.closed, JSON.stringify(ping));
  const huge = await wsProbe([wsFrame(0x1, Buffer.alloc(16), true, 2 ** 40)], 2500);
  check("#68: a frame declaring a giant payload closes the socket",
    huge.handshaken && huge.closed, JSON.stringify(huge));
  const bare = await wsProbe([wsFrame(0x1, "x", false)], 2500);
  check("#68: an unmasked client frame closes the socket",
    bare.handshaken && bare.closed, JSON.stringify(bare));

  // --- Invites and per-person passwords (issue #89) ------------------------------
  // Person B is the subject throughout: a fresh invite is minted
  // against the running instance, looked at twice (a chat app's
  // preview must not spend it), refused twice on password
  // mistakes with the invite surviving, redeemed through the
  // pasted-code entry, and dead afterwards. Expiry is proven by
  // aging a second invite in the data file. The family ends by
  // deleting B's password row outright — no password signs B in
  // then — and restoring it through a fresh invite, so the
  // instance is left exactly as the harness set it up and the
  // throttle family below starts from a clean failure record
  // (the restoring sign-in clears it, as any success does).
  const formPost = (path, fields) => raw(BASE, "POST", path,
    { "Content-Type": "application/x-www-form-urlencoded" },
    new URLSearchParams(fields).toString());
  const setsCookie89 = (r) =>
    (r.headers["set-cookie"] || []).some((c) => c.startsWith("ts_session="));
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "server.mjs");
  const mintFor = (name) => {
    const out = execFileSync(process.execPath,
      [serverPath, "--config", serverConfigPath, "--invite", name], { encoding: "utf8" });
    const m = out.match(/\/invite\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  };
  if (serverConfigPath) {
    const PW_B2 = "drill-b-reset-password";
    const code1 = mintFor(NAME_B);
    check("#89: an invite mints against the running instance", !!code1, code1 || "no code");
    let page = await raw(BASE, "GET", "/invite/" + code1, {});
    // B's account stands, so this invite is a reset: the page
    // names the account and holds the name fixed (issue #107).
    check("#107: the reset invite's page names the account and holds its name fixed",
      page.status === 200 && page.text.includes(NAME_B) &&
        !/name="name"/.test(page.text) && /name="password"/.test(page.text) &&
        !/email/i.test(page.text),
      "status " + page.status);
    page = await raw(BASE, "GET", "/invite/" + code1, {});
    check("#89: a second look (the chat preview) leaves the invite alive",
      page.status === 200 && /name="password"/.test(page.text), "status " + page.status);
    let r = await formPost("/invite/" + code1, { password: "short", confirm: "short" });
    check("#89: a password under the floor is refused, no cookie, invite survives — " +
        "with the refusal naming the length (issue #147)",
      r.status === 302 && !setsCookie89(r) &&
        (r.headers.location || "").includes("error=pwlength"),
      "status " + r.status + " location " + r.headers.location);
    r = await formPost("/invite/" + code1,
      { password: PW_B2, confirm: "drill-b-other-password" });
    check("#89: mismatched passwords are refused with the mismatch named (issue #147)",
      r.status === 302 && !setsCookie89(r) &&
        (r.headers.location || "").includes("error=pwmismatch"),
      "status " + r.status + " location " + r.headers.location);
    r = await formPost("/invite-code", { code: code1 });
    check("#89: the pasted-code entry leads to the same redemption page",
      r.status === 302 && (r.headers.location || "") === "/invite/" + code1,
      "status " + r.status + " location " + r.headers.location);
    r = await formPost("/invite/" + code1, { password: PW_B2, confirm: PW_B2 });
    check("#89: the press sets B's new password and lands B signed in",
      r.status === 302 && setsCookie89(r) && (r.headers.location || "") === "/",
      "status " + r.status + " location " + r.headers.location);
    const cookieB2 = (r.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
    const stB2 = await raw(BASE, "GET", "/api/v1/state", { Cookie: cookieB2 });
    // B's own state, boards and all — the board family above
    // leaves B with exactly one board (the keep-one rule), so
    // one board is the right expectation here, not the seeded two.
    check("#89: the redemption session reads B's own state",
      stB2.status === 200 && stB2.json && stB2.json.me && stB2.json.me.email === B &&
        Array.isArray(stB2.json.boards) && stB2.json.boards.length >= 1,
      "status " + stB2.status + ", boards " +
        (stB2.json && stB2.json.boards ? stB2.json.boards.length : "none"));
    page = await raw(BASE, "GET", "/invite/" + code1, {});
    check("#89: a spent invite shows the plain refusal",
      page.status === 200 && !/name="password"/.test(page.text), "status " + page.status);
    r = await formPost("/invite/" + code1, { password: PW_B2, confirm: PW_B2 });
    check("#89: a spent invite cannot be redeemed again",
      r.status === 302 && !setsCookie89(r), "status " + r.status);
    page = await raw(BASE, "GET", "/invite/definitely-not-a-code", {});
    check("#89: an unknown code gets the same refusal, saying neither which nor why",
      page.status === 200 && !/name="password"/.test(page.text), "status " + page.status);

    const code2 = mintFor(NAME_B);
    const rw = new DatabaseSync(dataFile);
    rw.prepare("UPDATE invites SET expires = ? WHERE code_hash IS NOT NULL AND used_at IS NULL")
      .run(Date.now() - 1000);
    rw.close();
    page = await raw(BASE, "GET", "/invite/" + code2, {});
    check("#89: an expired invite shows the refusal",
      page.status === 200 && !/name="password"/.test(page.text), "status " + page.status);
    r = await formPost("/login", { name: NAME_B, password: PW_B2 });
    check("#89: the expired reset changed nothing — B's password still signs in",
      r.status === 302 && setsCookie89(r), "status " + r.status);

    r = await formPost("/login", { name: NAME_B, password: PASSWORD_A });
    check("#89: person A's password does not sign in person B",
      r.status === 302 && !setsCookie89(r) &&
        (r.headers.location || "").includes("error=1"),
      "status " + r.status + " location " + r.headers.location);
    // (The #89 family once nulled B's hash here to prove no
    // password signs in. Under passkey-first a NULL hash is a
    // passkey-only account, whose invite is a recovery spent
    // by ceremony — the #122 family proves that story whole,
    // and the refusal itself on its dropped account. This
    // family's restore below is the ordinary reset.)
    const code3 = mintFor(NAME_B);
    r = await formPost("/invite/" + code3, { password: PASSWORD_B, confirm: PASSWORD_B });
    check("#89: a fresh invite restores B's password (the reset story)",
      r.status === 302 && setsCookie89(r), "status " + r.status);
    r = await formPost("/login", { name: NAME_B, password: PASSWORD_B });
    check("#89: B signs in with the restored password",
      r.status === 302 && setsCookie89(r), "status " + r.status);
  }

  // The throttle: five wrong passwords are plain refusals, the
  // lock then refuses even the right password, and once the
  // lock's window passes the right password signs in again.
  const tryLogin = (password) => raw(BASE, "POST", "/login",
    { "Content-Type": "application/x-www-form-urlencoded" },
    new URLSearchParams({ name: NAME_A, password }).toString());
  const setsCookie = (r) => (r.headers["set-cookie"] || []).some((c) => c.startsWith("ts_session="));
  let wrong = await tryLogin("not the password");
  check("#62: a wrong password is refused, no cookie",
    wrong.status === 302 && !setsCookie(wrong) &&
      (wrong.headers.location || "").includes("error=1"),
    "status " + wrong.status + " location " + wrong.headers.location);
  for (let i = 0; i < 4; i++) wrong = await tryLogin("not the password");
  const locked = await tryLogin(PASSWORD_A);
  check("#62: after five failures even the right password waits",
    locked.status === 302 && !setsCookie(locked) &&
      (locked.headers.location || "").includes("error=locked"),
    "status " + locked.status + " location " + locked.headers.location);
  await new Promise((r) => setTimeout(r, 11000));
  const after = await tryLogin(PASSWORD_A);
  check("#62: the right password signs in once the window passes",
    after.status === 302 && setsCookie(after) &&
      (after.headers.location || "") === "/",
    "status " + after.status + " location " + after.headers.location);
}

// --- The agent door takes keys only (worker mode) ----------------------------------
if (MODE === "worker") {
  const aToken = execFileSync(process.execPath, [MINT, A, "Drill A"], { encoding: "utf8" }).trim();
  res = await raw(AGENT_BASE, "GET", "/api/v1/state", { "Cf-Access-Jwt-Assertion": aToken });
  check("doors: a person token does not open the agent door",
    res.status === 401 && /agent key is required/.test(res.json.error || ""), "status " + res.status);
  res = await raw(AGENT_BASE, "GET", "/api/v1/state", { Cookie: callers[A].headers.Cookie });
  check("doors: a session cookie does not open the agent door either",
    res.status === 401 && /agent key is required/.test(res.json.error || ""), "status " + res.status);

  // --- The stale-session expiry (issue #49) --------------------------------------
  const wrongiss = execFileSync(process.execPath, [MINT, A, "Drill A", "wrongiss"], { encoding: "utf8" }).trim();
  res = await raw(BASE, "GET", "/api/v1/state", {
    "Cf-Access-Jwt-Assertion": wrongiss, Cookie: "CF_Authorization=stale",
  });
  const sc = (res.headers["set-cookie"] || []).join(" ");
  check("#49: a refused session's 401 expires the cookie",
    res.status === 401 && /CF_Authorization=;/.test(sc) && /Expires=Thu, 01 Jan 1970/.test(sc),
    "status " + res.status + " set-cookie: " + sc);
  res = await raw(BASE, "GET", "/api/v1/state", {
    Cookie: (a.headers.Cookie || "") + "; CF_Authorization=stale",
  });
  check("#49: a valid session never sees the expiry",
    res.status === 200 && !res.headers["set-cookie"], "status " + res.status);
  res = await raw(AGENT_BASE, "GET", "/api/v1/state", {
    Authorization: "Bearer tsk_live_nope", Cookie: "CF_Authorization=stale",
  });
  check("#49: the key door sends no expiry",
    res.status === 401 && !res.headers["set-cookie"], "status " + res.status);
}

// --- Write cost (issue #71) -------------------------------------------------------
// A write used to build the owner's whole state twice — once
// before its route ran and once after — just to learn whether
// anything changed. The gate now reads a digest of the stored
// rows instead, so a write's cost no longer grows with two full
// readings of the boards. This section builds a wide board,
// times a run of small writes on it and prints the average. The
// fix's proof is the matched pair measured when it landed
// (2026-10-28, on the test rig, before and after runs
// back to back under the same load): the Worker rig averaged
// 149.6 ms per write before and 73.0 ms after, the self-host
// instance 15.5 ms before and 5.8 ms after, and an in-process
// run against the same board shape read 14.7 ms before and
// 4.2 ms after. The rig is shared and its absolute numbers
// wander with the neighbours — later runs the same night read
// 108.3, 126.0 and 187.2 ms as another lane's load rose — so
// no absolute ceiling can both leave the fixed code alone and
// catch a quiet-day regression. The ceiling below is a
// blow-up guard only: it trips when a write's cost leaves the
// observed range altogether, as it would if the cost went
// back to growing with the boards several times over. The
// printed number shows drift on later runs; judge a suspected
// regression by a matched before-and-after pair, the way the
// fix itself was proved. The board is left standing: the
// drill's owners and their boards are throwaway and die with
// the rig.
{
  const WRITE_CEILING_MS = 300;
  const wb = await a.call("POST", "/api/v1/boards", { name: "Write cost" });
  const wbId = wb.json.board.id;
  const cardIds = [];
  for (let i = 0; i < 60; i++) {
    const c = await a.call("POST", "/api/v1/cards",
      { board_id: wbId, column_id: "inbox", title: "Cost card " + i, notes: "x".repeat(200) });
    const cid = c.json.card.id;
    cardIds.push(cid);
    for (let s = 0; s < 3; s++) {
      await a.call("POST", "/api/v1/cards/" + cid + "/steps", { text: "step " + s });
    }
    await a.call("POST", "/api/v1/cards/" + cid + "/links", { url: "example.com/" + i, name: "link " + i });
    await a.call("POST", "/api/v1/cards/" + cid + "/comments", { body: "comment " + i });
  }
  const WRITES = 25;
  const started = performance.now();
  for (let i = 0; i < WRITES; i++) {
    await a.call("PATCH", "/api/v1/cards/" + cardIds[i % cardIds.length],
      { title: "Cost card retitled " + i });
  }
  const perWrite = (performance.now() - started) / WRITES;
  check("#71: a write on a wide board stays under the cost ceiling",
    perWrite < WRITE_CEILING_MS,
    "avg " + perWrite.toFixed(1) + " ms per write over " + WRITES + " writes, ceiling " + WRITE_CEILING_MS + " ms");
}

// --- The new door itself (issue #109) ---------------------------------------------
// The sign-in family: passkeys, proofs, sessions, resets and
// the claim flow, driven end to end. The passkey ceremonies
// are worked by an in-drill software authenticator — a real
// P-256 key pair signing real challenges, with hostile
// variants (no user verification, no presence, a wrong origin,
// a wrong ceremony type, a wrong user handle, a replayed
// challenge) built by turning the same knobs a hostile client
// would. Where the drill can write the data file (self-host
// mode with --server-config) it also counts the defence rows
// and poisons a stored hash; on the Worker rig those two
// families ride on the HTTP shape alone.
{
  const ORIGIN = DRILL_ORIGIN;
  const RP_ID = DRILL_RP_ID;
  const b64u = b64uDrill;
  const b64uToBuf = b64uDrillToBuf;

  // A door caller on a raw cookie, with the jar behaviour of
  // callerFor: rotations are followed.
  function doorCaller(cookie) {
    const headers = { Cookie: cookie };
    return {
      headers,
      async call(method, path, body, extra) {
        const h = { ...headers, ...(extra || {}) };
        let payload = null;
        if (body != null) {
          h["Content-Type"] = "application/json";
          payload = typeof body === "string" ? body : JSON.stringify(body);
        }
        const res = await raw(BASE, method, path, h, payload);
        const rotated = sessionCookieOf(res);
        if (rotated) headers.Cookie = rotated;
        return res;
      },
    };
  }
  const loginCookie = async (name, password) => {
    const res = await formPostRaw(BASE, "/login", { name, password });
    return sessionCookieOf(res);
  };
  // Poll a sign-in until the door answers it: the way past a
  // brief source lockout a failure-heavy family tripped, with
  // no assumption about which doubling step the lock is on.
  const loginWhenFree = async (name, password) => {
    for (let i = 0; i < 18; i++) {
      const cookie = await loginCookie(name, password);
      if (cookie) return cookie;
      await new Promise((r) => setTimeout(r, 5000));
    }
    return null;
  };
  // The login door's passkey routes speak JSON, like the
  // sign-in page's own script: the credential goes as the
  // body itself, a good tap answers 200 with the session
  // cookie, and a refused tap answers 401 with no cookie.
  const passkeyVerifyPost = (credential) => raw(BASE, "POST", "/login/passkey/verify", {
    "Content-Type": "application/json",
  }, JSON.stringify(credential));
  const passkeySignIn = async (name, auth, handle) => {
    const opts = await raw(BASE, "POST", "/login/passkey/options", {
      "Content-Type": "application/json",
    }, JSON.stringify({ name }));
    if (!opts.json) return { status: opts.status, cookie: null };
    const res = await passkeyVerifyPost(auth.assertion(opts.json.challenge, handle));
    return { status: res.status, cookie: sessionCookieOf(res), json: res.json };
  };
  const enrolPasskey = async (caller, auth, nickname) => {
    const opts = await caller.call("POST", "/api/auth/passkeys/options", {});
    if (opts.status !== 200) return opts;
    const handle = b64uToBuf(opts.json.user.id);
    const created = await caller.call("POST", "/api/auth/passkeys", {
      response: auth.attestation(opts.json.challenge),
      nickname: nickname || "",
    });
    created.handle = handle;
    return created;
  };

  // -- Enrolment and the step-up rule (determination 2) --
  const cookieA = await loginWhenFree(NAME_A, PASSWORD_A);
  check("#109: person A signs in with a password for the passkey family",
    !!cookieA, "cookie " + !!cookieA);
  const aDoor = doorCaller(cookieA);
  const authA1 = makeAuthenticator();
  let enrol = await enrolPasskey(aDoor, authA1, "Drill authenticator one");
  check("#109: the first passkey enrols against the fresh proof the sign-in itself gave",
    enrol.status === 201, "status " + enrol.status);
  check("#141: enrolling a passkey stands the device's sign-in view up as the passkey view",
    (enrol.headers["set-cookie"] || []).some((c) => c.startsWith("ts_view=passkey")),
    "cookies " + (enrol.headers["set-cookie"] || []).map((c) => c.split("=")[0]).join(","));
  let meA = await aDoor.call("GET", "/api/auth/me");
  check("#109: the account now lists one passkey, with its name",
    meA.status === 200 && meA.json.passkeys.length === 1 &&
      meA.json.passkeys[0].nickname === "Drill authenticator one",
    JSON.stringify(meA.json && meA.json.passkeys));
  const handleA = enrol.handle;
  let refused = await aDoor.call("POST", "/api/auth/passkeys/options", {});
  check("#109: a second enrolment on a password proof alone is refused once a passkey stands",
    refused.status === 403 && refused.json && refused.json.stepUp === "passkey",
    "status " + refused.status + " body " + refused.text.slice(0, 100));
  let proof = await aDoor.call("POST", "/api/auth/proof/password", { password: PASSWORD_A });
  check("#109: a password proof still lands — it just no longer guards enrolment",
    proof.status === 200, "status " + proof.status);
  refused = await aDoor.call("POST", "/api/auth/passkeys/options", {});
  check("#109: after the password proof the enrolment is still refused",
    refused.status === 403 && refused.json && refused.json.stepUp === "passkey",
    "status " + refused.status);
  const proofOpts = await aDoor.call("POST", "/api/auth/proof/passkey/options", {});
  const proofTap = proofOpts.json
    ? await aDoor.call("POST", "/api/auth/proof/passkey/verify",
        { response: authA1.assertion(proofOpts.json.challenge, handleA) })
    : { status: 0 };
  check("#109: a passkey proof lands",
    proofTap.status === 200, "status " + proofTap.status);
  const authA2 = makeAuthenticator();
  enrol = await enrolPasskey(aDoor, authA2, "Drill authenticator two");
  check("#109: the second passkey enrols behind the passkey proof",
    enrol.status === 201, "status " + enrol.status);
  meA = await aDoor.call("GET", "/api/auth/me");
  check("#109: the account now lists two passkeys",
    meA.status === 200 && meA.json.passkeys.length === 2,
    "count " + (meA.json && meA.json.passkeys.length));

  // -- Passkey sign-in, and the hostile ceremonies --
  const goodTap = await passkeySignIn(NAME_A, authA1, handleA);
  check("#109: a passkey signs A in, no password typed",
    goodTap.status === 200 && !!goodTap.cookie && !!(goodTap.json && goodTap.json.ok),
    "status " + goodTap.status);
  // A credential id sent WITH base64 padding names the same
  // credential (issue #111's recorded fragility, hardened in
  // the follow-on build): the lookup normalizes the id to
  // its canonical unpadded form before matching, so padding
  // alone never refuses a sign-in.
  {
    const opts = await raw(BASE, "POST", "/login/passkey/options", {
      "Content-Type": "application/json",
    }, JSON.stringify({ name: NAME_A }));
    const cred = authA1.assertion(opts.json.challenge, handleA);
    cred.id = cred.id + "=".repeat((4 - (cred.id.length % 4)) % 4);
    const res = await passkeyVerifyPost(cred);
    check("#111 follow-on: a padded credential id signs in — the lookup normalizes before matching",
      cred.id.endsWith("=") && res.status === 200 && !!sessionCookieOf(res),
      "status " + res.status + " id " + cred.id);
  }
  // -- The remembered name (issue #112) --
  const rememberOf = (res) =>
    (res.headers["set-cookie"] || []).find((c) => c.startsWith("ts_name=")) || "";
  {
    // The page itself, in both shapes: the remember box
    // stands ticked, and the passkey button stands under the
    // name entry, before the password field.
    const plain = await raw(BASE, "GET", "/login", {});
    check("#112: the sign-in page carries the remember box, ticked",
      plain.text.includes('id="remember-name"') &&
        /id="remember-name"[^>]*checked/.test(plain.text) &&
        plain.text.includes("Remember my name on this device"),
      "status " + plain.status);
    check("#112: the passkey button stands under the name entry, before the password",
      plain.text.indexOf('id="passkey-button"') !== -1 &&
        plain.text.indexOf('id="passkey-button"') < plain.text.indexOf('name="password"'),
      "button at " + plain.text.indexOf('id="passkey-button"') +
        " password at " + plain.text.indexOf('name="password"'));
    // The same page as an ordinary HTTP address serves it
    // (issue #113): fetched from this same server with a
    // home-style Host name — the name a browser on the home
    // network would use, not localhost — the page leaves the
    // passkey button out entirely and prints the line in its
    // place, because no passkey ceremony can run at such an
    // address. The Worker rig is HTTPS, where passkeys can
    // run; the checks above are its half.
    if (MODE === "selfhost") {
      const port = new URL(BASE).port || "80";
      const atHome = await raw("http://127.0.0.1:" + port, "GET", "/login",
        { Host: "drill-home.local:" + port });
      check("#113: at an ordinary HTTP address the sign-in page leaves the passkey button out",
        atHome.status === 200 && !atHome.text.includes('id="passkey-button"'),
        "status " + atHome.status);
      // Issue #122 (amendment A.8) displaces the #113 line on
      // the sign-in page only: the settled words name the
      // unencrypted site plainly and link to the self-hosting
      // guide's HTTPS section. The Account page keeps its own
      // line; the spend pages keep the standing one.
      check("#122: at an ordinary HTTP address the sign-in carries the settled line and the HTTPS link, and no view switch",
        atHome.text.includes("This site is not encrypted. A password typed here can be read on this network.") &&
          atHome.text.includes("How to give this site HTTPS") &&
          atHome.text.includes("docs/self-hosting.md#the-routes-to-https-ranked") &&
          !atHome.text.includes('id="view-switch"') &&
          !atHome.text.includes("Passkeys need a secure address (HTTPS)."),
        "line " + (atHome.text.includes("not encrypted") ? "present" : "missing"));
    }
    // Ticked — what the page's box posts: the name rests on
    // the device as its own cookie beside the session.
    const ticked = await formPostRaw(BASE, "/login",
      { name: NAME_A, password: PASSWORD_A, remember: "1" });
    check("#112: a sign-in with the box ticked stands the remembered-name cookie",
      !!sessionCookieOf(ticked) &&
        decodeURIComponent(rememberOf(ticked).split(";")[0].slice("ts_name=".length)) === NAME_A,
      "set-cookie " + rememberOf(ticked).slice(0, 60));
    // The page fills it back in: on the hosted page into the
    // typed field (which also carries the passkey offer's
    // autofill word); at home as the pre-picked name.
    const filled = await raw(BASE, "GET", "/login",
      { Cookie: "ts_name=" + encodeURIComponent(NAME_A) });
    if (MODE === "worker") {
      check("#112: the hosted page fills the remembered name into the field, which carries the webauthn autofill word",
        filled.text.includes('value="' + NAME_A + '"') &&
          filled.text.includes('autocomplete="username webauthn"'),
        "status " + filled.status);
    } else {
      check("#112: the home page pre-picks the remembered name",
        filled.text.includes('value="' + NAME_A + '" checked'),
        "status " + filled.status);
    }
    // Unticked — an unticked box posts no field at all: the
    // remembered name is expired and nothing is stored.
    const unticked = await formPostRaw(BASE, "/login",
      { name: NAME_A, password: PASSWORD_A },
      { Cookie: "ts_name=" + encodeURIComponent(NAME_A) });
    const cleared = rememberOf(unticked);
    check("#112: a sign-in with the box unticked expires the remembered name",
      !!sessionCookieOf(unticked) &&
        (cleared.includes("Max-Age=0") || cleared.includes("Expires=Thu, 01 Jan 1970")),
      "set-cookie " + cleared.slice(0, 60));
    // A passkey sign-in remembers too, and honours the box:
    // the page's script sends the box's state with the tap.
    const tapOpts = await raw(BASE, "POST", "/login/passkey/options", {
      "Content-Type": "application/json",
    }, JSON.stringify({ name: NAME_A }));
    const tapRes = await passkeyVerifyPost(
      { ...authA1.assertion(tapOpts.json.challenge, handleA), remember: false });
    check("#112: a passkey tap with the box unticked clears the remembered name",
      tapRes.status === 200 &&
        (rememberOf(tapRes).includes("Max-Age=0") ||
          rememberOf(tapRes).includes("Expires=Thu, 01 Jan 1970")),
      "status " + tapRes.status + " set-cookie " + rememberOf(tapRes).slice(0, 60));
    const tapOpts2 = await raw(BASE, "POST", "/login/passkey/options", {
      "Content-Type": "application/json",
    }, JSON.stringify({ name: NAME_A }));
    const tapRes2 = await passkeyVerifyPost(
      { ...authA1.assertion(tapOpts2.json.challenge, handleA), remember: true });
    check("#112: a passkey tap with the box ticked stands the remembered name",
      tapRes2.status === 200 &&
        decodeURIComponent(rememberOf(tapRes2).split(";")[0].slice("ts_name=".length)) === NAME_A,
      "status " + tapRes2.status + " set-cookie " + rememberOf(tapRes2).slice(0, 60));
  }
  const hostile = async (label, build) => {
    const opts = await raw(BASE, "POST", "/login/passkey/options", {
      "Content-Type": "application/json",
    }, JSON.stringify({ name: NAME_A }));
    const res = await passkeyVerifyPost(build(opts.json.challenge));
    check("#109 hostile: " + label,
      res.status === 401 && !sessionCookieOf(res),
      "status " + res.status);
  };
  await hostile("an assertion without user verification is refused",
    (ch) => authA1.assertion(ch, handleA, { uv: false }));
  await hostile("an assertion without user presence is refused",
    (ch) => authA1.assertion(ch, handleA, { up: false }));
  await hostile("an assertion for another origin is refused",
    (ch) => authA1.assertion(ch, handleA, { origin: "https://evil.example" }));
  await hostile("an assertion of the wrong ceremony type is refused",
    (ch) => authA1.assertion(ch, handleA, { type: "webauthn.create" }));
  await hostile("an assertion carrying another account's handle is refused",
    (ch) => authA1.assertion(ch, randomBytes(16)));
  // A replayed challenge: the first spend is a good sign-in;
  // the same challenge answered again is refused, spent. The
  // hostile run above may have tripped the source's lock —
  // challenge issuance is refused while it stands — so poll
  // the options route until it answers again before the
  // honest spend.
  {
    let opts = null;
    for (let i = 0; i < 18; i++) {
      opts = await raw(BASE, "POST", "/login/passkey/options", {
        "Content-Type": "application/json",
      }, JSON.stringify({ name: NAME_A }));
      if (opts.json && opts.json.challenge) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    const first = await passkeyVerifyPost(authA1.assertion(opts.json.challenge, handleA));
    check("#109: the replay family's first spend signs in (and clears the failure count)",
      first.status === 200 && !!sessionCookieOf(first), "status " + first.status);
    const second = await passkeyVerifyPost(authA1.assertion(opts.json.challenge, handleA));
    check("#109 hostile: a replayed challenge is refused — challenges are single-use",
      second.status === 401 && !sessionCookieOf(second),
      "status " + second.status);
  }
  // A credential nobody enrolled: the door offers the attempt
  // its dummy shape and refuses it the same plain way.
  {
    const stranger = makeAuthenticator();
    const opts = await raw(BASE, "POST", "/login/passkey/options", {
      "Content-Type": "application/json",
    }, JSON.stringify({ name: NAME_A }));
    const res = await passkeyVerifyPost(stranger.assertion(opts.json.challenge, handleA));
    check("#109 hostile: an unenrolled credential is refused like any bad tap",
      res.status === 401 && !sessionCookieOf(res),
      "status " + res.status);
  }

  // -- Sessions: sign out everywhere, and sign out (person B) --
  const cookieB1 = await loginWhenFree(NAME_B, PASSWORD_B);
  const cookieB2 = await loginCookie(NAME_B, PASSWORD_B);
  const bDoor1 = doorCaller(cookieB1);
  let gone = await bDoor1.call("POST", "/api/auth/signout-everywhere", {});
  check("#109: sign-out-everywhere answers the caller that stays",
    gone.status === 200, "status " + gone.status);
  let other = await raw(BASE, "GET", "/api/v1/state", { Cookie: cookieB2 || "" });
  check("#109: the other session is revoked — not just its cookie dropped",
    other.status === 401, "status " + other.status);
  let mine = await bDoor1.call("GET", "/api/v1/state");
  check("#109: the caller's own session stands",
    mine.status === 200, "status " + mine.status);
  const outRes = await raw(BASE, "GET", "/logout", { Cookie: cookieB1 || "" });
  check("#109: signing out answers with a redirect to the sign-in page",
    outRes.status === 302 && (outRes.headers.location || "") === "/login",
    "status " + outRes.status + " location " + outRes.headers.location);
  mine = await raw(BASE, "GET", "/api/v1/state", { Cookie: cookieB1 || "" });
  check("#109: after sign-out the session itself is revoked server-side",
    mine.status === 401, "status " + mine.status);

  // -- Changing the password (person B) --
  const PW_B2 = "drill-b-changed-password";
  const cookieB3 = await loginWhenFree(NAME_B, PASSWORD_B);
  const bDoor = doorCaller(cookieB3);
  let changed = await bDoor.call("POST", "/api/auth/password",
    { current_password: "not-b-password-1", new_password: PW_B2 });
  check("#109: a wrong current password refuses the change",
    changed.status === 401, "status " + changed.status);
  changed = await bDoor.call("POST", "/api/auth/password",
    { current_password: PASSWORD_B, new_password: PW_B2 });
  check("#109: the change lands behind the current password",
    changed.status === 200, "status " + changed.status);
  const oldTry = await loginCookie(NAME_B, PASSWORD_B);
  check("#109: the old password no longer signs B in",
    !oldTry, "cookie " + !!oldTry);
  const newTry = await loginCookie(NAME_B, PW_B2);
  check("#109: the new password signs B in", !!newTry, "cookie " + !!newTry);
  const bDoor2 = doorCaller(newTry);
  changed = await bDoor2.call("POST", "/api/auth/password", { new_password: PASSWORD_B });
  check("#109: a change behind a fresh sign-in proof alone lands too",
    changed.status === 200, "status " + changed.status);

  // A stale proof is refused and asked for proof (issue
  // #114: the change form carries no current-password field
  // of its own, so this refusal is the door the proof panel
  // answers). Self-host only: the drill ages the session's
  // proof in the data file directly. Worker mode proves the
  // identical refusal through the enrolment step-up cases
  // above, which ride the same refusal shape.
  if (MODE === "selfhost" && args["server-config"]) {
    const bDoorS = doorCaller(await loginWhenFree(NAME_B, PASSWORD_B));
    const cfgS = JSON.parse(readFileSync(args["server-config"], "utf8"));
    const fileS = join(dirname(args["server-config"]), String(cfgS.dataDir || "data"), "tasksparkle.sqlite");
    const rwS = new DatabaseSync(fileS);
    rwS.prepare("UPDATE sessions SET proof_at = ? WHERE account_key = ?")
      .run(Date.now() - 11 * 60 * 1000, B);
    rwS.close();
    let stale = await bDoorS.call("POST", "/api/auth/password", { new_password: "drill-b-stale-password" });
    check("#114: a change behind a stale proof is refused and asked for proof",
      stale.status === 403 && stale.json && !!stale.json.stepUp,
      "status " + stale.status + " body " + (stale.text || "").slice(0, 80));
    const proofS = await bDoorS.call("POST", "/api/auth/proof/password", { password: PASSWORD_B });
    check("#114: the proof the refusal asked for lands",
      proofS.status === 200, "status " + proofS.status);
    stale = await bDoorS.call("POST", "/api/auth/password", { new_password: "drill-b-stale-password" });
    check("#114: behind the fresh proof the change lands",
      stale.status === 200, "status " + stale.status);
    const backS = await bDoorS.call("POST", "/api/auth/password", { new_password: PASSWORD_B });
    check("#114: and is set back behind the same proof",
      backS.status === 200, "status " + backS.status);
  }

  // -- A reset spend revokes sessions and removes no passkey
  //    (person B; issue #122, amendment A.5 as ruled: [B]) --
  // Appendix D's eviction drill, inverted by the ruling: a
  // plain reset leaves every passkey standing, and removal
  // happens only by the named acts — here, the reset form's
  // own start-fresh choice, taken in the open.
  const cookieB4 = await loginWhenFree(NAME_B, PASSWORD_B);
  const bDoor4 = doorCaller(cookieB4);
  const authB = makeAuthenticator();
  enrol = await enrolPasskey(bDoor4, authB, "B's authenticator");
  check("#109: B enrols a passkey for the reset family",
    enrol.status === 201, "status " + enrol.status);
  const handleB = enrol.handle;
  const cookieB5 = await loginCookie(NAME_B, PASSWORD_B);
  const resetMint = await a.call("POST", "/api/auth/invites", { name: NAME_B });
  const resetCode = resetMint.json && resetMint.json.code;
  const PW_B3 = "drill-b-reset-password-3";
  const resetPage = await raw(BASE, "GET", "/invite/" + resetCode, {});
  check("#122: the reset form carries the start-fresh choice in the open, off unless chosen",
    resetPage.status === 200 && resetPage.text.includes('name="start_fresh"') &&
      resetPage.text.includes("Start fresh: remove my passkeys and enrol a new one"),
    "status " + resetPage.status);
  const spentReset = await formPostRaw(BASE, "/invite/" + resetCode,
    { password: PW_B3, confirm: PW_B3 });
  check("#109: the reset invite spends and signs B in on the new password",
    spentReset.status === 302 && !!sessionCookieOf(spentReset), "status " + spentReset.status);
  let evicted = await raw(BASE, "GET", "/api/v1/state", { Cookie: cookieB4 || "" });
  check("#109: the reset revoked B's first standing session",
    evicted.status === 401, "status " + evicted.status);
  evicted = await raw(BASE, "GET", "/api/v1/state", { Cookie: cookieB5 || "" });
  check("#109: the reset revoked B's second standing session",
    evicted.status === 401, "status " + evicted.status);
  const tapAfterReset = await passkeySignIn(NAME_B, authB, handleB);
  check("#122: after a plain reset the passkey still signs B in — the reset removed no passkey",
    tapAfterReset.status === 200 && !!tapAfterReset.cookie,
    "status " + tapAfterReset.status);
  const bDoorReset = doorCaller(sessionCookieOf(spentReset));
  const meAfterReset = await bDoorReset.call("GET", "/api/auth/me");
  check("#122: B's own list agrees — the passkey stands after the reset",
    meAfterReset.status === 200 && meAfterReset.json.passkeys.length === 1,
    "count " + (meAfterReset.json && meAfterReset.json.passkeys.length));
  // The named act (issue #133): a second reset, with start
  // fresh chosen. The choice is the enrolment ceremony paired
  // with the spend — the page runs the ceremony from the
  // ticked form's Set password press, and the removal lands
  // only inside the ceremony's verify, beside the new
  // passkey. A form post carrying the field, with no ceremony
  // behind it, is a plain reset: removal without the
  // enrolment is impossible.
  const freshMint = await a.call("POST", "/api/auth/invites", { name: NAME_B });
  const freshCode = freshMint.json && freshMint.json.code;
  const PW_B4 = "drill-b-reset-password-4";
  const spentFresh = await formPostRaw(BASE, "/invite/" + freshCode,
    { password: PW_B4, confirm: PW_B4, start_fresh: "1" });
  check("#133: a reset form post with start fresh ticked still spends and signs B in",
    spentFresh.status === 302 && !!sessionCookieOf(spentFresh), "status " + spentFresh.status);
  const tapAfterForm = await passkeySignIn(NAME_B, authB, handleB);
  check("#133: the form post alone removed nothing — the old passkey still signs B in",
    tapAfterForm.status === 200 && !!tapAfterForm.cookie,
    "status " + tapAfterForm.status);
  const bDoorForm = doorCaller(sessionCookieOf(spentFresh));
  const meAfterForm = await bDoorForm.call("GET", "/api/auth/me");
  check("#133: B's own list agrees — the passkey stands after the ticked form post",
    meAfterForm.status === 200 && meAfterForm.json.passkeys.length === 1,
    "count " + (meAfterForm.json && meAfterForm.json.passkeys.length));
  // The ceremony the page runs from the ticked press.
  const resetOptions = (code, fields) => raw(BASE, "POST",
    "/invite/" + code + "/passkey/options",
    { "Content-Type": "application/json" }, JSON.stringify(fields || {}));
  const resetVerify = (code, body) => raw(BASE, "POST",
    "/invite/" + code + "/passkey/verify",
    { "Content-Type": "application/json" }, JSON.stringify(body));
  const cerMint = await a.call("POST", "/api/auth/invites", { name: NAME_B });
  const cerCode = cerMint.json && cerMint.json.code;
  const authB2 = makeAuthenticator();
  const oCer = await resetOptions(cerCode, { startFresh: true });
  check("#133: the reset ceremony's options open for a start-fresh spend",
    oCer.status === 200 && !!oCer.json && !!oCer.json.challenge,
    "status " + oCer.status + " body " + (oCer.text || "").slice(0, 120));
  const vCer = oCer.json ? await resetVerify(cerCode, {
    response: authB2.attestation(oCer.json.challenge),
    password: PW_B4, confirm: PW_B4,
  }) : { status: 0, text: "" };
  const cookieCer = sessionCookieOf(vCer);
  check("#133: the start-fresh ceremony spends the invite and begins a session",
    vCer.status === 200 && !!cookieCer,
    "status " + vCer.status + " body " + (vCer.text || "").slice(0, 120));
  check("#141: the start-fresh ceremony spend stands the sign-in view up as the passkey view too",
    (vCer.headers["set-cookie"] || []).some((c) => c.startsWith("ts_view=passkey")),
    "cookies " + (vCer.headers["set-cookie"] || []).map((c) => c.split("=")[0]).join(","));
  const tapAfterFresh = await passkeySignIn(NAME_B, authB, handleB);
  check("#133: after the start-fresh ceremony the old passkey no longer signs in — the named act removed it",
    tapAfterFresh.status === 401 && !tapAfterFresh.cookie,
    "status " + tapAfterFresh.status);
  const tapNew = await passkeySignIn(NAME_B, authB2, handleB);
  check("#133: the ceremony's new passkey signs B in",
    tapNew.status === 200 && !!tapNew.cookie, "status " + tapNew.status);
  const oldPassword = await loginCookie(NAME_B, PW_B3);
  check("#133: the password from before the ceremony no longer signs B in",
    !oldPassword, "cookie " + !!oldPassword);
  const formSession = await bDoorForm.call("GET", "/api/auth/me");
  check("#133: the ceremony spend revoked the form spend's session",
    formSession.status === 401, "status " + formSession.status);
  // On the broken code the ceremony refuses, so no session
  // rides it: fall back to a plain sign-in on the form
  // spend's password, so the removal family below still runs
  // and records its own verdicts instead of dying here.
  const bDoor6 = doorCaller(cookieCer || (await loginWhenFree(NAME_B, PW_B4)));
  const meB = await bDoor6.call("GET", "/api/auth/me");
  check("#133: B's own list agrees — exactly the ceremony's passkey stands",
    meB.status === 200 && !!meB.json && (meB.json.passkeys || []).length === 1 &&
      meB.json.passkeys[0].id === authB2.credIdB64u,
    "count " + (meB.json && meB.json.passkeys ? meB.json.passkeys.length : "none"));
  // The boundary: a ceremony on a reset invite without the
  // start-fresh choice never spends it.
  const plainMint = await a.call("POST", "/api/auth/invites", { name: NAME_B });
  const plainCode = plainMint.json && plainMint.json.code;
  const oPlain = await resetOptions(plainCode, {});
  const vPlain = oPlain.json ? await resetVerify(plainCode,
    { response: authB.attestation(oPlain.json.challenge) }) : { status: 0 };
  check("#133: a reset ceremony without the start-fresh choice still refuses",
    vPlain.status === 400, "status " + vPlain.status);

  // -- The administrator removes another person's passkey (determination 7) --
  const peopleNow = await a.call("GET", "/api/auth/people");
  const bEntry = (peopleNow.json.people || []).find((p) => p.key === B);
  const bCredId = bEntry && bEntry.passkeys[0] && bEntry.passkeys[0].id;
  check("#109: the Admin page shows B's passkey standing (posture)",
    !!bCredId, JSON.stringify(bEntry && bEntry.passkeys));
  let notAdmin = await bDoor6.call("DELETE",
    "/api/auth/people/" + encodeURIComponent(A) + "/passkeys/" + authA1.credIdB64u);
  check("#109: a non-administrator removing a passkey gets a 403",
    notAdmin.status === 403, "status " + notAdmin.status);
  let removedByAdmin = await a.call("DELETE",
    "/api/auth/people/" + encodeURIComponent(B) + "/passkeys/" + encodeURIComponent(bCredId));
  check("#109: the administrator removes B's passkey",
    removedByAdmin.status === 200, "status " + removedByAdmin.status);
  const meB2 = await bDoor6.call("GET", "/api/auth/me");
  check("#109: B's list agrees the passkey is gone",
    meB2.status === 200 && meB2.json.passkeys.length === 0,
    "count " + (meB2.json && meB2.json.passkeys.length));
  const bStillSigns = await loginCookie(NAME_B, PW_B4);
  check("#109: B's password still stands after the removal — only the device went",
    !!bStillSigns, "cookie " + !!bStillSigns);
  // B's password is the start-fresh reset's one from here on;
  // restore the drill's standing password so the families
  // after this one (which sign B in with PASSWORD_B) are
  // undisturbed.
  const bDoorBack = doorCaller(bStillSigns);
  const restored = await bDoorBack.call("POST", "/api/auth/password",
    { current_password: PW_B4, new_password: PASSWORD_B });
  check("#109: B's password is restored for the families that follow",
    restored.status === 200, "status " + restored.status);
  removedByAdmin = await a.call("DELETE",
    "/api/auth/people/" + encodeURIComponent(B) + "/passkeys/" + encodeURIComponent(bCredId));
  check("#109: removing a passkey that no longer stands answers 404",
    removedByAdmin.status === 404, "status " + removedByAdmin.status);

  // -- Keys on the sign-in routes: 403 everywhere (design section 10) --
  const keyMint = await a.call("POST", "/api/v1/me/token", { name: "Auth Routes Key" });
  const authKey = keyMint.json && keyMint.json.key;
  const keyOnAuth = async (method, path, body) => {
    const h = { Authorization: "Bearer " + authKey };
    let payload = null;
    if (body != null) {
      h["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    return raw(BASE, method, path, h, payload);
  };
  const authRoutes = [
    ["GET", "/api/auth/me"], ["GET", "/api/auth/people"],
    ["POST", "/api/auth/invites", { name: "Sneaky" }],
    ["POST", "/api/auth/proof/password", { password: PASSWORD_A }],
    ["POST", "/api/auth/proof/passkey/options", {}],
    ["POST", "/api/auth/passkeys/options", {}],
    ["POST", "/api/auth/passkeys", {}],
    ["POST", "/api/auth/password", { new_password: "sneaky-new-password" }],
    ["POST", "/api/auth/password/remove", {}],
    ["POST", "/api/auth/signout-everywhere", {}],
    ["POST", "/api/auth/admin", { account_key: B, admin: true }],
    ["POST", "/api/auth/claim", { owner_id: "x", account_key: B }],
    ["DELETE", "/api/auth/people/" + encodeURIComponent(B)],
    ["DELETE", "/api/auth/passkeys/" + authA1.credIdB64u],
  ];
  let keyRefusals = 0;
  for (const [m, path, body] of authRoutes) {
    const r = await keyOnAuth(m, path, body);
    if (r.status === 403 && !sessionCookieOf(r)) keyRefusals += 1;
    else console.log("  key on " + m + " " + path + " answered " + r.status);
  }
  check("#109: a key gets a 403 on every sign-in route, and no session is ever issued to one",
    keyRefusals === authRoutes.length,
    keyRefusals + " of " + authRoutes.length + " refused");

  // -- Passkey-first: the drop, the add-back, the passkey-born
  //    account, its recovery and the sign-in views (issue #122,
  //    amendment A.3, A.4, A.6, A.7, A.8) --

  // The drop, on person A (a password and two passkeys stand).
  // A fresh password sign-in's proof is fresh and password-only:
  // the drop refuses it, because the act takes a passkey tap.
  const cookieA2 = await loginCookie(NAME_A, PASSWORD_A);
  const aDoorPw = doorCaller(await loginCookie(NAME_A, PASSWORD_A));
  let dropTry = await aDoorPw.call("POST", "/api/auth/password/remove", {});
  check("#122: the drop refuses a password-only fresh proof and asks for a passkey",
    dropTry.status === 403 && dropTry.json && dropTry.json.stepUp === "passkey",
    "status " + dropTry.status + " body " + (dropTry.text || "").slice(0, 100));
  const dropProofOpts = await aDoorPw.call("POST", "/api/auth/proof/passkey/options", {});
  const dropProof = await aDoorPw.call("POST", "/api/auth/proof/passkey/verify",
    { response: authA1.assertion(dropProofOpts.json.challenge, handleA) });
  check("#122: a passkey tap proves A for the drop",
    dropProof.status === 200, "status " + dropProof.status);
  const cookieBeforeDrop = aDoorPw.headers.Cookie;
  dropTry = await aDoorPw.call("POST", "/api/auth/password/remove", {});
  check("#122: the drop lands on the fresh passkey tap",
    dropTry.status === 200, "status " + dropTry.status);
  const droppedOld = await raw(BASE, "GET", "/api/auth/me", { Cookie: cookieBeforeDrop || "" });
  check("#122: the drop rotated the current session — the pre-drop cookie is dead",
    droppedOld.status === 401, "status " + droppedOld.status);
  const droppedOther = await raw(BASE, "GET", "/api/v1/state", { Cookie: cookieA2 || "" });
  check("#122: the drop revoked A's other standing session",
    droppedOther.status === 401, "status " + droppedOther.status);
  const meDropped = await aDoorPw.call("GET", "/api/auth/me");
  check("#122: A's account now holds no password, and its passkeys stand untouched",
    meDropped.status === 200 && meDropped.json.hasPassword === false &&
      meDropped.json.passkeys.length === 2,
    "me " + meDropped.status + " body " + (meDropped.text || "").slice(0, 120));
  const pwSignInDropped = await loginCookie(NAME_A, PASSWORD_A);
  check("#122: password sign-in against the dropped account refuses in the standing shape",
    !pwSignInDropped, "cookie " + !!pwSignInDropped);
  // The add-back, on the same account: the password rules
  // refuse first, then a good password lands behind the
  // passkey proof the drop left fresh on the session.
  let addTry = await aDoorPw.call("POST", "/api/auth/password", { new_password: "short" });
  check("#122: the add-back refuses a short password",
    addTry.status === 400, "status " + addTry.status);
  addTry = await aDoorPw.call("POST", "/api/auth/password", { new_password: "motherfucker" });
  check("#122: the add-back refuses a password people use most",
    addTry.status === 400, "status " + addTry.status);
  addTry = await aDoorPw.call("POST", "/api/auth/password", { new_password: PASSWORD_A });
  check("#122: the add-back lands on the standing fresh passkey proof",
    addTry.status === 200, "status " + addTry.status);
  const meRestored = await aDoorPw.call("GET", "/api/auth/me");
  check("#122: A holds a password again, and the new one is the one that signs in",
    meRestored.status === 200 && meRestored.json.hasPassword === true &&
      !!(await loginCookie(NAME_A, PASSWORD_A)),
    "me " + meRestored.status);
  // The drop revoked every other session A held, the main
  // caller's included — that is the act working as designed.
  // Sign the main caller back in so the families after this
  // one keep their door.
  a.headers.Cookie = await loginCookie(NAME_A, PASSWORD_A);

  // The passkey-born account: an invite spent by ceremony.
  const NAME_P = "Drill Passkey";
  const KEY_P = "drill passkey";
  const mintP = await a.call("POST", "/api/auth/invites", { name: NAME_P });
  const codeP = mintP.json && mintP.json.code;
  const pageP = await raw(BASE, "GET", "/invite/" + codeP, {});
  check("#122: the invite page offers the passkey way standing first (issue #141)",
    pageP.status === 200 && pageP.text.includes('id="spend-passkey-button"') &&
      pageP.text.includes('name="password"') &&
      pageP.text.indexOf('id="spend-passkey-button"') < pageP.text.indexOf('id="spend-password"'),
    "status " + pageP.status);
  const authP = makeAuthenticator();
  const inviteOptions = (code, fields) => raw(BASE, "POST",
    "/invite/" + code + "/passkey/options",
    { "Content-Type": "application/json" }, JSON.stringify(fields || {}));
  const inviteVerify = (code, cred) => raw(BASE, "POST",
    "/invite/" + code + "/passkey/verify",
    { "Content-Type": "application/json" }, JSON.stringify({ response: cred }));
  const o1 = await inviteOptions(codeP, { name: NAME_P });
  check("#122: the spend ceremony's options mint the handle in the pending record",
    o1.status === 200 && !!o1.json && !!o1.json.challenge &&
      !!o1.json.user && !!o1.json.user.id,
    "status " + o1.status + " body " + (o1.text || "").slice(0, 120));
  const peopleBeforeP = await a.call("GET", "/api/auth/people");
  check("#122: an abandoned ceremony makes no account — the person stands nowhere yet",
    peopleBeforeP.status === 200 &&
      !(peopleBeforeP.json.people || []).some((p) => p.key === KEY_P),
    "people " + JSON.stringify((peopleBeforeP.json.people || []).map((p) => p.key)));
  const o2 = await inviteOptions(codeP, { name: NAME_P });
  const credP = authP.attestation(o2.json.challenge);
  const vP = await inviteVerify(codeP, credP);
  const cookieP = sessionCookieOf(vP);
  check("#122: the ceremony lands and the passkey-born account's session begins",
    vP.status === 200 && !!cookieP, "status " + vP.status);
  check("#141: the invite spend stands the device's sign-in view up as the passkey view",
    (vP.headers["set-cookie"] || []).some((c) => c.startsWith("ts_view=passkey")),
    "cookies " + (vP.headers["set-cookie"] || []).map((c) => c.split("=")[0]).join(","));
  const pDoor = doorCaller(cookieP);
  const meP = await pDoor.call("GET", "/api/auth/me");
  check("#122: the passkey-born account holds no password and one passkey, its proof the passkey",
    meP.status === 200 && meP.json.hasPassword === false &&
      meP.json.passkeys.length === 1 && meP.json.proofVia === "passkey",
    "me " + meP.status + " body " + (meP.text || "").slice(0, 140));
  const peopleP = await a.call("GET", "/api/auth/people");
  const pEntry = (peopleP.json.people || []).find((p) => p.key === KEY_P);
  check("#122: the people read serves the posture the Admin page names Passkey only",
    !!pEntry && pEntry.hasPassword === false && pEntry.passkeys.length === 1,
    JSON.stringify(pEntry));
  const vReplay = await inviteVerify(codeP, credP);
  check("#122: a replayed spend ceremony is refused — challenge and invite spent once",
    (vReplay.status === 400 || vReplay.status === 401) && !sessionCookieOf(vReplay),
    "status " + vReplay.status);
  const pageSpentP = await raw(BASE, "GET", "/invite/" + codeP, {});
  check("#122: the spent invite's page is the refusal page, for either way in",
    pageSpentP.status === 200 && pageSpentP.text.includes("This invite link does not work."),
    "status " + pageSpentP.status);
  const handleP = b64uToBuf(o2.json.user.id);
  const tapP = await passkeySignIn(NAME_P, authP, handleP);
  check("#122: the born passkey signs its person in",
    tapP.status === 200 && !!tapP.cookie, "status " + tapP.status);
  const pwProofP = await pDoor.call("POST", "/api/auth/proof/password",
    { password: "anything-at-all-123" });
  check("#122: on a passwordless account the password proof refuses through the dummy",
    pwProofP.status === 401, "status " + pwProofP.status);
  const authP2 = makeAuthenticator();
  const enrolP2 = await enrolPasskey(pDoor, authP2, "Second device");
  check("#122: the spend's own stamped proof carries the next guarded act (A.7, item 16)",
    enrolP2.status === 201, "status " + enrolP2.status);

  // The recovery spend: the same person's new invite is a
  // recovery page, not a password form — and under [B] the
  // standing passkeys remain through it.
  const mintRec = await a.call("POST", "/api/auth/invites", { name: NAME_P });
  const codeRec = mintRec.json && mintRec.json.code;
  const pageRec = await raw(BASE, "GET", "/invite/" + codeRec, {});
  check("#122: a passwordless account's invite opens the recovery page, not a password form",
    pageRec.status === 200 && pageRec.text.includes('id="spend-passkey-button"') &&
      !pageRec.text.includes('name="password"') &&
      pageRec.text.includes("Start fresh: remove my passkeys and enrol a new one"),
    "status " + pageRec.status);
  const authP3 = makeAuthenticator();
  const oRec = await inviteOptions(codeRec, {});
  const vRec = await inviteVerify(codeRec, authP3.attestation(oRec.json.challenge));
  const cookieRec = sessionCookieOf(vRec);
  check("#122: the recovery ceremony lands and begins a session",
    vRec.status === 200 && !!cookieRec, "status " + vRec.status);
  check("#141: the recovery spend stands the device's sign-in view up as the passkey view",
    (vRec.headers["set-cookie"] || []).some((c) => c.startsWith("ts_view=passkey")),
    "cookies " + (vRec.headers["set-cookie"] || []).map((c) => c.split("=")[0]).join(","));
  const pDoorDead = await pDoor.call("GET", "/api/auth/me");
  check("#122: the recovery spend revoked the account's standing sessions",
    pDoorDead.status === 401, "status " + pDoorDead.status);
  const pDoorRec = doorCaller(cookieRec);
  const meRec = await pDoorRec.call("GET", "/api/auth/me");
  check("#122: after the recovery the standing passkeys remain, the new one beside them",
    meRec.status === 200 && meRec.json.hasPassword === false &&
      meRec.json.passkeys.length === 3,
    "me " + meRec.status + " count " + (meRec.json && meRec.json.passkeys.length));
  const tapOld = await passkeySignIn(NAME_P, authP, handleP);
  check("#122: a passkey from before the recovery still signs in — [B] removes none of them",
    tapOld.status === 200 && !!tapOld.cookie, "status " + tapOld.status);
  // Start fresh on the recovery page: the named act.
  const mintFresh = await a.call("POST", "/api/auth/invites", { name: NAME_P });
  const codeFresh = mintFresh.json && mintFresh.json.code;
  const authP4 = makeAuthenticator();
  const oFresh = await inviteOptions(codeFresh, { startFresh: true });
  const vFresh = await inviteVerify(codeFresh, authP4.attestation(oFresh.json.challenge));
  const pDoor2 = doorCaller(sessionCookieOf(vFresh));
  const meFresh = await pDoor2.call("GET", "/api/auth/me");
  check("#122: a start-fresh recovery leaves exactly the new passkey standing",
    vFresh.status === 200 && meFresh.status === 200 &&
      meFresh.json.passkeys.length === 1 &&
      meFresh.json.passkeys[0].id === authP4.credIdB64u,
    "me " + meFresh.status + " body " + (meFresh.text || "").slice(0, 140));
  const tapFreshOld = await passkeySignIn(NAME_P, authP, handleP);
  check("#122: the passkeys the start-fresh choice named no longer sign in",
    tapFreshOld.status === 401 && !tapFreshOld.cookie, "status " + tapFreshOld.status);

  // The last passkey on a passwordless account: refused both
  // ways (A.9, edge 1), each in its own side's words.
  const rmOwn = await pDoor2.call("DELETE", "/api/auth/passkeys/" + authP4.credIdB64u);
  check("#122: the person's own removal of the last passkey on a passwordless account is refused",
    rmOwn.status === 400 && !!rmOwn.json && /Add a password first/.test(rmOwn.json.error || ""),
    "status " + rmOwn.status + " body " + (rmOwn.text || "").slice(0, 140));
  const rmAdmin = await a.call("DELETE", "/api/auth/people/" +
    encodeURIComponent(KEY_P) + "/passkeys/" + encodeURIComponent(authP4.credIdB64u));
  check("#122: the administrator's removal of that passkey is refused the same way",
    rmAdmin.status === 400 && !!rmAdmin.json && /adds a password first/.test(rmAdmin.json.error || ""),
    "status " + rmAdmin.status + " body " + (rmAdmin.text || "").slice(0, 140));
  // Adding a password back makes the removal ordinary.
  const proofOptsP = await pDoor2.call("POST", "/api/auth/proof/passkey/options", {});
  const proofP = await pDoor2.call("POST", "/api/auth/proof/passkey/verify",
    { response: authP4.assertion(proofOptsP.json.challenge, handleP) });
  check("#122: a passkey tap proves the passkey-born account for its add-back",
    proofP.status === 200, "status " + proofP.status);
  let addP = await pDoor2.call("POST", "/api/auth/password", { new_password: "drill passkey" });
  check("#122: the add-back refuses the account's own name as the password",
    addP.status === 400 && !!addP.json && /your own name/.test(addP.json.error || ""),
    "status " + addP.status + " body " + (addP.text || "").slice(0, 120));
  addP = await pDoor2.call("POST", "/api/auth/password",
    { new_password: "drill-passkey-password" });
  check("#122: the add-back lands on the passkey proof",
    addP.status === 200, "status " + addP.status);
  const rmNow = await pDoor2.call("DELETE", "/api/auth/passkeys/" + authP4.credIdB64u);
  check("#122: with a password standing, the same removal is ordinary and lands",
    rmNow.status === 200, "status " + rmNow.status);

  // The sign-in views (A.8): a fresh device opens on the
  // passkey view; the device remembers the password view when
  // it was left there; no hint about the autofill passkey
  // stands anywhere on the page.
  const loginFresh = await raw(BASE, "GET", "/login", {});
  check("#122: a fresh device opens the sign-in on the passkey view, the switch below it",
    loginFresh.status === 200 &&
      loginFresh.text.includes('<div id="view-passkey">') &&
      loginFresh.text.includes('<div id="view-password" hidden>') &&
      loginFresh.text.includes('id="view-switch"') &&
      loginFresh.text.includes("Use a password instead"),
    "status " + loginFresh.status);
  const loginPwView = await raw(BASE, "GET", "/login", { Cookie: "ts_view=password" });
  check("#122: a device that left the password view open opens there, with the way back standing",
    loginPwView.status === 200 &&
      loginPwView.text.includes('<div id="view-password">') &&
      loginPwView.text.includes('<div id="view-passkey" hidden>') &&
      loginPwView.text.includes("Use a passkey instead"),
    "status " + loginPwView.status);
  check("#122: no hint about the autofill passkey stands anywhere on the sign-in, in either view",
    !/autofill/i.test(loginFresh.text) && !/autofill/i.test(loginPwView.text) &&
      !loginFresh.text.includes("passkey manager") &&
      !loginPwView.text.includes("passkey manager"),
    "");

  // -- The throttle's two curves (design section 7) --
  const SCRATCH = "Throttle Scratch";
  const wrongLogin = (name) => formPostRaw(BASE, "/login",
    { name, password: "not the password" });
  await wrongLogin(SCRATCH); await wrongLogin(SCRATCH); await wrongLogin(SCRATCH);
  const pairLocked = await formPostRaw(BASE, "/login",
    { name: SCRATCH, password: "not the password" });
  check("#109 throttle: three failures lock the source-and-account pair",
    pairLocked.status === 302 && !sessionCookieOf(pairLocked) &&
      (pairLocked.headers.location || "").includes("error=locked"),
    "status " + pairLocked.status + " location " + pairLocked.headers.location);
  const aUnaffected = await loginCookie(NAME_A, PASSWORD_A);
  check("#109 throttle: the pair lock leaves another account on the same source reachable",
    !!aUnaffected, "cookie " + !!aUnaffected);
  // The source curve counts across names. Five fresh names,
  // one failure each: a single name's attempts stop being
  // counted once its own pair locks, so the source's five
  // must come from five different pairings.
  for (const n of ["Throttle Scratch Two", "Throttle Scratch Three",
    "Throttle Scratch Four", "Throttle Scratch Five", "Throttle Scratch Six"]) {
    await wrongLogin(n);
  }
  const sourceLocked = await loginCookie(NAME_A, PASSWORD_A);
  check("#109 throttle: five failures lock the source itself, briefly",
    !sourceLocked, "cookie " + !!sourceLocked);
  const aBack = await loginWhenFree(NAME_A, PASSWORD_A);
  check("#109 throttle: the source lock passes and A signs in again — no account is ever locked as such",
    !!aBack, "cookie " + !!aBack);

  // -- Wave 3: the sign-in and spend refusals name their case
  //    (issues #143, #144, #145, #146, #147, #154, #155) --
  // Placed after the throttle curves on purpose: the failed
  // posts below note failures of their own, and the curves
  // above count theirs exactly.

  // A failed sign-in keeps the typed name (issue #143): the
  // refusal redirect carries it in the one-shot cookie, the
  // page stands it where the remembered name would, and the
  // cookie is expired by the answer that reads it.
  const attemptOf = (res) =>
    (res.headers["set-cookie"] || []).find((c) => c.startsWith("ts_attempt=")) || "";
  const failedOnce = await formPostRaw(BASE, "/login",
    { name: NAME_A, password: "not the password" });
  check("#143: a failed sign-in carries the typed name back in the one-shot cookie",
    failedOnce.status === 302 &&
      (failedOnce.headers.location || "").includes("error=1") &&
      decodeURIComponent(attemptOf(failedOnce).split(";")[0].slice("ts_attempt=".length)) === NAME_A,
    "status " + failedOnce.status + " cookie " + attemptOf(failedOnce).slice(0, 60));
  const attemptPage = await raw(BASE, "GET", "/login",
    { Cookie: "ts_attempt=" + encodeURIComponent(NAME_A) });
  if (MODE === "worker") {
    check("#143: the hosted page stands the attempted name in the typed field",
      attemptPage.text.includes('value="' + NAME_A + '"'),
      "status " + attemptPage.status);
  } else {
    check("#143: the home page pre-picks the attempted name on the list",
      attemptPage.text.includes('value="' + NAME_A + '" checked'),
      "status " + attemptPage.status);
  }
  check("#143: the page that reads the attempted name expires its cookie in the same answer",
    (attemptPage.headers["set-cookie"] || []).some((c) =>
      c.startsWith("ts_attempt=") && (c.includes("Max-Age=0") || c.includes("1970"))),
    "cookies " + (attemptPage.headers["set-cookie"] || []).join(" | ").slice(0, 80));

  // A second visit to /setup explains itself (issue #154):
  // the redirect carries the word, and the sign-in page it
  // lands on carries the sentence.
  const setupAgain = await raw(BASE, "GET", "/setup", {});
  check("#154: a second visit to /setup redirects to sign-in carrying the word",
    setupAgain.status === 302 &&
      (setupAgain.headers.location || "").includes("error=taken"),
    "status " + setupAgain.status + " location " + setupAgain.headers.location);
  const takenPage = await raw(BASE, "GET", "/login?error=taken", {});
  check("#154: the landing says the first account stands and names the invite path",
    takenPage.status === 200 &&
      takenPage.text.includes("The first account already stands.") &&
      takenPage.text.includes("the administrator can invite you from Settings, then Admin"),
    "status " + takenPage.status);

  if (MODE === "selfhost") {
    // The home copy's shapes at an ordinary HTTP address,
    // fetched with a home-style Host name the way the #113
    // checks fetch theirs.
    const port = new URL(BASE).port || "80";
    const homeBase = "http://127.0.0.1:" + port;
    const homeHost = { Host: "drill-home.local:" + port };
    // The headline names only what can run there (issue #145).
    const httpPage = await raw(homeBase, "GET", "/login", homeHost);
    check("#145: at an ordinary HTTP address the headline promises a password only",
      httpPage.status === 200 &&
        httpPage.text.includes("Pick your name, then sign in with your password.") &&
        !httpPage.text.includes("passkey or a password"),
      "status " + httpPage.status);
    // A passkey-only person meets the named case, not a box
    // that can never work (issue #144). The walk needs an
    // account holding no password at this point in the run —
    // the passkey-born account above has taken a password
    // back by now — so a fresh one is born here the same
    // way, by ceremony. The gate refuses its password post
    // before any password work, and no throttle failure is
    // noted for it.
    const mintGate = await a.call("POST", "/api/auth/invites",
      { name: "Drill Gate" });
    const codeGate = mintGate.json && mintGate.json.code;
    const authGate = makeAuthenticator();
    const oGate = await inviteOptions(codeGate, { name: "Drill Gate" });
    const vGate = await inviteVerify(codeGate,
      authGate.attestation(oGate.json.challenge));
    check("#144: a fresh passkey-born account stands for the gate walk",
      vGate.status === 200 && !!sessionCookieOf(vGate),
      "status " + vGate.status);
    const noPw = await raw(homeBase, "POST", "/login",
      { ...homeHost, "Content-Type": "application/x-www-form-urlencoded" },
      new URLSearchParams({ name: "Drill Gate", password: "anything-at-all-123" }).toString());
    check("#144: a password posted for a passkey-only account on the list door is refused with the case named",
      noPw.status === 302 &&
        (noPw.headers.location || "").includes("error=nopassword"),
      "status " + noPw.status + " location " + noPw.headers.location);
    const noPwPage = await raw(homeBase, "GET", "/login?error=nopassword", homeHost);
    check("#144: the refusal says the account signs in with a passkey and that this address cannot run one",
      noPwPage.status === 200 &&
        noPwPage.text.includes("That account signs in with a passkey") &&
        noPwPage.text.includes("it holds no password") &&
        noPwPage.text.includes("Passkeys need a secure address (HTTPS), so there is no way in at this address."),
      "status " + noPwPage.status);
  }

  // The reset form says beforehand that spending it signs
  // out every other sign-in (issue #146): a reset invite for
  // A, looked at and left unspent.
  const mintResetW3 = await a.call("POST", "/api/auth/invites", { name: NAME_A });
  const resetPageW3 = await raw(BASE, "GET", "/invite/" + (mintResetW3.json && mintResetW3.json.code), {});
  check("#146: the reset form carries the sign-out sentence before the act",
    resetPageW3.status === 200 &&
      resetPageW3.text.includes("Spending this link signs out every other sign-in for the account."),
    "status " + resetPageW3.status);

  // The invite page's closing note follows the door (issue
  // #155): a fresh invite's page, looked at and left unspent.
  const mintNoteW3 = await a.call("POST", "/api/auth/invites", { name: "Drill Note" });
  const notePageW3 = await raw(BASE, "GET", "/invite/" + (mintNoteW3.json && mintNoteW3.json.code), {});
  if (MODE === "worker") {
    check("#155: on the hosted door the closing note speaks of typing the name",
      notePageW3.status === 200 &&
        notePageW3.text.includes("The name above is the one you type to sign in with from then on.") &&
        !notePageW3.text.includes("sign-in list"),
      "status " + notePageW3.status);
  } else {
    check("#155: on the home door the closing note speaks of the sign-in list",
      notePageW3.status === 200 &&
        notePageW3.text.includes("The name above is the one on the sign-in list from then on."),
      "status " + notePageW3.status);
  }

  // Spend refusals name their actual reason (issue #147):
  // the four shapes are spread over the run's quiet corners
  // — one in the setup family, two in the #89 family above,
  // two at the very end of the drill — because every refused
  // press notes a throttle failure on the shared source, and
  // a handful together here would trip the source lock the
  // curves left warm and starve the claims family below.

  // The audit trail never carries a credential fragment
  // (issue #148): the passkey rows written by the families
  // above name the passkey by its nickname or not at all —
  // never by a slice of its credential id.
  const peopleW3 = await a.call("GET", "/api/auth/people");
  const credHeads = new Set();
  ((peopleW3.json && peopleW3.json.people) || []).forEach((p) => {
    (p.passkeys || []).forEach((pk) => {
      if (pk.id && pk.id.length > 12) credHeads.add(pk.id.slice(0, 12));
    });
  });
  const auditRowsW3 = (peopleW3.json && peopleW3.json.audit) || [];
  const fragmentRow = auditRowsW3.find((r) => r.detail && credHeads.has(r.detail));
  check("#148: no audit row's detail is a fragment of a credential id",
    peopleW3.status === 200 && !fragmentRow,
    fragmentRow ? "row " + JSON.stringify(fragmentRow) : "rows " + auditRowsW3.length);
  const namedPasskeyRow = auditRowsW3.find((r) => r.act === "passkey-added");
  check("#148: a passkey enrolment's audit row names the passkey by its nickname or not at all",
    !!namedPasskeyRow && (!namedPasskeyRow.detail || namedPasskeyRow.detail === "Second device"),
    namedPasskeyRow ? "detail " + JSON.stringify(namedPasskeyRow.detail) : "no passkey-added row");
}

// --- Claims, the defence budget and the stored hash (issue #109) ------------------
// The claim flow moves no data: a board set that stands
// unclaimed is inert — its keys answer 403 and the set shows
// on the administrator's list by shape only — until an
// administrator links it to an account; linking and
// reassigning change which account resolves to the set and
// nothing about the boards themselves. The full family needs
// a ghost set inserted into the data file, so it runs in
// self-host mode; on the Worker rig, where every account seeds
// its own set the moment it signs in, the family's light half
// checks that a fresh account stands linked and nothing waits
// unclaimed. The budget and stored-hash families likewise
// read and write the self-host data file.
{
  if (MODE === "worker") {
    const mintedC = await a.call("POST", "/api/auth/invites", { name: "Drill C" });
    const codeC = mintedC.json && mintedC.json.code;
    const spentC = await formPostRaw(BASE, "/invite/" + codeC,
      { name: "Drill C", password: "drill-c-own-password", confirm: "drill-c-own-password" });
    const cookieC = sessionCookieOf(spentC);
    const meC = cookieC
      ? await raw(BASE, "GET", "/api/auth/me", { Cookie: cookieC })
      : { status: 0, json: null };
    check("#109 claim: on the hosted copy a fresh account seeds and links its own set at once",
      !!cookieC && meC.status === 200 && meC.json.linked === true,
      "me " + meC.status + " linked " + (meC.json && meC.json.linked));
    const peopleC = await a.call("GET", "/api/auth/people");
    check("#109 claim: nothing stands unclaimed on the hosted copy",
      peopleC.status === 200 && (peopleC.json.unclaimed || []).length === 0,
      "unclaimed " + JSON.stringify((peopleC.json && peopleC.json.unclaimed) || null));
  }

  const cfgPath = args["server-config"] || null;
  if (MODE === "selfhost" && cfgPath) {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const file = join(dirname(cfgPath), String(cfg.dataDir || "data"), "tasksparkle.sqlite");
    const sha256 = (text) => createHash("sha256").update(text).digest("hex");

    // The ghost set: an owner row with a board and a card,
    // standing under an address no account claims, and a key.
    const GHOST_TITLE = "Ghost card — contents stay put";
    const rw = new DatabaseSync(file);
    const nowIso = new Date().toISOString();
    rw.prepare("INSERT INTO owners (id, email, name, name_guessed, theme, created_at) VALUES (?, ?, ?, 0, 'system', ?)")
      .run("owner_ghostdrill", "ghost@example.test", "Ghost", nowIso);
    rw.prepare("INSERT INTO boards (id, owner_id, name, position, created_at) VALUES (?, ?, ?, 0, ?)")
      .run("board_ghostdrill", "owner_ghostdrill", "Ghost Board", nowIso);
    rw.prepare("INSERT INTO \"columns\" (id, board_id, name, position) VALUES (?, ?, 'Inbox', 0)")
      .run("board_ghostdrill-inbox", "board_ghostdrill");
    rw.prepare("INSERT INTO cards (id, board_id, column_id, title, notes, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
      .run("card_ghostdrill", "board_ghostdrill", "board_ghostdrill-inbox", GHOST_TITLE,
        "ghost notes, byte for byte", nowIso, nowIso);
    rw.prepare("INSERT INTO api_tokens (id, owner_id, label, token_hash, last4, created_at) VALUES (?, ?, 'Ghost Key', ?, ?, ?)")
      .run("tok_ghostdrill", "owner_ghostdrill", sha256("ghost-drill-key"), "-key", nowIso);
    rw.close();

    let res = await raw(AGENT_BASE, "GET", "/api/v1/state",
      { Authorization: "Bearer ghost-drill-key" });
    check("#109 claim: an unclaimed set's key answers 403 — the set is inert until linked",
      res.status === 403, "status " + res.status);
    let people = await a.call("GET", "/api/auth/people");
    const ghostEntry = (people.json.unclaimed || [])
      .find((s) => s.ownerId === "owner_ghostdrill");
    check("#109 claim: the administrator's list names the set by shape — board names, card count, no address",
      !!ghostEntry && !("email" in ghostEntry) &&
        ghostEntry.boards.join(",") === "Ghost Board" && ghostEntry.cardCount === 1,
      JSON.stringify(ghostEntry || null));
    check("#109 claim: the list never carries a card's contents",
      !JSON.stringify(people.json.unclaimed || []).includes(GHOST_TITLE),
      "titles searched in the unclaimed list");

    // Person C arrives by invite and waits, unlinked.
    const mintedC = await a.call("POST", "/api/auth/invites", { name: "Drill C" });
    const spentC = await formPostRaw(BASE, "/invite/" + mintedC.json.code,
      { name: "Drill C", password: "drill-c-own-password", confirm: "drill-c-own-password" });
    const cookieC = sessionCookieOf(spentC);
    const cDoor = doorCallerFor(cookieC);
    const meC = await cDoor.call("GET", "/api/auth/me");
    check("#109 claim: while a set stands unclaimed a new account does not seed one of its own",
      meC.status === 200 && meC.json.linked === false,
      "linked " + (meC.json && meC.json.linked));
    const cState = await cDoor.call("GET", "/api/v1/state");
    check("#109 claim: the unlinked account reaches no boards",
      cState.status === 403, "status " + cState.status);
    const cProof = await cDoor.call("POST", "/api/auth/proof/password",
      { password: "drill-c-own-password" });
    check("#109 claim: the unlinked account's own sign-in writes still answer — a proof lands, no server error",
      cProof.status === 200, "status " + cProof.status);
    const cVersion = await cDoor.call("GET", "/api/v1/version");
    check("#109 claim: the unlinked account still reads the version — the app's first ask, carrying no boards",
      cVersion.status === 200 && typeof (cVersion.json && cVersion.json.version) === "number",
      "status " + cVersion.status);

    const claim = await a.call("POST", "/api/auth/claim",
      { owner_id: "owner_ghostdrill", account_key: "drill c" });
    check("#109 claim: the administrator links the ghost set to C",
      claim.status === 200, "status " + claim.status);
    const cState2 = await cDoor.call("GET", "/api/v1/state");
    const ghostCard = (cState2.json && cState2.json.cards || [])
      .find((c) => c.id === "card_ghostdrill");
    check("#109 claim: C now reads the set, its card's contents byte-identical — the claim moved no data",
      cState2.status === 200 && !!ghostCard && ghostCard.title === GHOST_TITLE &&
        ghostCard.notes === "ghost notes, byte for byte",
      "state " + cState2.status + " card " + JSON.stringify(ghostCard || null));
    res = await raw(AGENT_BASE, "GET", "/api/v1/state",
      { Authorization: "Bearer ghost-drill-key" });
    check("#109 claim: the set's key works from the moment it is linked",
      res.status === 200, "status " + res.status);

    // Reassignment: the set moves to B; B's own set is what
    // waits unclaimed then; both are put back before the
    // family ends. B reads through a fresh sign-in — the
    // reset family revoked the session the cached caller
    // still holds.
    let cookieBClaim = null;
    for (let i = 0; i < 12 && !cookieBClaim; i++) {
      const r = await formPostRaw(BASE, "/login", { name: NAME_B, password: PASSWORD_B });
      cookieBClaim = sessionCookieOf(r);
      if (!cookieBClaim) await new Promise((res2) => setTimeout(res2, 5000));
    }
    const bClaim = doorCallerFor(cookieBClaim);
    const reassign = await a.call("POST", "/api/auth/claim",
      { owner_id: "owner_ghostdrill", account_key: B });
    const bState = await bClaim.call("GET", "/api/v1/state");
    check("#109 claim: reassigned to B, the ghost board is B's to read",
      reassign.status === 200 && (bState.json.boards || [])
        .some((x) => x.id === "board_ghostdrill"),
      "status " + reassign.status);
    const cState3 = await cDoor.call("GET", "/api/v1/state");
    check("#109 claim: C is unlinked again after the reassignment",
      cState3.status === 403, "status " + cState3.status);
    people = await a.call("GET", "/api/auth/people");
    const bOwnSet = (people.json.unclaimed || []).find((s) => s.boards.includes("Personal"));
    check("#109 claim: B's own set is the one standing unclaimed now",
      !!bOwnSet, JSON.stringify((people.json.unclaimed || []).map((s) => s.boards)));
    const backB = await a.call("POST", "/api/auth/claim",
      { owner_id: bOwnSet.ownerId, account_key: B });
    const backC = await a.call("POST", "/api/auth/claim",
      { owner_id: "owner_ghostdrill", account_key: "drill c" });
    const bRestored = await bClaim.call("GET", "/api/v1/state");
    check("#109 claim: both sets are put back — B reads its own boards again",
      backB.status === 200 && backC.status === 200 &&
        (bRestored.json.boards || []).some((x) => x.name === "Personal") &&
        !(bRestored.json.boards || []).some((x) => x.id === "board_ghostdrill"),
      "status " + bRestored.status);
    people = await a.call("GET", "/api/auth/people");
    check("#109 claim: the claims stand in the sign-in record",
      (people.json.audit || []).some((r) => r.act === "claim") &&
        (people.json.audit || []).some((r) => r.act === "claim-reassigned"),
      "acts " + (people.json.audit || []).map((r) => r.act).join(","));
    check("#114: no address stands anywhere in the sign-in record",
      (people.json.audit || []).every((r) => !/@/.test(r.detail || "")),
      "details " + (people.json.audit || []).map((r) => r.detail).join(" | "));

    // -- The defence write budget, counted in the data file --
    const counts = () => {
      const ro = new DatabaseSync(file, { readOnly: true });
      const one = (sql) => ro.prepare(sql).get().n;
      const out = {
        throttle: one("SELECT COUNT(*) AS n FROM auth_throttle"),
        challenges: one("SELECT COUNT(*) AS n FROM auth_challenges"),
        sessions: one("SELECT COUNT(*) AS n FROM sessions"),
      };
      ro.close();
      return out;
    };
    const before = counts();
    for (let i = 0; i < 10; i++) {
      await formPostRaw(BASE, "/login", { name: "Budget Scratch", password: "not the password" });
    }
    const mid = counts();
    check("#109 budget: ten failed sign-ins add at most the two throttle rows and nothing else",
      mid.throttle - before.throttle <= 2 &&
        mid.challenges === before.challenges && mid.sessions === before.sessions,
      JSON.stringify({ before, mid }));
    for (let i = 0; i < 3; i++) {
      await formPostRaw(BASE, "/login", { name: "Budget Scratch", password: "not the password" });
    }
    const after = counts();
    check("#109 budget: refusals under a standing lock write no rows at all",
      after.throttle === mid.throttle && after.challenges === mid.challenges &&
        after.sessions === mid.sessions,
      JSON.stringify({ mid, after }));

    // -- A stored hash with refused parameters --
    const mintedH = await a.call("POST", "/api/auth/invites", { name: "Hash Scratch" });
    const spentH = await formPostRaw(BASE, "/invite/" + mintedH.json.code,
      { password: "hash-scratch-password", confirm: "hash-scratch-password" });
    check("#109 hash: the scratch account stands before its hash is poisoned",
      spentH.status === 302 && !!sessionCookieOf(spentH), "status " + spentH.status);
    const poison = (stored) => {
      const w = new DatabaseSync(file);
      w.prepare("UPDATE accounts SET password_hash = ? WHERE key = 'hash scratch'")
        .run(stored);
      w.close();
    };
    const hashLogin = async () => sessionCookieOf(await formPostRaw(BASE, "/login",
      { name: "Hash Scratch", password: "hash-scratch-password" }));
    const readHash = () => {
      const r = new DatabaseSync(file, { readOnly: true });
      const row = r.prepare("SELECT password_hash AS h FROM accounts WHERE key = 'hash scratch'").get();
      r.close();
      return row ? String(row.h) : "";
    };
    // The recorded fallback form still verifies — a chained
    // PBKDF2 row for the scratch password, built with the
    // shared code's own chain — and the proof rehashes it to
    // the current PHC scrypt form (the dispatch keys on the
    // full prefix, so a fallback row is never read as scrypt).
    const chainSalt = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6]);
    const chainOut = await pbkdf2Chain("hash-scratch-password", chainSalt, 100000, 6);
    poison("pbkdf2-sha256$100000x6$" +
      Buffer.from(chainSalt).toString("base64") + "$" +
      Buffer.from(chainOut).toString("base64"));
    let hashTry = await hashLogin();
    check("#109 hash: a chained-PBKDF2 row still verifies through the fallback dispatch",
      !!hashTry, "cookie " + !!hashTry);
    check("#109 hash: the fallback proof rehashes the row to the current PHC scrypt form",
      readHash().startsWith("$scrypt$ln=15,r=8,p=3$"),
      "stored: " + readHash().split("$").slice(0, 3).join("$"));
    poison("pbkdf2-sha256$0x6$AAAA$AAAA");
    hashTry = await hashLogin();
    check("#109 hash: a stored hash with zero rounds is refused, never run",
      !hashTry, "cookie " + !!hashTry);
    poison("pbkdf2-sha256$99999999x99$AAAA$AAAA");
    hashTry = await hashLogin();
    check("#109 hash: a stored hash with absurd parameters is refused the same way",
      !hashTry, "cookie " + !!hashTry);
    poison("pbkdf2-sha256$100000$AAAA$AAAA");
    hashTry = await hashLogin();
    check("#109 hash: a stored hash with no chain marker is refused too",
      !hashTry, "cookie " + !!hashTry);
    // The current form's own refused parameters. Three pair
    // failures above started the pair lock; wait it out so
    // these refusals are the hash's own, not the lock's.
    await new Promise((r) => setTimeout(r, 11000));
    poison("$scrypt$ln=0,r=8,p=3$AAAA$AAAA");
    hashTry = await hashLogin();
    check("#109 hash: a PHC row with zero cost is refused, never run",
      !hashTry, "cookie " + !!hashTry);
    poison("$scrypt$ln=99,r=8,p=3$AAAA$AAAA");
    hashTry = await hashLogin();
    check("#109 hash: a PHC row with absurd cost is refused the same way",
      !hashTry, "cookie " + !!hashTry);
    poison("$scrypt$ln=15,r=8,p=0$AAAA$AAAA");
    hashTry = await hashLogin();
    check("#109 hash: a PHC row with zero parallelism is refused too",
      !hashTry, "cookie " + !!hashTry);
  }
}

// A door caller for the claim family above, defined at module
// scope because the family block is a sibling of the sign-in
// family's own helper: same jar behaviour.
function doorCallerFor(cookie) {
  const headers = { Cookie: cookie || "" };
  return {
    headers,
    async call(method, path, body, extra) {
      const h = { ...headers, ...(extra || {}) };
      let payload = null;
      if (body != null) {
        h["Content-Type"] = "application/json";
        payload = typeof body === "string" ? body : JSON.stringify(body);
      }
      const res = await raw(BASE, method, path, h, payload);
      const rotated = sessionCookieOf(res);
      if (rotated) headers.Cookie = rotated;
      return res;
    },
  };
}

// --- Erasure: a person deletes themselves (issues #57, #92) ----------------------
// The last family on purpose: person B erases themselves here,
// and nothing after this may need B standing. B arrives with a
// board holding a card with a step, a link and two comments
// (their own and their key's), and a key of their own. The
// checks: the write gate names an unknown field on this route
// too; a key calling the route gets a 403 and B survives it
// whole; the person's own call answers 200 and expires their
// session cookie in the answer (the #49 shape); afterwards B's
// key is dead (401), every row that was B's is gone (the whole
// owner cascade, counted table by table in the self-host data
// file), B's old password signs nobody in, and a fresh start
// for B — a new sign-in on the Worker rig, a new invite on a
// self-host — begins from the seed, because the data does not
// come back. Person A's version does not move for any of it.
// The directions checks ride along: they carry the erasure
// truth (issue #57) and no longer tell an agent to read a
// change stamp off a key's answers (issue #92).
{
  // B's cached caller still holds the session the sign-in
  // family's reset revoked, so B signs in fresh for this
  // family and works through that caller throughout.
  let cookieBErase = null;
  for (let i = 0; i < 12 && !cookieBErase; i++) {
    const r0 = await formPostRaw(BASE, "/login", { name: NAME_B, password: PASSWORD_B });
    cookieBErase = sessionCookieOf(r0);
    if (!cookieBErase) await new Promise((r) => setTimeout(r, 5000));
  }
  const bFresh = doorCallerFor(cookieBErase);
  stB = await state(bFresh);
  const eraseBoard = boardByName(stB, "Personal");
  const bOwnerId = stB.me.id;
  res = await bFresh.call("POST", "/api/v1/cards",
    { board_id: eraseBoard.id, column_id: "inbox", title: "Erasure drill card" });
  const eraseCardId = res.json.card.id;
  await bFresh.call("POST", "/api/v1/cards/" + eraseCardId + "/steps", { text: "a step to erase" });
  await bFresh.call("POST", "/api/v1/cards/" + eraseCardId + "/links", { url: "example.com/erase", name: "a link to erase" });
  await bFresh.call("POST", "/api/v1/cards/" + eraseCardId + "/comments", { body: "B's own comment" });
  res = await bFresh.call("POST", "/api/v1/me/token", { name: "Erasure Key" });
  const bKey = res.json.key;
  res = await raw(AGENT_BASE, "POST", "/api/v1/cards/" + eraseCardId + "/comments", {
    Authorization: "Bearer " + bKey, "Content-Type": "application/json",
  }, JSON.stringify({ body: "the key's comment" }));
  check("#57 setup: B's card holds their own comment and their key's",
    res.status === 201, "status " + res.status);
  // A fresh key for A: the doors section's key was revoked by
  // the creators family above, and the directions are read
  // through a key, as an agent reads them.
  res = await a.call("POST", "/api/v1/me/token", { name: "Erasure Directions Key" });
  const aKey = res.json.key;
  res = await a.agentCall("GET", "/api/v1/directions", aKey);
  check("#57: the directions say a person can delete their own boards and account, and name the 14 days",
    res.status === 200 && res.text.includes("delete their own boards and account") &&
      res.text.includes("14 days"),
    "directions read, " + (res.text || "").length + " chars");
  check("#92: the directions carry no instruction to read a change stamp off a key's answers",
    res.status === 200 && !res.text.includes("carries the stamp of the latest change") &&
      !res.text.includes("by reads \"owner\"") && !res.text.includes("the stamp's by"),
    "stale stamp wording searched");
  const watching = res.text.slice(res.text.indexOf("Watching for changes"));
  check("#92: the watching passage teaches stamp attribution off the work itself",
    watching.includes("creatorKeyName") && watching.includes("authorKeyName") &&
      watching.includes("carry no stamp"),
    "watching passage checked");

  // A's version, read only now: the key mint above is A's own
  // write and rightly moves it; B's erasure must not.
  const aVersionBefore = (await a.call("GET", "/api/v1/version")).json.version;
  res = await bFresh.call("DELETE", "/api/v1/me", { nope: 1 });
  check("#57: the write gate names an unknown field on the delete route too",
    res.status === 400 && /nope/.test(res.json.error || ""), res.json && res.json.error);
  res = await raw(AGENT_BASE, "DELETE", "/api/v1/me", {
    Authorization: "Bearer " + bKey, "Content-Type": "application/json",
  }, "{}");
  check("#57: a key calling DELETE /me gets a 403 — a key can never erase its owner",
    res.status === 403, "status " + res.status);
  stB = await state(bFresh);
  check("#57: B stands whole after the key's attempt",
    (stB.cards || []).some((c) => c.id === eraseCardId), "B cards: " + (stB.cards || []).length);
  res = await b.agentCall("GET", "/api/v1/state", bKey);
  check("#57: B's key still works after its own erasure attempt",
    res.status === 200, "status " + res.status);

  res = await bFresh.call("DELETE", "/api/v1/me");
  check("#57: the person's own DELETE /me answers 200",
    res.status === 200 && res.json && res.json.ok === true,
    "status " + res.status + " body " + res.text.slice(0, 80));
  const expiry = (res.headers["set-cookie"] || []).join(" ");
  check("#57: the answer expires the session cookie (the #49 shape)",
    /ts_session=;/.test(expiry) && /Expires=Thu, 01 Jan 1970/.test(expiry),
    "set-cookie: " + expiry);

  res = await b.agentCall("GET", "/api/v1/state", bKey);
  check("#57: B's key is dead from the same act (401)",
    res.status === 401, "status " + res.status);

  if (MODE === "selfhost") {
    const cfgPath = args["server-config"] || null;
    let cfgE = null;
    if (cfgPath) {
      try { cfgE = JSON.parse(readFileSync(cfgPath, "utf8")); } catch (e) { /* named below */ }
    }
    const fileE = cfgE
      ? join(dirname(cfgPath), String(cfgE.dataDir || "data"), "tasksparkle.sqlite")
      : null;
    const counts = {};
    if (fileE) {
      const ro = new DatabaseSync(fileE, { readOnly: true });
      const byOwner = (sql) => ro.prepare(sql).get(bOwnerId).n;
      counts.owners = byOwner("SELECT COUNT(*) AS n FROM owners WHERE id = ?");
      counts.tokens = byOwner("SELECT COUNT(*) AS n FROM api_tokens WHERE owner_id = ?");
      counts.boards = byOwner("SELECT COUNT(*) AS n FROM boards WHERE owner_id = ?");
      const viaBoard = (table, extra) =>
        byOwner("SELECT COUNT(*) AS n FROM " + table +
          " JOIN boards ON boards.id = " + extra + " WHERE boards.owner_id = ?");
      counts.columns = viaBoard('"columns"', '"columns".board_id');
      counts.labels = viaBoard("labels", "labels.board_id");
      counts.projects = viaBoard("projects", "projects.board_id");
      counts.cards = viaBoard("cards", "cards.board_id");
      const viaCard = (table) => ro.prepare(
        "SELECT COUNT(*) AS n FROM " + table + " JOIN cards ON cards.id = " + table + ".card_id " +
        "JOIN boards ON boards.id = cards.board_id WHERE boards.owner_id = ?").get(bOwnerId).n;
      counts.steps = viaCard("checklist_items");
      counts.links = viaCard("card_links");
      counts.comments = viaCard("card_comments");
      counts.cardLabels = viaCard("card_labels");
      counts.passwords = ro.prepare("SELECT COUNT(*) AS n FROM accounts WHERE key = ?").get(B).n;
      counts.invites = ro.prepare("SELECT COUNT(*) AS n FROM invites WHERE key = ?").get(B).n;
      counts.aBoards = ro.prepare(
        "SELECT COUNT(*) AS n FROM boards JOIN owners ON owners.id = boards.owner_id WHERE owners.email = ?"
      ).get(A).n;
      ro.close();
    }
    const goneTables = ["owners", "tokens", "boards", "columns", "labels", "projects",
      "cards", "steps", "links", "comments", "cardLabels", "passwords", "invites"];
    check("#57: every row that was B's is gone, in every table of the cascade",
      !!fileE && goneTables.every((t) => counts[t] === 0),
      JSON.stringify(counts));
    check("#57: person A's rows stand untouched in the same file",
      !!fileE && counts.aBoards >= 2, "A boards: " + counts.aBoards);

    const loginTry = await raw(BASE, "POST", "/login",
      { "Content-Type": "application/x-www-form-urlencoded" },
      new URLSearchParams({ name: NAME_B, password: PASSWORD_B }).toString());
    check("#57: B's old password signs nobody in after the erasure",
      loginTry.status === 302 &&
        !(loginTry.headers["set-cookie"] || []).some((c) => c.startsWith("ts_session=")) &&
        (loginTry.headers.location || "").includes("error=1"),
      "status " + loginTry.status + " location " + loginTry.headers.location);
  }

  const aVersionAfter = (await a.call("GET", "/api/v1/version")).json.version;
  check("#57: person A's version does not move for B's erasure",
    aVersionAfter === aVersionBefore, "before " + aVersionBefore + " after " + aVersionAfter);
  stA = await state(a);
  check("#57: person A's boards and cards stand as they were",
    (stA.cards || []).some((c) => c.id === cardId), "A cards: " + (stA.cards || []).length);

  // A fresh start begins from the seed: the erased data does
  // not come back, on either home. On the hosted copy the fresh
  // start is a fresh invite from A — the erasure took B's
  // account too, and the old door is frozen, so no sign-in of
  // B's can seed anything by itself.
  if (MODE === "worker") {
    res = await accessCall(B, "Drill B", "GET", "/api/v1/state");
    check("#57: B's old-door token seeds nothing after the erasure (the door is frozen)",
      res.status === 403, "status " + res.status);
    const mintedFresh = await a.call("POST", "/api/auth/invites", { name: NAME_B });
    const freshCode = mintedFresh.json && mintedFresh.json.code;
    const fresh = await formPostRaw(BASE, "/invite/" + freshCode,
      { name: NAME_B, password: "drill-b-fresh-password", confirm: "drill-b-fresh-password" });
    const freshCookie = sessionCookieOf(fresh);
    res = await raw(BASE, "GET", "/api/v1/state", { Cookie: freshCookie || "" });
    check("#57: a fresh invite starts B from the seed — the erased boards do not come back",
      fresh.status === 302 && res.status === 200 && res.json.version === 0 &&
        res.json.boards.length === 2 && (res.json.cards || []).length === 0,
      "redeem " + fresh.status + " state " + res.status + " version " +
        (res.json && res.json.version) + " boards " +
        (res.json && res.json.boards && res.json.boards.length));
    res = await b.agentCall("GET", "/api/v1/state", bKey);
    check("#57: B's old key stays dead even after the fresh start",
      res.status === 401, "status " + res.status);
  } else {
    const cfgPath2 = args["server-config"] || null;
    if (cfgPath2) {
      const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "server.mjs");
      const out = execFileSync(process.execPath,
        [serverPath, "--config", cfgPath2, "--invite", NAME_B], { encoding: "utf8" });
      const m = out.match(/\/invite\/([A-Za-z0-9_-]+)/);
      const fresh = await raw(BASE, "POST", "/invite/" + (m ? m[1] : "none"),
        { "Content-Type": "application/x-www-form-urlencoded" },
        new URLSearchParams({ password: "drill-b-fresh-password", confirm: "drill-b-fresh-password" }).toString());
      const freshCookie = (fresh.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
      res = await raw(BASE, "GET", "/api/v1/state", { Cookie: freshCookie });
      check("#57: a fresh invite starts B from the seed — the erased boards do not come back",
        fresh.status === 302 && res.status === 200 && res.json.version === 0 &&
          res.json.boards.length === 2 && (res.json.cards || []).length === 0,
        "redeem " + fresh.status + " state " + res.status + " version " +
          (res.json && res.json.version) + " boards " +
          (res.json && res.json.boards && res.json.boards.length));
    }
  }
}

// --- Feedback: a deployment setting (issue #22) ------------------------------
// The feedback target is the deployment's setting, never the
// product's default, and no caller is involved: the site
// answer and the submit route answer visitors. Off (the
// state every standing copy stands in until its operator
// sets a target): the site answer says no target stands and
// the submit route answers not found. On: the note a visitor
// posts lands on the target whole — the same JSON, the
// copy's own origin named — and the target's answer is
// relayed as it stood.
{
  const FEEDBACK_ON = args.feedback === "on";
  const site = await raw(BASE, "GET", "/api/site", {});
  check("#22: the site answer names whether a feedback target stands",
    site.status === 200 && !!site.json && site.json.feedback === FEEDBACK_ON,
    "status " + site.status + " body " + site.text);
  const noteBody = JSON.stringify({
    service: "tasksparkle", type: "other",
    fields: { message: "A drill note.", page: "/feedback" },
    website: "", openedAt: 1234567890,
  });
  const noteHeaders = { "Content-Type": "application/json", Origin: new URL(BASE).origin };
  if (!FEEDBACK_ON) {
    const post = await raw(BASE, "POST", "/api/feedback", noteHeaders, noteBody);
    check("#22: with no target set the submit route answers not found",
      post.status === 404, "status " + post.status + " body " + post.text);
  } else {
    let fbSeen = null;
    const standin = httpCreateServer((req, res) => {
      let text = "";
      req.on("data", (c) => (text += c));
      req.on("end", () => {
        fbSeen = { method: req.method, url: req.url, origin: req.headers.origin || "", body: text };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((resolve) => standin.listen(8795, "127.0.0.1", resolve));
    try {
      const post = await raw(BASE, "POST", "/api/feedback", noteHeaders, noteBody);
      check("#22: with a target set the submit route relays the target's answer",
        post.status === 200 && !!post.json && post.json.ok === true,
        "status " + post.status + " body " + post.text);
      check("#22: the note reached the target whole, under the copy's own origin",
        !!fbSeen && fbSeen.method === "POST" && fbSeen.url === "/api/submit" &&
          fbSeen.origin === new URL(BASE).origin && fbSeen.body === noteBody,
        fbSeen ? fbSeen.method + " " + fbSeen.url + " origin " + fbSeen.origin : "the target saw nothing");
    } finally {
      standin.close();
    }
  }
}

// --- The last two spend-refusal shapes (issue #147) ---------------------------
// A common password and the account's own name are refused
// as themselves, not as a generic failure. The presses ride
// at the very end of the drill on purpose: each one notes a
// throttle failure on the shared source, and here no family
// follows that the notes could starve. (The mismatch and
// length shapes stand in the #89 family and the setup
// family.) Each refusal leaves its invite unspent.
const refusalEnd = async (name, password, confirm) => {
  const mint = await a.call("POST", "/api/auth/invites", { name });
  const code = mint.json && mint.json.code;
  return formPostRaw(BASE, "/invite/" + code, { password, confirm });
};
const rCommonEnd = await refusalEnd("Drill Refusal Three", "motherfucker", "motherfucker");
check("#147: a common password is refused as common",
  rCommonEnd.status === 302 &&
    (rCommonEnd.headers.location || "").includes("error=pwcommon"),
  "status " + rCommonEnd.status + " location " + rCommonEnd.headers.location);
const rNameEnd = await refusalEnd("Drill Refusal Four",
  "drill refusal four", "drill refusal four");
check("#147: the account's own name is refused as the name",
  rNameEnd.status === 302 &&
    (rNameEnd.headers.location || "").includes("error=pwname"),
  "status " + rNameEnd.status + " location " + rNameEnd.headers.location);

console.log(count + " checks, " + failures + " failures");
process.exit(failures === 0 ? 0 : 1);
