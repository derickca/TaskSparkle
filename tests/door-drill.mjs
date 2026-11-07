// TaskSparkle door drill: the sign-up door, drilled in both
// homes' shapes.
//
//     node tests/door-drill.mjs
//         Self-host mode: starts throwaway instances with
//         throwaway configs in a scratch folder — never a real
//         config, never real data — and walks the door there.
//     node tests/door-drill.mjs --mode worker \
//         --base https://localhost:8792 \
//         --setup-code rig-setup-code --rig-dir <the rig folder>
//         Worker mode: walks the door on a FRESH Worker rig
//         (tests/README.md, the rig run book), where the
//         country gate and the bot check stand configured the
//         hosted way — the gate covering Canada and the United
//         States, the check answered by the rig's own stub
//         verifier. The rig must stand fresh: the drill makes
//         the first account itself, through the setup page.
//
// What the drill proves, in each shape:
//
// - the switch stands at invite-only until it is flipped:
//   the sign-in page carries no creation entry, the sign-up
//   page answers with the invite-only words, a creation press
//   makes no account, and an invite still creates — invites
//   are untouched by the door in every state.
// - flipped open, the door creates: by the password way, and
//   by the passkey ceremony, where the rig's address allows
//   one — and the new account lands on its own seeded boards.
// - flipped closed, the door refuses again, in the closed
//   words, and invites still create.
// - the creation pace: a handful of creations per source
//   address per hour; the next is refused, and a failed bot
//   check spends the pace like a landed creation does.
// - where the gate stands (Worker mode, and the second
//   self-host instance): a creation whose country reads
//   outside the list is refused, Canada and the United
//   States create, an address with no country read is
//   refused — and sign-in is never gated: an account signs
//   in from a refused country without trouble.
// - where the bot check stands (the same shapes): no token
//   and a wrong token both refuse the creation before any
//   account row stands; the rig's passing token creates.
// - where neither stands (the first self-host instance):
//   the page carries no widget and creations need no token,
//   and no country is read or asked for.
//
// The switch is flipped the operator's way in each shape:
// a stored value the door route reads — written straight
// into the instance's data file here, and into the rig's
// local auth database with wrangler in Worker mode.
import { spawn, execFileSync } from "node:child_process";
import { createServer as httpServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { encodeCBOR } from "../worker/auth.js";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
}
const MODE = args.mode || "selfhost";
const SETUP_CODE = args["setup-code"] || "";
const RIG_DIR = args["rig-dir"] || "";
if (MODE === "worker" && (!args.base || !SETUP_CODE || !RIG_DIR)) {
  console.error("usage: --mode worker needs --base, --setup-code and --rig-dir; see the header");
  process.exit(2);
}
if (MODE !== "worker" && MODE !== "selfhost") {
  console.error("unknown mode: " + MODE);
  process.exit(2);
}

const PW = "door-drill-password";
let failures = 0;
let count = 0;
function check(name, cond, detail) {
  count += 1;
  if (!cond) failures += 1;
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail ? "  — " + detail : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- HTTP helpers (the API drill's raw shape) ----------------

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

const sessionCookieOf = (res) => {
  const found = (res.headers["set-cookie"] || [])
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("ts_session=") && c.length > "ts_session=".length);
  return found || null;
};

function jar() {
  let cookie = null;
  return {
    absorb(res) {
      const found = sessionCookieOf(res);
      if (found) cookie = found;
      return cookie;
    },
    get cookie() { return cookie; },
    headers() { return cookie ? { Cookie: cookie } : {}; },
  };
}

const formPost = (base, path, fields, opts) => {
  opts = opts || {};
  return raw(base, "POST", path, {
    "Content-Type": "application/x-www-form-urlencoded",
    ...(opts.jar ? opts.jar.headers() : {}),
    ...(opts.headers || {}),
  }, new URLSearchParams(fields).toString());
};
const jsonPost = (base, path, body, opts) => {
  opts = opts || {};
  return raw(base, "POST", path, {
    "Content-Type": "application/json",
    ...(opts.jar ? opts.jar.headers() : {}),
    ...(opts.headers || {}),
  }, JSON.stringify(body || {}));
};
const getPage = (base, path, opts) => {
  opts = opts || {};
  return raw(base, "GET", path, {
    ...(opts.jar ? opts.jar.headers() : {}),
    ...(opts.headers || {}),
  }, null);
};

async function boardsStand(base, j) {
  const res = await raw(base, "GET", "/api/v1/state", j.headers(), null);
  return res.status === 200 && !!res.json && Array.isArray(res.json.boards) &&
    res.json.boards.some((b) => b.name === "Personal");
}

async function signIn(base, name, password, headers) {
  const j = jar();
  j.absorb(await formPost(base, "/login", { name, password }, { headers }));
  return j;
}

// An account stands when its name and password sign in; a
// refused creation leaves a name that cannot.
async function accountStands(base, name, password, headers) {
  const j = await signIn(base, name, password, headers);
  return !!j.cookie;
}

async function inviteCreates(base, adminJar, name) {
  const minted = await jsonPost(base, "/api/auth/invites", { name }, { jar: adminJar });
  const code = minted.json && minted.json.code;
  if (!code) return null;
  const j = jar();
  j.absorb(await formPost(base, "/invite/" + code,
    { name, password: PW, confirm: PW }));
  return j.cookie ? j : null;
}

// A software authenticator (the API drill's shape): one
// honestly built credential for the ceremony walks.
const b64uDrill = (buf) => Buffer.from(buf).toString("base64url");
const b64uDrillToBuf = (text) => Buffer.from(text, "base64url");
function makeAuthenticator(origin, rpId) {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const credId = randomBytes(16);
  let counter = 0;
  const cose = encodeCBOR(new Map([
    [1, 2], [3, -7], [-1, 1], [-2, b64uDrillToBuf(jwk.x)], [-3, b64uDrillToBuf(jwk.y)],
  ]));
  const rpHash = createHash("sha256").update(rpId).digest();
  function attestation(challenge) {
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
        clientDataJSON: b64uDrill(Buffer.from(JSON.stringify({
          type: "webauthn.create", challenge, origin, crossOrigin: false,
        }))),
        attestationObject: b64uDrill(attObj),
        transports: ["internal"],
      },
    };
  }
  return { credIdB64u: b64uDrill(credId), attestation };
}

// The door's ceremony, end to end: options, one attestation,
// verify. Answers the verify response; the caller's jar
// absorbs its session cookie on a landing.
async function ceremony(base, j, fields, opts) {
  const options = await jsonPost(base, "/signup/passkey/options", fields, opts);
  if (options.status !== 200) return options;
  const url = new URL(base);
  const auth = makeAuthenticator(url.origin, url.hostname);
  const cred = auth.attestation(options.json.challenge);
  const verify = await jsonPost(base, "/signup/passkey/verify", { response: cred }, opts);
  if (j) j.absorb(verify);
  return verify;
}

// The door at rest: the switch's default posture, walked the
// same way in every shape. `press` carries whatever extra
// fields and headers the shape's configured gate and check
// would accept, so the switch alone is what refuses.
async function walkDefaultPosture(base, adminJar, press) {
  press = press || {};
  const login = await getPage(base, "/login");
  check("door: at the default the sign-in page carries no creation entry",
    login.status === 200 && !login.text.includes('href="/signup"') &&
      !login.text.includes("Create your account"),
    "status " + login.status);
  const page = await getPage(base, "/signup", press);
  check("door: at the default the sign-up page answers with the invite-only words",
    page.status === 200 && page.text.includes("Sign-up is not open on this copy.") &&
      !page.text.includes('action="/signup"'),
    "status " + page.status);
  const refused = await formPost(base, "/signup",
    { name: "Door Early", password: PW, confirm: PW, ...(press.fields || {}) }, press);
  check("door: at the default a creation press is turned back to the sign-up page",
    refused.status === 302 && (refused.headers.location || "") === "/signup" &&
      !sessionCookieOf(refused),
    "status " + refused.status + " location " + refused.headers.location);
  check("door: and it made no account",
    !(await accountStands(base, "Door Early", PW)));
  const options = await jsonPost(base, "/signup/passkey/options",
    { name: "Door Early", ...(press.fields || {}) }, press);
  check("door: at the default the ceremony is refused in the same words",
    options.status === 400 && !!options.json &&
      options.json.error === "Sign-up is not open on this copy.",
    "status " + options.status);
  const invited = await inviteCreates(base, adminJar, "Door Invited");
  check("door: an invite still creates while the switch stands at invite-only",
    !!invited && (await boardsStand(base, invited)));
}

// The door closed: the same refusal in the closed words, and
// invites still creating.
async function walkClosed(base, adminJar, press) {
  press = press || {};
  const page = await getPage(base, "/signup", press);
  check("door: closed, the sign-up page answers with the closed words",
    page.status === 200 && page.text.includes("Sign-up is closed on this copy."),
    "status " + page.status);
  const refused = await formPost(base, "/signup",
    { name: "Door Closed", password: PW, confirm: PW, ...(press.fields || {}) }, press);
  check("door: closed, a creation press is turned back and makes no account",
    refused.status === 302 && (refused.headers.location || "") === "/signup" &&
      !(await accountStands(base, "Door Closed", PW)),
    "status " + refused.status);
  const invited = await inviteCreates(base, adminJar, "Door Invited Closed");
  check("door: an invite still creates while the switch stands at closed",
    !!invited && (await boardsStand(base, invited)));
}

// --- Self-host mode ------------------------------------------------

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "server.mjs");
const scratch = MODE === "selfhost" ? mkdtempSync(join(tmpdir(), "ts-door-drill-")) : null;
let nextPort = 8951;
const handles = [];

function writeConfig(name, fields) {
  const path = join(scratch, name);
  writeFileSync(path, JSON.stringify({
    port: nextPort,
    dataDir: "data-" + name.replace(/\W/g, ""),
    sessionSecret: "door-drill-secret-0123456789abcdef",
    agentHost: "localhost:" + nextPort,
    host: "127.0.0.1",
    ...fields,
  }, null, 2) + "\n");
  nextPort += 1;
  return path;
}

function startServer(configPath) {
  return new Promise((resolveStart) => {
    const child = spawn(process.execPath, [SERVER, "--config", configPath],
      { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    let exited = null;
    child.stdout.on("data", (c) => (log += c));
    child.stderr.on("data", (c) => (log += c));
    child.on("exit", (code) => { exited = code; });
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (log.includes("running at") || exited !== null || Date.now() - startedAt > 8000) {
        clearInterval(timer);
        const handle = { child, log: () => log, exited: () => exited };
        handles.push(handle);
        resolveStart(handle);
      }
    }, 50);
  });
}

async function stopServer(handle) {
  if (handle.exited() !== null) return;
  handle.child.kill("SIGTERM");
  for (let i = 0; i < 40 && handle.exited() === null; i++) await sleep(100);
  if (handle.exited() === null) handle.child.kill("SIGKILL");
}

function dbFileOf(configPath, name) {
  return join(scratch, "data-" + name.replace(/\W/g, ""), "tasksparkle.sqlite");
}

// The operator's flip, written the way the operations guide
// writes it: one stored value in the auth bookkeeping. The
// running server reads it on the next door request.
async function flipDoorFile(dbFile, value) {
  let lastErr = null;
  for (let i = 0; i < 25; i++) {
    try {
      const db = new DatabaseSync(dbFile);
      try {
        if (value == null) {
          db.prepare("DELETE FROM auth_meta WHERE key = 'door'").run();
        } else {
          db.prepare(
            "INSERT INTO auth_meta (key, value) VALUES ('door', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
          ).run(value);
        }
      } finally { db.close(); }
      return;
    } catch (e) {
      lastErr = e; // the server's own write holds the file for a moment
      await sleep(100);
    }
  }
  throw lastErr;
}

async function setupAdmin(base) {
  const j = jar();
  j.absorb(await formPost(base, "/setup",
    { name: "Door Admin", password: PW, confirm: PW }));
  return j;
}

async function selfhostPlain() {
  const cfgPath = writeConfig("plain.json", {});
  const port = nextPort - 1;
  const base = "http://127.0.0.1:" + port;
  const dbFile = dbFileOf(cfgPath, "plain.json");
  await startServer(cfgPath);
  const admin = await setupAdmin(base);
  check("door (home): the setup page made the first account",
    !!admin.cookie && (await boardsStand(base, admin)));

  await walkDefaultPosture(base, admin);

  await flipDoorFile(dbFile, 1);
  const login = await getPage(base, "/login");
  check("door (home): open, the sign-in page carries the creation entry",
    login.status === 200 && login.text.includes('href="/signup"') &&
      login.text.includes("Create your account"),
    "status " + login.status);
  const page = await getPage(base, "/signup");
  check("door (home): open, the sign-up page stands with no bot-check widget " +
      "and no country asked — neither stands configured on this copy",
    page.status === 200 && page.text.includes('action="/signup"') &&
      !page.text.includes('class="cf-turnstile"'),
    "status " + page.status);
  const made = jar();
  made.absorb(await formPost(base, "/signup",
    { name: "Door Open", password: PW, confirm: PW }));
  check("door (home): open, the password way creates and signs in",
    !!made.cookie && (await boardsStand(base, made)));
  const dup = await formPost(base, "/signup",
    { name: "Door Open", password: PW, confirm: PW });
  check("door (home): a name an account holds is refused, in the name's own words",
    dup.status === 302 && (dup.headers.location || "") === "/signup?error=name",
    "status " + dup.status + " location " + dup.headers.location);
  const keyJar = jar();
  const verified = await ceremony(base, keyJar, { name: "Door Key" });
  check("door (home): open, the passkey way creates and signs in",
    verified.status === 200 && !!keyJar.cookie && (await boardsStand(base, keyJar)),
    "status " + verified.status);

  await flipDoorFile(dbFile, 2);
  await walkClosed(base, admin);

  await flipDoorFile(dbFile, 1);
  for (const name of ["Door Three", "Door Four"]) {
    const j = jar();
    j.absorb(await formPost(base, "/signup", { name, password: PW, confirm: PW }));
    check("door (home): creation " + name + " lands inside the hour's pace",
      !!j.cookie);
  }
  const sixth = await formPost(base, "/signup",
    { name: "Door Six", password: PW, confirm: PW });
  check("door (home): the creation past the hour's pace is refused",
    sixth.status === 302 &&
      (sixth.headers.location || "") === "/signup?error=toomany" &&
      !(await accountStands(base, "Door Six", PW)),
    "status " + sixth.status + " location " + sixth.headers.location);
}

async function selfhostGated() {
  // The stub verifier stands in for the bot check's own
  // endpoint: it passes only the drill's secret and the
  // token "pass-token", the certs server's shape on the rig.
  const stub = httpServer((req, res) => {
    if (req.url === "/siteverify" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const form = new URLSearchParams(body);
        const ok = form.get("secret") === "door-drill-secret" &&
          form.get("response") === "pass-token";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: ok }));
      });
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const stubPort = stub.address().port;
  try {
    const cfgPath = writeConfig("gated.json", {
      signupCountries: ["CA", "US"],
      turnstileSiteKey: "door-drill-site-key",
      turnstileSecretKey: "door-drill-secret",
      turnstileVerifyUrl: "http://127.0.0.1:" + stubPort + "/siteverify",
    });
    const port = nextPort - 1;
    const base = "http://127.0.0.1:" + port;
    const dbFile = dbFileOf(cfgPath, "gated.json");
    await startServer(cfgPath);
    const admin = await setupAdmin(base);
    check("door (home, gate and check configured): the setup page made the first account",
      !!admin.cookie && (await boardsStand(base, admin)));
    await flipDoorFile(dbFile, 1);

    const CA = { headers: { "CF-IPCountry": "CA" } };
    const US = { headers: { "CF-IPCountry": "US" } };
    const FR = { headers: { "CF-IPCountry": "FR" } };
    const PASS = { "cf-turnstile-response": "pass-token" };

    const noCountry = await getPage(base, "/signup");
    check("door (gated): with no country read, the sign-up page is the gate's page",
      noCountry.status === 200 &&
        noCountry.text.includes("Sign-up is open to Canada and the United States for now.") &&
        !noCountry.text.includes('action="/signup"'),
      "status " + noCountry.status);
    const france = await formPost(base, "/signup",
      { name: "Door France", password: PW, confirm: PW, ...PASS }, FR);
    check("door (gated): a creation from outside the list is refused and makes no account",
      france.status === 302 && (france.headers.location || "") === "/signup" &&
        !(await accountStands(base, "Door France", PW)),
      "status " + france.status);
    const canada = jar();
    canada.absorb(await formPost(base, "/signup",
      { name: "Door Canada", password: PW, confirm: PW, ...PASS }, CA));
    check("door (gated): a creation from Canada lands, on its own boards",
      !!canada.cookie && (await boardsStand(base, canada)));
    const states = jar();
    states.absorb(await formPost(base, "/signup",
      { name: "Door States", password: PW, confirm: PW, ...PASS }, US));
    check("door (gated): a creation from the United States lands",
      !!states.cookie && (await boardsStand(base, states)));
    const botless = await formPost(base, "/signup",
      { name: "Door Botless", password: PW, confirm: PW }, CA);
    check("door (gated): no bot-check token refuses the creation, before any account stands",
      botless.status === 302 &&
        (botless.headers.location || "") === "/signup?error=bot" &&
        !(await accountStands(base, "Door Botless", PW)),
      "status " + botless.status + " location " + botless.headers.location);
    const wrongbot = await formPost(base, "/signup",
      { name: "Door Wrongbot", password: PW, confirm: PW,
        "cf-turnstile-response": "wrong-token" }, CA);
    check("door (gated): a failed bot check refuses the creation the same way",
      wrongbot.status === 302 &&
        (wrongbot.headers.location || "") === "/signup?error=bot" &&
        !(await accountStands(base, "Door Wrongbot", PW)),
      "status " + wrongbot.status + " location " + wrongbot.headers.location);
    const form = await getPage(base, "/signup", CA);
    check("door (gated): inside the list, the page carries the bot check's widget",
      form.status === 200 && form.text.includes("cf-turnstile") &&
        form.text.includes('data-sitekey="door-drill-site-key"'),
      "status " + form.status);
    const keyJar = jar();
    const verified = await ceremony(base, keyJar,
      { name: "Door Key Gated", turnstile: "pass-token" }, CA);
    check("door (gated): the ceremony creates, with the check passed and the country inside",
      verified.status === 200 && !!keyJar.cookie && (await boardsStand(base, keyJar)),
      "status " + verified.status);
    // Five attempts have spent the hour's pace on this
    // address: Canada, States, Botless, Wrongbot and the
    // ceremony. The next creation is refused for pace alone.
    const paced = await formPost(base, "/signup",
      { name: "Door Pace", password: PW, confirm: PW, ...PASS }, CA);
    check("door (gated): a failed bot check spends the pace like a landed creation — " +
        "the sixth attempt is refused",
      paced.status === 302 &&
        (paced.headers.location || "") === "/signup?error=toomany" &&
        !(await accountStands(base, "Door Pace", PW)),
      "status " + paced.status + " location " + paced.headers.location);
    const homeFromFrance = await signIn(base, "Door Canada", PW,
      { "CF-IPCountry": "FR" });
    check("door (gated): sign-in is never gated — the account signs in from a refused country",
      !!homeFromFrance.cookie && (await boardsStand(base, homeFromFrance)));
  } finally {
    stub.close();
  }
}

// --- Worker mode ------------------------------------------------

function rigSql(sql) {
  execFileSync("npx",
    ["--yes", "wrangler@4.153.0", "d1", "execute", "tasksparkle-rig-auth",
     "--local", "--command", sql],
    { cwd: RIG_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const flipDoorRig = (value) => rigSql(
  "INSERT INTO auth_meta (key, value) VALUES ('door', " + value + ") " +
  "ON CONFLICT(key) DO UPDATE SET value = excluded.value");
const clearAttemptsRig = () => rigSql("DELETE FROM signup_attempts");

async function workerFlow() {
  const base = args.base;
  const CA = { headers: { "CF-IPCountry": "CA" } };
  const US = { headers: { "CF-IPCountry": "US" } };
  const FR = { headers: { "CF-IPCountry": "FR" } };
  const PASS = { "cf-turnstile-response": "pass-token" };

  const admin = jar();
  admin.absorb(await formPost(base, "/setup",
    { name: "Door Admin", password: PW, confirm: PW, code: SETUP_CODE }));
  check("door (hosted): the setup page made the first account on the fresh rig",
    !!admin.cookie && (await boardsStand(base, admin)));

  await walkDefaultPosture(base, admin,
    { headers: CA.headers, fields: { ...PASS } });

  flipDoorRig(1);
  // The pace first, while the hour's count stands at zero:
  // five creations land, the sixth is refused.
  for (let i = 1; i <= 5; i++) {
    const j = jar();
    j.absorb(await formPost(base, "/signup",
      { name: "Door Pace " + i, password: PW, confirm: PW, ...PASS }, CA));
    check("door (hosted): creation " + i + " of the hour's pace lands", !!j.cookie);
  }
  const sixth = await formPost(base, "/signup",
    { name: "Door Pace 6", password: PW, confirm: PW, ...PASS }, CA);
  check("door (hosted): the creation past the hour's pace is refused",
    sixth.status === 302 &&
      (sixth.headers.location || "") === "/signup?error=toomany" &&
      !(await accountStands(base, "Door Pace 6", PW)),
    "status " + sixth.status + " location " + sixth.headers.location);
  clearAttemptsRig();

  const france = await formPost(base, "/signup",
    { name: "Door France", password: PW, confirm: PW, ...PASS }, FR);
  check("door (hosted): a creation from outside Canada and the United States is refused",
    france.status === 302 && (france.headers.location || "") === "/signup" &&
      !(await accountStands(base, "Door France", PW)),
    "status " + france.status);
  const gatePage = await getPage(base, "/signup", FR);
  check("door (hosted): the gate's page carries the ruled words",
    gatePage.status === 200 &&
      gatePage.text.includes("Sign-up is open to Canada and the United States for now."),
    "status " + gatePage.status);
  const noCountry = await formPost(base, "/signup",
    { name: "Door Nowhere", password: PW, confirm: PW, ...PASS });
  check("door (hosted): a creation with no country read is refused",
    noCountry.status === 302 && (noCountry.headers.location || "") === "/signup" &&
      !(await accountStands(base, "Door Nowhere", PW)),
    "status " + noCountry.status);
  const states = jar();
  states.absorb(await formPost(base, "/signup",
    { name: "Door States", password: PW, confirm: PW, ...PASS }, US));
  check("door (hosted): a creation from the United States lands, on its own boards",
    !!states.cookie && (await boardsStand(base, states)));
  const botless = await formPost(base, "/signup",
    { name: "Door Botless", password: PW, confirm: PW }, CA);
  check("door (hosted): no bot-check token refuses the creation, before any account stands",
    botless.status === 302 &&
      (botless.headers.location || "") === "/signup?error=bot" &&
      !(await accountStands(base, "Door Botless", PW)),
    "status " + botless.status + " location " + botless.headers.location);
  const wrongbot = await formPost(base, "/signup",
    { name: "Door Wrongbot", password: PW, confirm: PW,
      "cf-turnstile-response": "wrong-token" }, CA);
  check("door (hosted): a failed bot check refuses the creation the same way",
    wrongbot.status === 302 &&
      (wrongbot.headers.location || "") === "/signup?error=bot" &&
      !(await accountStands(base, "Door Wrongbot", PW)),
    "status " + wrongbot.status + " location " + wrongbot.headers.location);
  const form = await getPage(base, "/signup", CA);
  check("door (hosted): inside the list, the page carries the widget, and its policy " +
      "lets the widget's own host through — the sign-in page's policy does not",
    form.status === 200 && form.text.includes("cf-turnstile") &&
      (form.headers["content-security-policy"] || "").includes("challenges.cloudflare.com"),
    "status " + form.status);
  const login = await getPage(base, "/login");
  check("door (hosted): open, the sign-in page carries the creation entry",
    login.status === 200 && login.text.includes('href="/signup"') &&
      !(login.headers["content-security-policy"] || "").includes("challenges.cloudflare.com"),
    "status " + login.status);
  const keyJar = jar();
  const verified = await ceremony(base, keyJar,
    { name: "Door Key", turnstile: "pass-token" }, CA);
  check("door (hosted): the passkey way creates and signs in",
    verified.status === 200 && !!keyJar.cookie && (await boardsStand(base, keyJar)),
    "status " + verified.status);

  flipDoorRig(2);
  await walkClosed(base, admin, { headers: CA.headers, fields: { ...PASS } });

  const homeFromFrance = await signIn(base, "Door States", PW,
    { "CF-IPCountry": "FR" });
  check("door (hosted): sign-in is never gated — the account signs in from a refused country",
    !!homeFromFrance.cookie && (await boardsStand(base, homeFromFrance)));
}

try {
  if (MODE === "worker") {
    await workerFlow();
  } else {
    await selfhostPlain();
    await selfhostGated();
  }
} finally {
  for (const h of handles) await stopServer(h);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}

console.log("\nDoor drill: " + count + " checks, " + failures + " failures.");
process.exit(failures ? 1 : 0);
