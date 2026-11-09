// TaskSparkle server drill: the self-host server's own lifecycle,
// drilled by starting throwaway instances with throwaway configs
// in a scratch folder — never a real config, never real data.
// It covers the config rulings (issues #72, #86 and #88), the
// Round 1 hardening that still stands (issue #55: the startup
// log names no person) and the sign-in shape of issue #107:
//
// - the install is nameless: the config holds no people, and a
//   config that still carries a "people" list (or the retired
//   household-password fields) refuses to start, naming the
//   change. The command line is the recovery door only, and it
//   works on the refused configs too — minting is a remedy.
// - the FIRST account is made on the website: with no accounts
//   standing, the sign-in page is a setup page that says the
//   first name added becomes the administrator. Name and
//   password make the account, flag it administrator and sign
//   the person in. First-wins is atomic: a second setup press
//   is refused in plain words and pointed at the invite path.
// - invites carry a name and nothing else: --invite "A Name"
//   (recovery) and the administrator's in-app route both mint
//   them. The set-password page shows the name in an editable
//   field for a new account and fixed for a reset. Spending
//   creates the account under the final name — unique across
//   accounts, case-insensitively, or the spend is refused and
//   the invite stays unspent. Spending a reset invite replaces
//   the password and keeps the boards.
// - sign-in picks a name from the list of accounts that stand
//   and types a password. One person's password never signs in
//   another, and the refusal never says which half was wrong.
// - the administrator's surface (the People routes in the
//   shared core, /api/auth): a signed-in administrator lists
//   the accounts, mints invites, grants administrator and
//   removes a person. A non-administrator gets a 403 on every
//   one and an anonymous caller a 401. The only administrator
//   cannot erase their own account while other accounts stand;
//   everyone else's self-erasure, and an administrator's when
//   another administrator stands or none do, is the core's
//   usual act.
// - a data file from before the shared sign-in tables (issue
//   #109) folds its local_passwords and local_invites rows
//   into them on the first open: the old scrypt password
//   verifies once and is rehashed in the current PHC scrypt
//   form at that proof, an unspent invite still spends, and
//   the local tables are dropped.
// - --delete-person <name> erases an account by name: the
//   owners row and its whole cascade plus the account's
//   credentials in the shared tables, working whether or not
//   the server runs, and refusing loudly when there is nothing
//   to delete.
// - a refused live-update upgrade (issue #108) answers with the
//   core's refusal and leaves the server standing: a stale tab
//   retrying its socket must never crash the process.
// - behind an HTTPS front door on the same machine (issue
//   #115, the Tailscale Serve shape): the config names the
//   public https address and the bare agent name, and the copy
//   still serves its people — the agents'-door split binds
//   only where a separate people's host is named — the passkey
//   ceremonies verify against the public origin the front
//   door's stamp names, and the directions carry the https
//   base address.
//
// - the terms record (issue #43): a config naming no Terms
//   version records nothing and changes nothing; a config
//   naming one makes a stale recorded agreement stand in the
//   person's state, and the agree route's ticked press writes
//   the new row — sign-in spends and keys write and see none
//   of it.
//
// The HTTP families against a running instance (throttle, body
// cap, frame rules) live in tests/api-drill.mjs, self-host mode.
//
//     node tests/server-drill.mjs
//
// The servers are spawned with this same Node, so running the
// drill under a Node version proves the server on that version —
// the #88 floor check is this drill (and the API drill's
// self-host mode) run under the oldest supported Node.
import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { scryptSync, randomBytes, createHash, generateKeyPairSync, createSign } from "node:crypto";
import { mkdirSync } from "node:fs";
import { encodeCBOR, createAuthHandlers, countAccounts } from "../worker/auth.js";
import { openDatabase } from "../server/d1-adapter.mjs";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "server.mjs");
const NAME_A = "Drill A";
const NAME_B = "Drill B";
const KEY_A = "drill a";
const KEY_B = "drill b";
const PW_A = "drill-a-own-password";
const PW_B = "drill-b-own-password";

let failures = 0;
let count = 0;
function check(name, cond, detail) {
  count += 1;
  if (!cond) failures += 1;
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail ? "  — " + detail : ""));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = mkdtempSync(join(tmpdir(), "ts-server-drill-"));
let nextPort = 8931;

function writeConfig(name, fields) {
  const path = join(scratch, name);
  writeFileSync(path, JSON.stringify({
    port: nextPort,
    dataDir: "data-" + name.replace(/\W/g, ""),
    sessionSecret: "drill-session-secret-0123456789abcdef",
    agentHost: "localhost:" + nextPort,
    ...fields,
  }, null, 2) + "\n");
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
        resolveStart({ child, log: () => log, exited: () => exited });
      }
    }, 50);
  });
}

function runToExit(args, input) {
  const r = spawnSync(process.execPath, [SERVER, ...args],
    { input: input || "", encoding: "utf8", timeout: 15000 });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

async function stopServer(handle) {
  if (handle.exited() !== null) return handle.exited();
  handle.child.kill("SIGTERM");
  for (let i = 0; i < 40 && handle.exited() === null; i++) await sleep(100);
  if (handle.exited() === null) handle.child.kill("SIGKILL");
  for (let i = 0; i < 20 && handle.exited() === null; i++) await sleep(100);
  return handle.exited();
}

const sessionOf = (res) =>
  (res.headers.getSetCookie ? res.headers.getSetCookie() : [])
    .find((c) => c.startsWith("ts_session=")) || null;

// A refused connection is an answer too (status 0): it fails the
// check that asked instead of ending the drill early.
async function postForm(port, path, fields) {
  try {
    return await fetch("http://127.0.0.1:" + port + path, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  } catch (e) {
    return { status: 0, headers: { getSetCookie: () => [], get: () => null } };
  }
}
const login = (port, name, password) => postForm(port, "/login", { name, password });
async function getText(url, cookie) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers: cookie ? { Cookie: cookie.split(";")[0] } : {},
    });
    return { status: res.status, text: await res.text(), headers: res.headers };
  } catch (e) {
    return { status: 0, text: "", headers: { get: () => null } };
  }
}
async function getStatus(url) {
  return (await getText(url)).status;
}
async function apiCall(port, cookie, method, path, body) {
  try {
    const res = await fetch("http://127.0.0.1:" + port + path, {
      method,
      redirect: "manual",
      headers: {
        ...(cookie ? { Cookie: cookie.split(";")[0] } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
  } catch (e) {
    return { status: 0, json: null, headers: { get: () => null } };
  }
}

// One raw live-update upgrade with no session cookie — the shape
// of a stale browser tab retrying after the copy's data moved on
// (issue #108). Resolves with the raw answer text once the socket
// closes, or with whatever arrived when the wait runs out.
function refusedUpgrade(port) {
  return new Promise((resolveReq) => {
    const sock = connect(port, "127.0.0.1");
    let text = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e) { /* already gone */ }
      resolveReq(text);
    };
    sock.on("connect", () => {
      sock.write(
        "GET /api/push HTTP/1.1\r\n" +
        "Host: 127.0.0.1:" + port + "\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
      );
    });
    sock.on("data", (c) => { text += c.toString("utf8"); });
    sock.on("close", finish);
    sock.on("error", finish);
    setTimeout(finish, 3000);
  });
}

function mint(configPath, name) {
  const run = runToExit(["--config", configPath, "--invite", name]);
  const m = run.out.match(/\/invite\/([A-Za-z0-9_-]+)/);
  return { ...run, code: m ? m[1] : null };
}

console.log("Node " + process.version + " — servers spawn under this same Node.");

try {
  // --- Configs from the older setups refuse to start (#89, #107) -------------------
  const cfgPlain = writeConfig("old-plain.json", { householdPassword: "drill-household-password" });
  nextPort += 1;
  let run = runToExit(["--config", cfgPlain]);
  check("#89: a config carrying householdPassword refuses to start, naming the change and the remedy",
    run.status !== 0 && /householdPassword/.test(run.out) && /--invite|website/.test(run.out),
    "exit " + run.status + " — " + run.out.split("\n")[0]);
  const cfgHashed = writeConfig("old-hash.json",
    { householdPasswordHash: "scrypt$c2FsdA==$aGFzaA==" });
  nextPort += 1;
  run = runToExit(["--config", cfgHashed]);
  check("#89: a config carrying householdPasswordHash refuses the same way",
    run.status !== 0 && /householdPasswordHash/.test(run.out) && /--invite|website/.test(run.out),
    "exit " + run.status + " — " + run.out.split("\n")[0]);
  run = runToExit(["--config", cfgPlain, "--set-password"], "a fresh long password\n");
  check("#89: --set-password is gone with the household password",
    run.status !== 0, "exit " + run.status);

  const cfgPeople = writeConfig("people.json", {
    people: [{ email: "drill-a@example.test", name: "Drill A" }],
  });
  nextPort += 1;
  run = runToExit(["--config", cfgPeople]);
  check("#107: a config carrying a people list refuses to start, naming the change",
    run.status !== 0 && /people/.test(run.out) && /no longer|website/.test(run.out),
    "exit " + run.status + " — " + run.out.split("\n")[0]);
  // The recovery commands are the remedy the refusal names, so
  // they must work on the refused configs themselves.
  const mintOnPeople = mint(cfgPeople, "Drill A");
  check("#107: --invite still mints on a people-carrying config (it is the recovery door)",
    mintOnPeople.status === 0 && !!mintOnPeople.code, "exit " + mintOnPeople.status);
  const mintOnHousehold = mint(cfgPlain, "Drill A");
  check("#107: --invite still mints on a household-password config",
    mintOnHousehold.status === 0 && !!mintOnHousehold.code, "exit " + mintOnHousehold.status);

  // --- The recovery door on a nameless install (#107) -------------------------------
  const portMain = nextPort;
  const cfgMain = writeConfig("main.json", {});
  nextPort += 1;
  let minted = mint(cfgMain, NAME_A);
  check("#107: --invite \"Drill A\" prints a link and the bare code, and states the 7 days",
    minted.status === 0 && !!minted.code &&
      minted.out.includes("/invite/" + minted.code) && /7 days/.test(minted.out),
    "exit " + minted.status);
  const cfgAfterMint = JSON.parse(readFileSync(cfgMain, "utf8"));
  check("#107: minting writes nothing to the config (accounts live in the data file)",
    !("people" in cfgAfterMint) && !JSON.stringify(cfgAfterMint).includes(minted.code),
    "fields: " + Object.keys(cfgAfterMint).join(", "));
  const stranger = mint(cfgMain, "Total Stranger");
  check("#107: minting needs no roster — a name nobody listed mints the same way",
    stranger.status === 0 && !!stranger.code, "exit " + stranger.status);
  const reminted = mint(cfgMain, NAME_A);
  check("#107: minting again for the same name prints a fresh code",
    reminted.status === 0 && !!reminted.code && reminted.code !== minted.code,
    "exit " + reminted.status);

  const s1 = await startServer(cfgMain);
  check("#107: a nameless config starts (accounts are made on the website or by invite)",
    s1.exited() === null, s1.log().split("\n")[0]);
  check("#55: the startup log names no person",
    !s1.log().includes(NAME_A) && !s1.log().includes(NAME_B),
    s1.log().split("\n").slice(0, 3).join(" | "));

  // A refused live-update upgrade (issue #108): the core's refusal
  // must reach the caller whole, and the refusal must never take
  // the server down with it.
  const refusal = await refusedUpgrade(portMain);
  check("#108: a live-update upgrade with no session is refused, with the core's answer as the body",
    refusal.startsWith("HTTP/1.1 401") && refusal.includes('"error"'),
    JSON.stringify(refusal.slice(0, 120)));
  const afterRefusal = await getText("http://127.0.0.1:" + portMain + "/login");
  check("#108: the same server still answers an ordinary request after the refusal",
    s1.exited() === null && afterRefusal.status === 200,
    "exited " + s1.exited() + " status " + afterRefusal.status);

  // With no accounts standing there is nobody to pick: the
  // sign-in page carries the invite box and no password form.
  let page = await getText("http://127.0.0.1:" + portMain + "/login");
  check("#107: with no accounts, the sign-in page is the setup page — the first-account form, the invite box, no name list and no email",
    page.status === 200 && page.text.includes('action="/setup"') &&
      page.text.includes('name="code"') && /administrator/.test(page.text) &&
      !page.text.includes('type="radio"') && !/email/i.test(page.text),
    "status " + page.status);

  let res = await login(portMain, NAME_A, PW_A);
  check("#107: before any invite is spent, no password signs in under the name",
    res.status === 302 && !sessionOf(res), "status " + res.status);

  page = await getText("http://127.0.0.1:" + portMain + "/invite/" + minted.code);
  check("#107: an invite retired by a re-mint shows the plain refusal",
    page.status === 200 && !page.text.includes('name="password"'), "status " + page.status);
  page = await getText("http://127.0.0.1:" + portMain + "/invite/no-such-code");
  check("#107: an unknown code shows the same refusal, saying neither which nor why",
    page.status === 200 && !page.text.includes('name="password"'), "status " + page.status);

  const codeA = reminted.code;
  page = await getText("http://127.0.0.1:" + portMain + "/invite/" + codeA);
  check("#107: the invite page shows the name in an editable field, and no email anywhere",
    page.status === 200 && page.text.includes('name="name"') &&
      page.text.includes('value="' + NAME_A + '"') &&
      page.text.includes('name="password"') && !/email/i.test(page.text),
    "status " + page.status);
  page = await getText("http://127.0.0.1:" + portMain + "/invite/" + codeA);
  check("#107: opening the link again does not spend it (a chat preview is only a look)",
    page.status === 200 && page.text.includes('name="password"'), "status " + page.status);

  res = await postForm(portMain, "/invite/" + codeA, { password: "short", confirm: "short" });
  check("#107: a password under the floor is refused and the invite survives — " +
      "the refusal naming the length (issue #147)",
    res.status === 302 && !sessionOf(res) &&
      (res.headers.get("location") || "").includes("error=pwlength"),
    "status " + res.status + " location " + res.headers.get("location"));
  res = await postForm(portMain, "/invite/" + codeA,
    { password: PW_A, confirm: "drill-a-other-password" });
  check("#107: mismatched passwords are refused and the invite survives — " +
      "the refusal naming the mismatch (issue #147)",
    res.status === 302 && !sessionOf(res) &&
      (res.headers.get("location") || "").includes("error=pwmismatch"),
    "status " + res.status + " location " + res.headers.get("location"));

  // The pair curve (issue #109): the failed sign-in probe
  // before this walk plus the two refused presses above are
  // three failures against this name from this address, so
  // the pair stands locked — the honest press is refused
  // while the lock stands, and lands once it passes. The
  // invite survives all of it.
  res = await postForm(portMain, "/invite/" + codeA,
    { name: NAME_A, password: PW_A, confirm: PW_A });
  check("#109: three failures against one name from one address lock the pair — the honest press waits",
    res.status === 302 && !sessionOf(res) &&
      (res.headers.get("location") || "").includes("error=locked"),
    "status " + res.status + " location " + res.headers.get("location"));
  await sleep(11000);

  res = await postForm(portMain, "/invite/" + codeA,
    { name: NAME_A, password: PW_A, confirm: PW_A });
  const cookieA = sessionOf(res);
  check("#107: the Set password press spends the invite and lands the person signed in",
    res.status === 302 && !!cookieA && (res.headers.get("location") || "") === "/",
    "status " + res.status + " location " + res.headers.get("location"));
  const stA = cookieA ? await apiCall(portMain, cookieA, "GET", "/api/v1/state") : { status: 0 };
  check("#107: the session the redemption issued reads the person's seeded state",
    stA.status === 200 && stA.json && stA.json.boards.length === 2 &&
      stA.json.me.name === NAME_A,
    "status " + stA.status);

  page = await getText("http://127.0.0.1:" + portMain + "/invite/" + codeA);
  check("#107: a spent invite's page is the refusal",
    page.status === 200 && !page.text.includes('name="password"'), "status " + page.status);
  res = await postForm(portMain, "/invite/" + codeA,
    { password: "drill-intruder-password", confirm: "drill-intruder-password" });
  check("#107: a spent invite cannot be redeemed twice",
    res.status === 302 && !sessionOf(res), "status " + res.status);

  // The sign-in page now lists the account that stands — a pick
  // list, names only, and still no email field or word.
  page = await getText("http://127.0.0.1:" + portMain + "/login");
  check("#107: the sign-in page lists the accounts' names as a pick list, with no email anywhere",
    page.status === 200 && page.text.includes('type="radio"') &&
      page.text.includes(NAME_A) && page.text.includes('name="password"') &&
      !page.text.includes('name="email"') && !/email/i.test(page.text),
    "status " + page.status);

  // A duplicate name at spend: a fresh invite for a new name,
  // spent under the name an account already holds (in any case),
  // is refused and the invite stays unspent.
  const mintedC = mint(cfgMain, "Drill C");
  res = await postForm(portMain, "/invite/" + mintedC.code,
    { name: "drill a", password: "drill-c-own-password", confirm: "drill-c-own-password" });
  check("#107: spending under a name an account already holds is refused, no session",
    res.status === 302 && !sessionOf(res) &&
      (res.headers.get("location") || "").includes("error=name"),
    "status " + res.status + " location " + res.headers.get("location"));
  page = await getText("http://127.0.0.1:" + portMain + "/invite/" + mintedC.code);
  check("#107: the refused spend leaves the invite unspent",
    page.status === 200 && page.text.includes('name="password"'), "status " + page.status);
  res = await postForm(portMain, "/invite/" + mintedC.code,
    { name: "Drill C", password: "drill-c-own-password", confirm: "drill-c-own-password" });
  check("#107: the same invite then spends under its own name",
    res.status === 302 && !!sessionOf(res), "status " + res.status);

  // Pick-name sign-in: A's password is A's only; a name with no
  // account gets the same refusal as a wrong password.
  res = await login(portMain, NAME_B, PW_A);
  check("#107: a name with no account gets the plain refusal, saying no more than a wrong password",
    res.status === 302 && !sessionOf(res) &&
      (res.headers.get("location") || "").includes("error=1"),
    "status " + res.status + " location " + res.headers.get("location"));
  res = await login(portMain, NAME_A, PW_B);
  check("#107: the wrong password under the right name is refused the same way",
    res.status === 302 && !sessionOf(res), "status " + res.status);
  res = await login(portMain, NAME_A, PW_A);
  const cookieA2 = sessionOf(res);
  check("#107: picking the name and typing its password signs in",
    res.status === 302 && !!cookieA2, "status " + res.status);

  // The pasted-code entry on the sign-in page (links mangled in chat).
  const mintedB = mint(cfgMain, NAME_B);
  check("#107: an invite can be minted while the server runs",
    mintedB.status === 0 && !!mintedB.code, "exit " + mintedB.status);
  res = await postForm(portMain, "/invite-code", { code: mintedB.code });
  check("#107: pasting the bare code on the sign-in page leads to the redemption page",
    res.status === 302 && (res.headers.get("location") || "") === "/invite/" + mintedB.code,
    "status " + res.status + " location " + res.headers.get("location"));
  res = await postForm(portMain, "/invite/" + mintedB.code, { password: PW_B, confirm: PW_B });
  const cookieB = sessionOf(res);
  check("#107: a spend that omits the name field takes the invite's name",
    res.status === 302 && !!cookieB, "status " + res.status);
  res = await login(portMain, NAME_B, PW_A);
  check("#107: person A's password does not sign in person B",
    res.status === 302 && !sessionOf(res), "status " + res.status);
  res = await login(portMain, NAME_B, PW_B);
  check("#107: person B signs in with the password they set",
    res.status === 302 && !!sessionOf(res), "status " + res.status);

  // An install grown through invites alone still has an
  // administrator: the first account to stand took the flag
  // when it landed, so the in-app surface works here too —
  // and the second account is refused by it.
  res = await login(portMain, NAME_A, PW_A);
  const peopleAsA = await apiCall(portMain, sessionOf(res), "GET", "/api/auth/people");
  check("#107: on an invite-grown install the first account is the administrator and reads the people list",
    peopleAsA.status === 200 && (peopleAsA.json.people || []).length === 3 &&
    (peopleAsA.json.people || []).some((p) => p.name === NAME_A && p.admin) &&
    (peopleAsA.json.people || []).every((p) => p.name === NAME_A || !p.admin),
    "status " + peopleAsA.status + " people " +
      JSON.stringify((peopleAsA.json && peopleAsA.json.people) || null));
  res = await login(portMain, NAME_B, PW_B);
  const peopleAsB = await apiCall(portMain, sessionOf(res), "GET", "/api/auth/people");
  check("#107: the second account on that install is no administrator — the people route refuses it",
    peopleAsB.status === 403, "status " + peopleAsB.status);

  // A reset invite through the recovery door: its page holds
  // the name fixed (it names the account), spending replaces
  // the password, and the boards — a card A made — stand.
  const stA2 = await apiCall(portMain, cookieA2, "GET", "/api/v1/state");
  const aPersonal = stA2.json.boards.find((x) => x.name === "Personal");
  const madeByA = await apiCall(portMain, cookieA2, "POST", "/api/v1/cards",
    { board_id: aPersonal.id, column_id: "inbox", title: "A card that survives a reset" });
  check("#107: A makes a card before the reset",
    madeByA.status === 201, "status " + madeByA.status);
  const mintedReset = mint(cfgMain, NAME_A);
  page = await getText("http://127.0.0.1:" + portMain + "/invite/" + mintedReset.code);
  check("#107: a reset invite's page names the account and offers no name field",
    page.status === 200 && page.text.includes(NAME_A) &&
      !page.text.includes('name="name"') && page.text.includes('name="password"'),
    "status " + page.status);
  res = await postForm(portMain, "/invite/" + mintedReset.code,
    { password: "drill-a-reset-password", confirm: "drill-a-reset-password" });
  check("#107: spending the reset invite signs A in on the new password",
    res.status === 302 && !!sessionOf(res), "status " + res.status);
  res = await login(portMain, NAME_A, PW_A);
  check("#107: the old password no longer signs A in",
    res.status === 302 && !sessionOf(res), "status " + res.status);
  res = await login(portMain, NAME_A, "drill-a-reset-password");
  const cookieA3 = sessionOf(res);
  check("#107: the new password signs A in",
    res.status === 302 && !!cookieA3, "status " + res.status);
  const stA3 = cookieA3 ? await apiCall(portMain, cookieA3, "GET", "/api/v1/state") : { status: 0, json: null };
  check("#107: the reset kept A's boards and the card on them",
    stA3.status === 200 && !!stA3.json &&
      stA3.json.cards.some((c) => c.title === "A card that survives a reset"),
    "status " + stA3.status);

  // Expiry: a reset invite for A, aged past its 7 days in the data file.
  const mintedA4 = mint(cfgMain, NAME_A);
  const dbFile = join(scratch, "data-" + "main.json".replace(/\W/g, ""), "tasksparkle.sqlite");
  const rawDb = new DatabaseSync(dbFile);
  rawDb.prepare("UPDATE invites SET expires = ? WHERE used_at IS NULL")
    .run(Date.now() - 1000);
  rawDb.close();
  page = await getText("http://127.0.0.1:" + portMain + "/invite/" + mintedA4.code);
  check("#107: an expired invite shows the refusal",
    page.status === 200 && !page.text.includes('name="password"'), "status " + page.status);
  res = await postForm(portMain, "/invite/" + mintedA4.code,
    { password: "drill-a-new-password", confirm: "drill-a-new-password" });
  check("#107: an expired invite cannot be redeemed",
    res.status === 302 && !sessionOf(res), "status " + res.status);
  res = await login(portMain, NAME_A, "drill-a-reset-password");
  check("#107: the expired reset changed nothing — A's password still signs in",
    res.status === 302 && !!sessionOf(res), "status " + res.status);
  check("stop: a plain stop exits cleanly", (await stopServer(s1)) === 0, "exit " + s1.exited());

  // --- The first account is made on the website (#107) ------------------------------
  const portSetup = nextPort;
  const cfgSetup = writeConfig("setup.json", {});
  nextPort += 1;
  const s2 = await startServer(cfgSetup);
  check("#107: the setup instance starts with no accounts",
    s2.exited() === null, s2.log().split("\n")[0]);
  page = await getText("http://127.0.0.1:" + portSetup + "/login");
  check("#107: with no accounts, the sign-in page is the setup page, saying the first name added will be the administrator",
    page.status === 200 && page.text.includes('action="/setup"') &&
      /administrator/.test(page.text) && page.text.includes('name="name"') &&
      page.text.includes('name="password"') && !/email/i.test(page.text),
    "status " + page.status);

  res = await postForm(portSetup, "/setup",
    { name: "Root Admin", password: "short", confirm: "short" });
  check("#107: a setup password under the floor is refused and no account is made — " +
      "the refusal naming the length (issue #147)",
    res.status === 302 && !sessionOf(res) &&
      (res.headers.get("location") || "").includes("error=pwlength"),
    "status " + res.status + " location " + res.headers.get("location"));
  page = await getText("http://127.0.0.1:" + portSetup + "/login");
  check("#107: the page is still the setup page after the refused press",
    page.status === 200 && page.text.includes('action="/setup"'), "status " + page.status);

  res = await postForm(portSetup, "/setup",
    { name: "Root Admin", password: "root-admin-password", confirm: "root-admin-password" });
  const cookieRoot = sessionOf(res);
  check("#107: the setup press makes the first account and signs its maker in",
    res.status === 302 && !!cookieRoot && (res.headers.get("location") || "") === "/",
    "status " + res.status + " location " + res.headers.get("location"));
  const stRoot = cookieRoot ? await apiCall(portSetup, cookieRoot, "GET", "/api/v1/state")
    : { status: 0, json: null };
  check("#107: the first account stands seeded, under the name it was made with",
    stRoot.status === 200 && !!stRoot.json && stRoot.json.me.name === "Root Admin" &&
      stRoot.json.boards.length === 2,
    "status " + stRoot.status);

  res = await postForm(portSetup, "/setup",
    { name: "Second Comer", password: "second-comer-password", confirm: "second-comer-password" });
  check("#107: a second setup press is refused — first-wins is closed",
    res.status === 302 && !sessionOf(res) &&
      (res.headers.get("location") || "").includes("error=taken"),
    "status " + res.status + " location " + res.headers.get("location"));
  page = await getText("http://127.0.0.1:" + portSetup + "/login?error=taken");
  check("#107: the refusal is plain and points at the invite path",
    page.status === 200 && /already stands/.test(page.text) && /invite/i.test(page.text) &&
      !page.text.includes('action="/setup"'),
    "status " + page.status);
  page = await getText("http://127.0.0.1:" + portSetup + "/login");
  check("#107: the sign-in page now lists the first account instead of the setup form",
    page.status === 200 && page.text.includes("Root Admin") &&
      page.text.includes('type="radio"') && !page.text.includes('action="/setup"'),
    "status " + page.status);

  // The administrator's surface, over the routes the app calls.
  let adm = await apiCall(portSetup, null, "GET", "/api/auth/people");
  check("#107: the people route answers an anonymous caller 401",
    adm.status === 401, "status " + adm.status);
  adm = await apiCall(portSetup, cookieRoot, "GET", "/api/auth/people");
  check("#107: the administrator reads the people list: one account, flagged administrator",
    adm.status === 200 && !!adm.json && adm.json.me.admin === true &&
      adm.json.people.length === 1 && adm.json.people[0].name === "Root Admin" &&
      adm.json.people[0].admin === true,
    "status " + adm.status + " body " + JSON.stringify(adm.json).slice(0, 120));
  adm = await apiCall(portSetup, cookieRoot, "POST", "/api/auth/invites", { name: "Jo" });
  check("#107: the administrator mints an invite in-app, and the answer carries the link",
    adm.status === 200 && !!adm.json && typeof adm.json.link === "string" &&
      adm.json.link.includes("/invite/") && adm.json.reset === false,
    "status " + adm.status);
  const joCode = adm.json ? (adm.json.link.match(/\/invite\/([A-Za-z0-9_-]+)/) || [])[1] : null;
  res = await postForm(portSetup, "/invite/" + joCode,
    { name: "Jo Adjusted", password: "jo-own-password-1", confirm: "jo-own-password-1" });
  const cookieJo = sessionOf(res);
  check("#107: the in-app invite spends with the name adjusted, and signs the new person in",
    res.status === 302 && !!cookieJo, "status " + res.status);

  adm = await apiCall(portSetup, cookieJo, "GET", "/api/auth/people");
  check("#107: a non-administrator gets a 403 on the people list",
    adm.status === 403, "status " + adm.status);
  adm = await apiCall(portSetup, cookieJo, "POST", "/api/auth/invites", { name: "Sneaky" });
  check("#107: a non-administrator gets a 403 minting an invite",
    adm.status === 403, "status " + adm.status);
  adm = await apiCall(portSetup, cookieJo, "POST", "/api/auth/admin",
    { account_key: "jo adjusted", admin: true });
  check("#107: a non-administrator gets a 403 granting administrator",
    adm.status === 403, "status " + adm.status);
  adm = await apiCall(portSetup, cookieJo, "DELETE",
    "/api/auth/people/" + encodeURIComponent("root admin"));
  check("#107: a non-administrator gets a 403 removing a person",
    adm.status === 403, "status " + adm.status);

  // Jo makes a card; an administrator's reset invite then
  // replaces Jo's password and keeps it.
  const stJo = await apiCall(portSetup, cookieJo, "GET", "/api/v1/state");
  const joPersonal = stJo.json.boards.find((x) => x.name === "Personal");
  const joCard = await apiCall(portSetup, cookieJo, "POST", "/api/v1/cards",
    { board_id: joPersonal.id, column_id: "inbox", title: "Jo's card, kept through a reset" });
  check("#107: Jo makes a card before the reset",
    joCard.status === 201, "status " + joCard.status);
  adm = await apiCall(portSetup, cookieRoot, "POST", "/api/auth/invites",
    { name: "Jo Adjusted" });
  check("#107: an invite for a name that stands is a reset invite",
    adm.status === 200 && !!adm.json && adm.json.reset === true, "status " + adm.status);
  const joResetCode = adm.json ? (adm.json.link.match(/\/invite\/([A-Za-z0-9_-]+)/) || [])[1] : null;
  page = await getText("http://127.0.0.1:" + portSetup + "/invite/" + joResetCode);
  check("#107: the reset invite's page holds the name fixed",
    page.status === 200 && page.text.includes("Jo Adjusted") &&
      !page.text.includes('name="name"'), "status " + page.status);
  res = await postForm(portSetup, "/invite/" + joResetCode,
    { password: "jo-own-password-2", confirm: "jo-own-password-2" });
  check("#107: spending the administrator's reset invite signs Jo in on the new password",
    res.status === 302 && !!sessionOf(res), "status " + res.status);
  res = await login(portSetup, "Jo Adjusted", "jo-own-password-1");
  check("#107: Jo's old password is refused after the reset",
    res.status === 302 && !sessionOf(res), "status " + res.status);
  res = await login(portSetup, "Jo Adjusted", "jo-own-password-2");
  const cookieJo2 = sessionOf(res);
  const stJo2 = cookieJo2 ? await apiCall(portSetup, cookieJo2, "GET", "/api/v1/state")
    : { status: 0, json: null };
  check("#107: the reset kept Jo's card",
    stJo2.status === 200 && !!stJo2.json &&
      stJo2.json.cards.some((c) => c.title === "Jo's card, kept through a reset"),
    "status " + stJo2.status);

  // The only-administrator guard: while Jo's account stands and
  // Jo is not an administrator, Root cannot erase their own.
  res = await fetch("http://127.0.0.1:" + portSetup + "/api/v1/me", {
    method: "DELETE",
    headers: { Cookie: cookieRoot.split(";")[0] },
  });
  const guardBody = await res.json().catch(() => null);
  check("#107: the only administrator cannot erase their own account while other accounts stand",
    res.status === 403 && !!guardBody && /administrator/.test(guardBody.error || "") &&
      /another/.test(guardBody.error || ""),
    "status " + res.status + " body " + JSON.stringify(guardBody).slice(0, 140));
  res = await login(portSetup, "Root Admin", "root-admin-password");
  check("#107: the refused erasure changed nothing — the administrator still signs in",
    res.status === 302 && !!sessionOf(res), "status " + res.status);

  // The administrator removes a person from inside the app.
  adm = await apiCall(portSetup, cookieRoot, "POST", "/api/auth/invites", { name: "Temp" });
  const tempCode = adm.json ? (adm.json.link.match(/\/invite\/([A-Za-z0-9_-]+)/) || [])[1] : null;
  res = await postForm(portSetup, "/invite/" + tempCode,
    { password: "temp-own-password", confirm: "temp-own-password" });
  check("#107: a third person spends their invite and stands",
    res.status === 302 && !!sessionOf(res), "status " + res.status);
  adm = await apiCall(portSetup, cookieRoot, "DELETE",
    "/api/auth/people/" + encodeURIComponent("temp"));
  check("#107: the administrator removes the person, and the answer is a plain ok",
    adm.status === 200 && !!adm.json && adm.json.ok === true, "status " + adm.status);
  res = await login(portSetup, "Temp", "temp-own-password");
  check("#107: the removed person can no longer sign in",
    res.status === 302 && !sessionOf(res), "status " + res.status);
  adm = await apiCall(portSetup, cookieRoot, "DELETE",
    "/api/auth/people/" + encodeURIComponent("temp"));
  check("#107: removing a name that does not stand answers 404",
    adm.status === 404, "status " + adm.status);

  // Making a second administrator lifts the guard.
  adm = await apiCall(portSetup, cookieRoot, "POST", "/api/auth/admin",
    { account_key: "jo adjusted", admin: true });
  check("#107: the administrator makes Jo an administrator",
    adm.status === 200 && !!adm.json && adm.json.ok === true, "status " + adm.status);
  // The flag change ends Jo's standing sessions (a privilege
  // change signs the person in again under the new flag,
  // issue #109), so Jo's read of the list takes a fresh
  // sign-in.
  res = await login(portSetup, "Jo Adjusted", "jo-own-password-2");
  const cookieJo3 = sessionOf(res);
  check("#107: Jo signs in again under the new flag",
    res.status === 302 && !!cookieJo3, "status " + res.status);
  adm = await apiCall(portSetup, cookieJo3, "GET", "/api/auth/people");
  check("#107: both accounts now stand flagged administrator",
    adm.status === 200 && !!adm.json &&
      adm.json.people.every((p) => p.admin === true) && adm.json.people.length === 2,
    "status " + adm.status);
  res = await fetch("http://127.0.0.1:" + portSetup + "/api/v1/me", {
    method: "DELETE",
    headers: { Cookie: cookieRoot.split(";")[0] },
  });
  check("#107: with another administrator standing, the first administrator's self-erasure goes through",
    res.status === 200, "status " + res.status);
  res = await login(portSetup, "Root Admin", "root-admin-password");
  check("#107: the erased administrator can no longer sign in",
    res.status === 302 && !sessionOf(res), "status " + res.status);
  page = await getText("http://127.0.0.1:" + portSetup + "/login");
  check("#107: the sign-in page lists the one account that stands",
    page.status === 200 && page.text.includes("Jo Adjusted") &&
      !page.text.includes("Root Admin"), "status " + page.status);

  // The recovery door still works on an instance whose accounts
  // all came from the website.
  const mintRec = mint(cfgSetup, "Recovered");
  check("#107: the recovery --invite mints on the setup instance",
    mintRec.status === 0 && !!mintRec.code, "exit " + mintRec.status);
  res = await postForm(portSetup, "/invite/" + mintRec.code,
    { password: "recovered-password", confirm: "recovered-password" });
  check("#107: the recovery invite spends and signs its person in",
    res.status === 302 && !!sessionOf(res), "status " + res.status);
  adm = await apiCall(portSetup, cookieJo3, "GET", "/api/auth/people");
  check("#107: the recovered account stands in the administrator's list, not an administrator",
    adm.status === 200 && !!adm.json &&
      adm.json.people.some((p) => p.name === "Recovered" && p.admin === false),
    "status " + adm.status);
  check("stop: the setup instance stops cleanly", (await stopServer(s2)) === 0, "exit " + s2.exited());

  // --- The first account, born passkey-only (issue #122) ---------------------------
  // The setup page's passkey way, on a home copy: the ceremony
  // runs first and the account is created only when a
  // credential verifies — at NULL password, with the passkey
  // standing. A look and an abandoned ceremony make nothing.
  // Loopback is a secure address, so the passkey way stands
  // here; the small authenticator names this instance's own
  // origin, as a browser's would.
  const portPk = nextPort;
  const cfgPk = writeConfig("setuppk.json", {});
  nextPort += 1;
  const s3 = await startServer(cfgPk);
  check("#122: the passkey-setup instance starts with no accounts",
    s3.exited() === null, s3.log().split("\n")[0]);
  const PK_ORIGIN = "http://127.0.0.1:" + portPk;
  function makePkAuthenticator() {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = pair.publicKey.export({ format: "jwk" });
    const credId = randomBytes(16);
    let counter = 0;
    const b64u = (buf) => Buffer.from(buf).toString("base64url");
    const cose = encodeCBOR(new Map([
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")],
    ]));
    const rpHash = createHash("sha256").update("127.0.0.1").digest();
    const clientData = (type, challenge) => Buffer.from(JSON.stringify({
      type, challenge, origin: PK_ORIGIN, crossOrigin: false,
    }));
    function attestation(challenge) {
      counter += 1;
      const countBuf = Buffer.alloc(4); countBuf.writeUInt32BE(counter);
      const lenBuf = Buffer.alloc(2); lenBuf.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpHash, Buffer.from([0x01 | 0x04 | 0x40]), countBuf,
        Buffer.alloc(16), lenBuf, credId, cose]);
      const attObj = encodeCBOR(new Map([
        ["fmt", "none"], ["attStmt", new Map()], ["authData", authData],
      ]));
      return {
        id: b64u(credId), type: "public-key",
        response: {
          clientDataJSON: b64u(clientData("webauthn.create", challenge)),
          attestationObject: b64u(attObj),
          transports: ["internal"],
        },
      };
    }
    function assertion(challenge, userHandle) {
      counter += 1;
      const countBuf = Buffer.alloc(4); countBuf.writeUInt32BE(counter);
      const authData = Buffer.concat([rpHash, Buffer.from([0x01 | 0x04]), countBuf]);
      const cd = clientData("webauthn.get", challenge);
      const signed = Buffer.concat([authData, createHash("sha256").update(cd).digest()]);
      const signer = createSign("SHA256");
      signer.update(signed);
      return {
        id: b64u(credId), type: "public-key",
        response: {
          clientDataJSON: b64u(cd),
          authenticatorData: b64u(authData),
          signature: b64u(signer.sign({ key: pair.privateKey })),
          userHandle: b64u(userHandle),
        },
      };
    }
    return { attestation, assertion };
  }
  const authPk = makePkAuthenticator();
  const pkOptions = () => apiCall(portPk, null, "POST", "/setup/passkey/options",
    { name: "Root Passkey" });
  page = await getText("http://127.0.0.1:" + portPk + "/login");
  check("#122: the setup page offers the passkey way standing first, the password way below it (issue #141)",
    page.status === 200 && page.text.includes('action="/setup"') &&
      page.text.includes('id="spend-passkey-button"') && page.text.includes('name="password"') &&
      page.text.indexOf('id="spend-passkey-button"') < page.text.indexOf('id="spend-password"'),
    "status " + page.status);
  const pkOpts1 = await pkOptions();
  check("#122: the spend ceremony's options carry the name and a minted handle",
    pkOpts1.status === 200 && !!pkOpts1.json && !!pkOpts1.json.challenge &&
      !!pkOpts1.json.user && !!pkOpts1.json.user.id && pkOpts1.json.user.name === "Root Passkey",
    "status " + pkOpts1.status);
  page = await getText("http://127.0.0.1:" + portPk + "/login");
  check("#122: an abandoned ceremony makes no account — the setup page still stands",
    page.status === 200 && page.text.includes('action="/setup"'), "status " + page.status);
  const pkOpts2 = await pkOptions();
  const pkVerify = await apiCall(portPk, null, "POST", "/setup/passkey/verify",
    { response: authPk.attestation(pkOpts2.json.challenge) });
  // apiCall does not surface the response's cookies beside the
  // JSON; the session cookie rides its headers.
  const pkCookie = (pkVerify.headers.getSetCookie ? pkVerify.headers.getSetCookie() : [])
    .find((c) => c.startsWith("ts_session=")) || null;
  check("#122: the ceremony lands — the account is created and its session begins",
    pkVerify.status === 200 && !!pkCookie, "status " + pkVerify.status);
  const pkViewCookie = (pkVerify.headers.getSetCookie ? pkVerify.headers.getSetCookie() : [])
    .find((c) => c.startsWith("ts_view=passkey")) || null;
  check("#141: the setup spend stands the device's sign-in view up as the passkey view",
    !!pkViewCookie,
    "cookies " + (pkVerify.headers.getSetCookie ? pkVerify.headers.getSetCookie() : [])
      .map((c) => c.split("=")[0]).join(","));
  const mePk = await apiCall(portPk, pkCookie, "GET", "/api/auth/me");
  check("#122: the first account holds no password and one passkey, an administrator",
    mePk.status === 200 && !!mePk.json && mePk.json.hasPassword === false &&
      mePk.json.passkeys.length === 1 && mePk.json.admin === true &&
      mePk.json.proofVia === "passkey",
    "status " + mePk.status + " body " + JSON.stringify(mePk.json).slice(0, 140));
  res = await postForm(portPk, "/setup",
    { name: "Second Comer", password: "second-comer-password", confirm: "second-comer-password" });
  check("#122: after the passkey-first account a setup press is refused — first-wins intact",
    res.status === 302 && !sessionOf(res) &&
      (res.headers.get("location") || "").includes("error=taken"),
    "status " + res.status + " location " + res.headers.get("location"));
  const tapOptsPk = await apiCall(portPk, null, "POST", "/login/passkey/options", {});
  const handlePk = Buffer.from(pkOpts2.json.user.id, "base64url");
  const tapPk = await apiCall(portPk, null, "POST", "/login/passkey/verify",
    authPk.assertion(tapOptsPk.json.challenge, handlePk));
  check("#122: the passkey the account was born with signs its person in",
    tapPk.status === 200, "status " + tapPk.status);
  check("stop: the passkey-setup instance stops cleanly",
    (await stopServer(s3)) === 0, "exit " + s3.exited());

  // --- Deleting a person by name: the recovery command (#57, #107) ------------------
  const portErase = nextPort;
  const cfgErase = writeConfig("erase.json", {});
  nextPort += 1;
  const sE = await startServer(cfgErase);
  check("#57: the erasure instance starts", sE.exited() === null, sE.log().split("\n")[0]);
  const mintEraseA = mint(cfgErase, NAME_A);
  let resE = await postForm(portErase, "/invite/" + mintEraseA.code, { password: PW_A, confirm: PW_A });
  const cookieEA = sessionOf(resE);
  const mintEraseB = mint(cfgErase, NAME_B);
  resE = await postForm(portErase, "/invite/" + mintEraseB.code, { password: PW_B, confirm: PW_B });
  const cookieEB = sessionOf(resE);
  check("#57: both people set their passwords on the erasure instance",
    !!cookieEA && !!cookieEB, "A " + !!cookieEA + " B " + !!cookieEB);
  const stEA = await apiCall(portErase, cookieEA, "GET", "/api/v1/state");
  check("#57: person A stands seeded on the erasure instance",
    stEA.status === 200 && stEA.json.boards.length === 2, "status " + stEA.status);
  const stEB = await apiCall(portErase, cookieEB, "GET", "/api/v1/state");
  const bOwnerId = stEB.json.me.id;
  const bBoard = stEB.json.boards.find((x) => x.name === "Personal");
  const madeCard = await apiCall(portErase, cookieEB, "POST", "/api/v1/cards",
    { board_id: bBoard.id, column_id: "inbox", title: "A card to erase" });
  await apiCall(portErase, cookieEB, "POST", "/api/v1/cards/" + madeCard.json.card.id + "/comments",
    { body: "a comment to erase" });
  const madeKey = await apiCall(portErase, cookieEB, "POST", "/api/v1/me/token",
    { name: "Erase Drill Key" });
  const bKeyE = madeKey.json.key;
  const keyRead = await fetch("http://127.0.0.1:" + portErase + "/api/v1/state",
    { headers: { Authorization: "Bearer " + bKeyE } });
  check("#57: B stands with a card, a comment and a working key before the erasure",
    madeCard.status === 201 && typeof bKeyE === "string" && keyRead.status === 200,
    "card " + madeCard.status + " key read " + keyRead.status);
  check("stop: the erasure instance stops cleanly before the command runs",
    (await stopServer(sE)) === 0, "exit " + sE.exited());

  let del = runToExit(["--config", cfgErase, "--delete-person", NAME_B]);
  check("#57: --delete-person <name> erases the account under that name",
    del.status === 0 && /erased/i.test(del.out),
    "exit " + del.status + " — " + del.out.split("\n")[0]);
  del = runToExit(["--config", cfgErase, "--delete-person", NAME_B]);
  check("#57: running it again finds nothing and says so (a typo cannot pass as success)",
    del.status !== 0 && /nothing/i.test(del.out), "exit " + del.status);
  del = runToExit(["--config", cfgErase, "--delete-person", "Ghost Person"]);
  check("#57: a name that never had an account is refused the same way",
    del.status !== 0 && /nothing/i.test(del.out), "exit " + del.status);

  const eraseDbFile = join(scratch, "data-" + "erase.json".replace(/\W/g, ""), "tasksparkle.sqlite");
  const eraseDb = new DatabaseSync(eraseDbFile, { readOnly: true });
  const gone = {
    owners: eraseDb.prepare("SELECT COUNT(*) AS n FROM owners WHERE id = ?").get(bOwnerId).n,
    boards: eraseDb.prepare("SELECT COUNT(*) AS n FROM boards WHERE owner_id = ?").get(bOwnerId).n,
    tokens: eraseDb.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE owner_id = ?").get(bOwnerId).n,
    cards: eraseDb.prepare("SELECT COUNT(*) AS n FROM cards JOIN boards ON boards.id = cards.board_id WHERE boards.owner_id = ?").get(bOwnerId).n,
    comments: eraseDb.prepare("SELECT COUNT(*) AS n FROM card_comments JOIN cards ON cards.id = card_comments.card_id JOIN boards ON boards.id = cards.board_id WHERE boards.owner_id = ?").get(bOwnerId).n,
    passwords: eraseDb.prepare("SELECT COUNT(*) AS n FROM accounts WHERE key = ?").get(KEY_B).n,
    invites: eraseDb.prepare("SELECT COUNT(*) AS n FROM invites WHERE key = ?").get(KEY_B).n,
  };
  const aStands = {
    owners: eraseDb.prepare("SELECT COUNT(*) AS n FROM owners WHERE email = ?").get(KEY_A).n,
    boards: eraseDb.prepare("SELECT COUNT(*) AS n FROM boards JOIN owners ON owners.id = boards.owner_id WHERE owners.email = ?").get(KEY_A).n,
    passwords: eraseDb.prepare("SELECT COUNT(*) AS n FROM accounts WHERE key = ?").get(KEY_A).n,
  };
  eraseDb.close();
  check("#57: every row that was B's is gone from the one data file",
    Object.values(gone).every((n) => n === 0), JSON.stringify(gone));
  check("#57: person A stands untouched in the same file",
    aStands.owners === 1 && aStands.boards >= 2 && aStands.passwords === 1,
    JSON.stringify(aStands));

  const sE2 = await startServer(cfgErase);
  resE = await login(portErase, NAME_A, PW_A);
  check("#57: person A still signs in after the erasure",
    resE.status === 302 && !!sessionOf(resE), "status " + resE.status);
  resE = await login(portErase, NAME_B, PW_B);
  check("#57: the erased person cannot sign in (account and password gone)",
    resE.status === 302 && !sessionOf(resE), "status " + resE.status);
  const deadKey = await fetch("http://127.0.0.1:" + portErase + "/api/v1/state",
    { headers: { Authorization: "Bearer " + bKeyE } });
  check("#57: the erased person's key answers 401",
    deadKey.status === 401, "status " + deadKey.status);
  await stopServer(sE2);

  // --- The fold-in: a data file from the wrapper's own tables (#109) ----------------
  // A data file written before the sign-in tables were shared
  // carries local_passwords (scrypt hashes) and local_invites.
  // The fixture below builds one by hand; the first open folds
  // the rows into the shared tables: the account stands with
  // its boards linked, the scrypt password verifies once and
  // is rehashed in the current PHC scrypt form at that proof,
  // the unspent invite still spends, and the local tables are
  // dropped.
  const portFold = nextPort;
  const cfgFold = writeConfig("foldin.json", {});
  nextPort += 1;
  const foldDir = join(scratch, "data-" + "foldin.json".replace(/\W/g, ""));
  mkdirSync(foldDir, { recursive: true });
  const foldFile = join(foldDir, "tasksparkle.sqlite");
  const schemaSql = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "worker", "schema.sql"), "utf8");
  const fixture = new DatabaseSync(foldFile);
  fixture.exec(schemaSql);
  fixture.exec(
    "CREATE TABLE local_passwords (key TEXT PRIMARY KEY, name TEXT NOT NULL, " +
    "hash TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0);" +
    "CREATE TABLE local_invites (code_hash TEXT PRIMARY KEY, key TEXT NOT NULL, " +
    "name TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, used_at INTEGER);"
  );
  const foldSalt = randomBytes(16);
  const foldHash = "scrypt$" + foldSalt.toString("base64") + "$" +
    scryptSync(PW_A, foldSalt, 64).toString("base64");
  const foldNow = new Date().toISOString();
  fixture.prepare("INSERT INTO owners (id, email, name, name_guessed, theme, created_at) VALUES (?, ?, ?, 0, 'system', ?)")
    .run("owner_foldin", KEY_A, NAME_A, foldNow);
  fixture.prepare("INSERT INTO local_passwords (key, name, hash, admin) VALUES (?, ?, ?, 1)")
    .run(KEY_A, NAME_A, foldHash);
  const foldCode = "foldin-code-123";
  fixture.prepare("INSERT INTO local_invites (code_hash, key, name, created, expires, used_at) VALUES (?, ?, ?, ?, ?, NULL)")
    .run(createHash("sha256").update(foldCode).digest("hex"),
      KEY_B, NAME_B, Date.now(), Date.now() + 7 * 24 * 60 * 60 * 1000);
  fixture.close();

  const sF = await startServer(cfgFold);
  check("#109: an install with a pre-share data file starts on the folded tables",
    sF.exited() === null, sF.log().split("\n")[0]);
  res = await login(portFold, NAME_A, PW_A);
  const cookieFold = sessionOf(res);
  check("#109: the folded account's scrypt password still signs its person in",
    res.status === 302 && !!cookieFold, "status " + res.status);
  const foldDb = new DatabaseSync(foldFile, { readOnly: true });
  const foldAccount = foldDb.prepare(
    "SELECT password_hash, owner_id FROM accounts WHERE key = ?").get(KEY_A);
  const foldTables = foldDb.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN " +
    "('local_passwords', 'local_invites')").get().n;
  foldDb.close();
  check("#109: the proof rehashed the password in the current PHC scrypt form, and the boards stand linked",
    !!foldAccount && String(foldAccount.password_hash).startsWith("$scrypt$ln=15,r=8,p=3$") &&
      foldAccount.owner_id === "owner_foldin",
    JSON.stringify(foldAccount && { owner: foldAccount.owner_id, form: String(foldAccount.password_hash).split("$").slice(0, 2).join("$") }));
  check("#109: the wrapper's own sign-in tables are dropped after the fold",
    foldTables === 0, "tables standing: " + foldTables);
  page = await getText("http://127.0.0.1:" + portFold + "/invite/" + foldCode);
  check("#109: an invite minted before the fold still opens its page",
    page.status === 200 && page.text.includes('name="password"'), "status " + page.status);
  res = await postForm(portFold, "/invite/" + foldCode, { password: PW_B, confirm: PW_B });
  check("#109: the folded invite spends and signs its person in",
    res.status === 302 && !!sessionOf(res), "status " + res.status);
  const stFoldB = await apiCall(portFold, sessionOf(res), "GET", "/api/v1/state");
  check("#109: the folded invite's account stands seeded like any new account",
    stFoldB.status === 200 && !!stFoldB.json && stFoldB.json.boards.length === 2,
    "status " + stFoldB.status);
  check("stop: the fold-in instance stops cleanly", (await stopServer(sF)) === 0, "exit " + sF.exited());

  // --- A data file from before the next step (#119) --------------------------------
  // A data file written before cards carried a next step has
  // no step columns at all: CREATE TABLE IF NOT EXISTS leaves
  // the old table standing, so the server's start adds the
  // columns in place (the adapter's column sync), and every
  // old card reads as its owner's step, not waiting — the
  // honest picture of the day before the feature. The fixture
  // builds that file by hand: the current schema with the
  // cards table's step lines struck out, an account in the
  // legacy hash form, and one card written the old way.
  const portStep = nextPort;
  const cfgStep = writeConfig("prefstep.json", {});
  nextPort += 1;
  const stepDir = join(scratch, "data-" + "prefstep.json".replace(/\W/g, ""));
  mkdirSync(stepDir, { recursive: true });
  const stepFile = join(stepDir, "tasksparkle.sqlite");
  const preStepSchema = schemaSql.split("\n")
    .filter((line) => !/^\s+step_(holder|key_id|key_name|handed_at|handed_by_key_id|handed_by_key_name|waiting)\b/.test(line))
    .join("\n");
  const stepFixture = new DatabaseSync(stepFile);
  stepFixture.exec(preStepSchema);
  const stepSalt = randomBytes(16);
  const stepHash = "scrypt$" + stepSalt.toString("base64") + "$" +
    scryptSync(PW_A, stepSalt, 64).toString("base64");
  const stepNow = new Date().toISOString();
  stepFixture.prepare("INSERT INTO owners (id, email, name, name_guessed, theme, created_at) VALUES (?, ?, ?, 0, 'system', ?)")
    .run("owner_prefstep", KEY_A, NAME_A, stepNow);
  stepFixture.prepare(
    "INSERT INTO accounts (key, id, name, password_hash, admin, owner_id, user_handle, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)")
    .run(KEY_A, "account-prefstep", NAME_A, stepHash, "owner_prefstep",
      randomBytes(32).toString("base64url"), Date.now());
  stepFixture.prepare("INSERT INTO boards (id, owner_id, name, position, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
    .run("board-prefstep", "owner_prefstep", "Personal", stepNow, stepNow);
  stepFixture.prepare('INSERT INTO "columns" (id, board_id, name, position, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run("board-prefstep-inbox", "board-prefstep", "Inbox", stepNow, stepNow);
  stepFixture.prepare(
    "INSERT INTO cards (id, board_id, column_id, project_id, title, notes, due_date, position, archived, important, creator_key_id, creator_key_name, created_at, updated_at) " +
    "VALUES (?, ?, ?, NULL, ?, '', NULL, 0, 0, 0, NULL, NULL, ?, ?)")
    .run("card-prefstep", "board-prefstep", "board-prefstep-inbox", "Written before the next step", stepNow, stepNow);
  stepFixture.close();
  const preCols = new DatabaseSync(stepFile, { readOnly: true });
  const preStepCols = preCols.prepare("PRAGMA table_info(cards)").all()
    .filter((r) => String(r.name).startsWith("step_")).length;
  preCols.close();
  check("#119: the fixture's cards table truly has no step columns",
    preStepCols === 0, "step columns standing: " + preStepCols);

  const sStep = await startServer(cfgStep);
  check("#119: an install with a pre-feature data file starts",
    sStep.exited() === null, sStep.log().split("\n")[0]);
  const postCols = new DatabaseSync(stepFile, { readOnly: true });
  const postStepCols = postCols.prepare("PRAGMA table_info(cards)").all()
    .filter((r) => String(r.name).startsWith("step_")).map((r) => r.name);
  postCols.close();
  check("#119: the start added the step columns to the old file in place",
    postStepCols.length === 7, "columns: " + postStepCols.join(", "));
  res = await login(portStep, NAME_A, PW_A);
  const cookieStep = sessionOf(res);
  check("#119: the pre-feature account signs in", res.status === 302 && !!cookieStep, "status " + res.status);
  const stStep = await apiCall(portStep, cookieStep, "GET", "/api/v1/state");
  const preCard = stStep.json && (stStep.json.cards || []).find((c) => c.id === "card-prefstep");
  check("#119: a card written before the feature reads as the owner's step, not waiting",
    !!preCard && !!preCard.step && preCard.step.holder === "owner" &&
      preCard.step.keyId === null && preCard.step.waiting === false && preCard.step.handedAt === null,
    "step " + JSON.stringify(preCard && preCard.step));
  const stepMint = await apiCall(portStep, cookieStep, "POST", "/api/v1/me/token", { name: "Migration Key" });
  const stepKeyId = stepMint.json && stepMint.json.id;
  const stepHand = await apiCall(portStep, cookieStep, "PATCH", "/api/v1/cards/card-prefstep",
    { next_step: stepKeyId, comment: "Yours now, from the old file." });
  check("#119: a hand-over works on the migrated file, comment riding",
    stepHand.status === 200 && !!stepHand.json && !!stepHand.json.card &&
      stepHand.json.card.step.holder === "agent" && stepHand.json.card.step.keyId === stepKeyId &&
      stepHand.json.card.step.waiting === true &&
      stepHand.json.card.comments.some((c) => c.body === "Yours now, from the old file."),
    "status " + stepHand.status + " step " + JSON.stringify(stepHand.json && stepHand.json.card && stepHand.json.card.step));
  check("stop: the migration instance stops cleanly", (await stopServer(sStep)) === 0, "exit " + sStep.exited());

  // --- A data file from before comments named their person (#120) ------------------
  // A comment written before this change records no author
  // identity: the key fields stand empty (the person wrote
  // it) and there is no author_owner_id column yet. The start
  // adds the column in place like the others. The comment
  // then reads with the board owner's name as its author —
  // on a board, a person comment could only ever have been
  // the owner's — resolved live, so a rename moves it too,
  // and the stored row is not rewritten: its author_owner_id
  // stays empty in the file.
  const portAuthor = nextPort;
  const cfgAuthor = writeConfig("prefauthor.json", {});
  nextPort += 1;
  const authorDir = join(scratch, "data-" + "prefauthor.json".replace(/\W/g, ""));
  mkdirSync(authorDir, { recursive: true });
  const authorFile = join(authorDir, "tasksparkle.sqlite");
  const preAuthorSchema = schemaSql.split("\n")
    .filter((line) => !/^\s+author_owner_id\b/.test(line))
    .join("\n");
  const authorFixture = new DatabaseSync(authorFile);
  authorFixture.exec(preAuthorSchema);
  const authorSalt = randomBytes(16);
  const authorHash = "scrypt$" + authorSalt.toString("base64") + "$" +
    scryptSync(PW_A, authorSalt, 64).toString("base64");
  const authorNow = new Date().toISOString();
  authorFixture.prepare("INSERT INTO owners (id, email, name, name_guessed, theme, created_at) VALUES (?, ?, ?, 0, 'system', ?)")
    .run("owner_prefauthor", KEY_A, NAME_A, authorNow);
  authorFixture.prepare(
    "INSERT INTO accounts (key, id, name, password_hash, admin, owner_id, user_handle, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)")
    .run(KEY_A, "account-prefauthor", NAME_A, authorHash, "owner_prefauthor",
      randomBytes(32).toString("base64url"), Date.now());
  authorFixture.prepare("INSERT INTO boards (id, owner_id, name, position, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
    .run("board-prefauthor", "owner_prefauthor", "Personal", authorNow, authorNow);
  authorFixture.prepare('INSERT INTO "columns" (id, board_id, name, position, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run("board-prefauthor-inbox", "board-prefauthor", "Inbox", authorNow, authorNow);
  authorFixture.prepare(
    "INSERT INTO cards (id, board_id, column_id, project_id, title, notes, due_date, position, archived, important, creator_key_id, creator_key_name, created_at, updated_at) " +
    "VALUES (?, ?, ?, NULL, ?, '', NULL, 0, 0, 0, NULL, NULL, ?, ?)")
    .run("card-prefauthor", "board-prefauthor", "board-prefauthor-inbox", "Written before comments named anyone", authorNow, authorNow);
  authorFixture.prepare(
    "INSERT INTO card_comments (id, card_id, body, author_key_id, author_key_name, created_at) VALUES (?, ?, ?, NULL, NULL, ?)")
    .run("comment-prefauthor", "card-prefauthor", "A note from before the change", authorNow);
  authorFixture.close();
  const preAuthorCols = new DatabaseSync(authorFile, { readOnly: true });
  const preHasAuthorId = preAuthorCols.prepare("PRAGMA table_info(card_comments)").all()
    .some((r) => r.name === "author_owner_id");
  preAuthorCols.close();
  check("#120: the fixture's comments table truly has no author_owner_id column",
    preHasAuthorId === false, "author_owner_id standing: " + preHasAuthorId);

  const sAuthor = await startServer(cfgAuthor);
  check("#120: an install with a pre-feature comments file starts",
    sAuthor.exited() === null, sAuthor.log().split("\n")[0]);
  const postAuthorCols = new DatabaseSync(authorFile, { readOnly: true });
  const postHasAuthorId = postAuthorCols.prepare("PRAGMA table_info(card_comments)").all()
    .some((r) => r.name === "author_owner_id");
  postAuthorCols.close();
  check("#120: the start added the author_owner_id column to the old file in place",
    postHasAuthorId === true, "author_owner_id standing: " + postHasAuthorId);
  res = await login(portAuthor, NAME_A, PW_A);
  const cookieAuthor = sessionOf(res);
  check("#120: the pre-feature account signs in", res.status === 302 && !!cookieAuthor, "status " + res.status);
  const stAuthor = await apiCall(portAuthor, cookieAuthor, "GET", "/api/v1/state");
  const authorCard = stAuthor.json && (stAuthor.json.cards || []).find((c) => c.id === "card-prefauthor");
  const legacyComment = authorCard && (authorCard.comments || []).find((c) => c.id === "comment-prefauthor");
  check("#120: the unstamped person comment reads with the owner's current name as its author",
    !!legacyComment && legacyComment.authorKeyName === null && legacyComment.authorName === NAME_A,
    "comment " + JSON.stringify(legacyComment));
  res = await apiCall(portAuthor, cookieAuthor, "PATCH", "/api/v1/me", { name: "Drill A Renamed" });
  check("#120: the pre-feature account renames", res.status === 200, "status " + res.status);
  const stAuthor2 = await apiCall(portAuthor, cookieAuthor, "GET", "/api/v1/state");
  const authorCard2 = stAuthor2.json && (stAuthor2.json.cards || []).find((c) => c.id === "card-prefauthor");
  const legacyComment2 = authorCard2 && (authorCard2.comments || []).find((c) => c.id === "comment-prefauthor");
  check("#120: the legacy comment's author follows the rename — the name is resolved, not stored",
    !!legacyComment2 && legacyComment2.authorName === "Drill A Renamed",
    "comment " + JSON.stringify(legacyComment2));
  check("stop: the author instance stops cleanly", (await stopServer(sAuthor)) === 0, "exit " + sAuthor.exited());
  const storedRow = new DatabaseSync(authorFile, { readOnly: true });
  const storedAuthor = storedRow.prepare("SELECT author_owner_id FROM card_comments WHERE id = ?")
    .get("comment-prefauthor");
  storedRow.close();
  check("#120: the stored comment was not rewritten — its author_owner_id stands empty",
    !!storedAuthor && storedAuthor.author_owner_id === null,
    "stored " + JSON.stringify(storedAuthor));

  // --- Cards whose names stand as text with no id (#121) ----------------------------
  // A card written while the creator stamp and the step kept
  // a name beside the id can stand with the name and no id —
  // the id column empty, the name text standing. The names on
  // such a card resolve by the name: where exactly one of the
  // owner's keys carries it, the card takes that key's id —
  // the state read keeps it in the file — so a later rename
  // reaches the card too. Where no key carries the name, or
  // two do, nothing is bound and the text stands as the
  // card's fallback name. The fixture builds that file by
  // hand: one key named "Legacy Key", two named "Twin Key",
  // and three cards — one stamped with the legacy key's name
  // as maker, holder and hander, one with a name no key
  // carries, one with the twins' shared name.
  const portNames = nextPort;
  const cfgNames = writeConfig("prefnames.json", {});
  nextPort += 1;
  const namesDir = join(scratch, "data-" + "prefnames.json".replace(/\W/g, ""));
  mkdirSync(namesDir, { recursive: true });
  const namesFile = join(namesDir, "tasksparkle.sqlite");
  const namesFixture = new DatabaseSync(namesFile);
  namesFixture.exec(schemaSql);
  const namesSalt = randomBytes(16);
  const namesHash = "scrypt$" + namesSalt.toString("base64") + "$" +
    scryptSync(PW_A, namesSalt, 64).toString("base64");
  const namesNow = new Date().toISOString();
  namesFixture.prepare("INSERT INTO owners (id, email, name, name_guessed, theme, created_at) VALUES (?, ?, ?, 0, 'system', ?)")
    .run("owner_prefnames", KEY_A, NAME_A, namesNow);
  namesFixture.prepare(
    "INSERT INTO accounts (key, id, name, password_hash, admin, owner_id, user_handle, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)")
    .run(KEY_A, "account-prefnames", NAME_A, namesHash, "owner_prefnames",
      randomBytes(32).toString("base64url"), Date.now());
  namesFixture.prepare("INSERT INTO boards (id, owner_id, name, position, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
    .run("board-prefnames", "owner_prefnames", "Personal", namesNow, namesNow);
  namesFixture.prepare('INSERT INTO "columns" (id, board_id, name, position, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run("board-prefnames-inbox", "board-prefnames", "Inbox", namesNow, namesNow);
  const nameToken = (id, label, hash) => namesFixture.prepare(
    "INSERT INTO api_tokens (id, owner_id, label, token_hash, last4, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, "owner_prefnames", label, hash, "0000", namesNow);
  nameToken("token-legacy", "Legacy Key", "fixture-hash-legacy");
  nameToken("token-twin-1", "Twin Key", "fixture-hash-twin-1");
  nameToken("token-twin-2", "Twin Key", "fixture-hash-twin-2");
  const nameCard = (id, title, fields) => namesFixture.prepare(
    "INSERT INTO cards (id, board_id, column_id, project_id, title, notes, due_date, position, archived, important, " +
    "creator_key_id, creator_key_name, step_holder, step_key_id, step_key_name, step_handed_at, " +
    "step_handed_by_key_id, step_handed_by_key_name, step_waiting, created_at, updated_at) " +
    "VALUES (?, ?, ?, NULL, ?, '', NULL, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, "board-prefnames", "board-prefnames-inbox", title,
      fields.creatorId, fields.creatorName, fields.holder, fields.keyId, fields.keyName,
      fields.handedAt, fields.byId, fields.byName, fields.waiting, namesNow, namesNow);
  nameCard("card-names-a", "Stamped with the legacy key's name", {
    creatorId: null, creatorName: "Legacy Key", holder: "agent", keyId: null, keyName: "Legacy Key",
    handedAt: namesNow, byId: null, byName: "Legacy Key", waiting: 1,
  });
  nameCard("card-names-b", "Stamped with a name no key carries", {
    creatorId: null, creatorName: "Ghost Key", holder: "owner", keyId: null, keyName: null,
    handedAt: null, byId: null, byName: null, waiting: 0,
  });
  nameCard("card-names-c", "Stamped with the twins' shared name", {
    creatorId: null, creatorName: "Twin Key", holder: "owner", keyId: null, keyName: null,
    handedAt: null, byId: null, byName: null, waiting: 0,
  });
  namesFixture.close();

  const sNames = await startServer(cfgNames);
  check("#121: an install with name-only cards starts",
    sNames.exited() === null, sNames.log().split("\n")[0]);
  res = await login(portNames, NAME_A, PW_A);
  const cookieNames = sessionOf(res);
  check("#121: the name-only account signs in", res.status === 302 && !!cookieNames, "status " + res.status);
  const stNames = await apiCall(portNames, cookieNames, "GET", "/api/v1/state");
  const namesCardOf = (st, id) => st.json && (st.json.cards || []).find((c) => c.id === id);
  const namesA = namesCardOf(stNames, "card-names-a");
  const namesB = namesCardOf(stNames, "card-names-b");
  const namesC = namesCardOf(stNames, "card-names-c");
  check("#121: the matched card reads with the key's name as maker, holder and hander",
    !!namesA && namesA.creatorKeyName === "Legacy Key" &&
      namesA.step.keyName === "Legacy Key" && namesA.step.waiting === true &&
      namesA.step.handedByKeyName === "Legacy Key" && namesA.step.handedByName === "Legacy Key",
    "card " + JSON.stringify(namesA && { creator: namesA.creatorKeyName, step: namesA.step }));
  check("#121: the unmatched and the ambiguous cards keep their stored text",
    !!namesB && namesB.creatorKeyName === "Ghost Key" &&
      !!namesC && namesC.creatorKeyName === "Twin Key",
    "ghost " + (namesB && namesB.creatorKeyName) + " twin " + (namesC && namesC.creatorKeyName));
  const boundDb = new DatabaseSync(namesFile, { readOnly: true });
  const boundA = boundDb.prepare(
    "SELECT creator_key_id, step_key_id, step_handed_by_key_id FROM cards WHERE id = ?").get("card-names-a");
  const boundB = boundDb.prepare("SELECT creator_key_id FROM cards WHERE id = ?").get("card-names-b");
  const boundC = boundDb.prepare("SELECT creator_key_id FROM cards WHERE id = ?").get("card-names-c");
  boundDb.close();
  check("#121: the state read kept the matched id in the file — and bound nothing for the others",
    !!boundA && boundA.creator_key_id === "token-legacy" && boundA.step_key_id === "token-legacy" &&
      boundA.step_handed_by_key_id === "token-legacy" &&
      !!boundB && boundB.creator_key_id === null && !!boundC && boundC.creator_key_id === null,
    "bound " + JSON.stringify({ a: boundA, b: boundB, c: boundC }));
  res = await apiCall(portNames, cookieNames, "PATCH", "/api/v1/me/token/token-legacy", { name: "Legacy Key Renamed" });
  check("#121: the legacy key renames", res.status === 200, "status " + res.status);
  const stNames2 = await apiCall(portNames, cookieNames, "GET", "/api/v1/state");
  const namesA2 = namesCardOf(stNames2, "card-names-a");
  const namesB2 = namesCardOf(stNames2, "card-names-b");
  const namesC2 = namesCardOf(stNames2, "card-names-c");
  check("#121: the rename reaches the matched card's maker, holder and hander names at once",
    !!namesA2 && namesA2.creatorKeyName === "Legacy Key Renamed" &&
      namesA2.step.keyName === "Legacy Key Renamed" &&
      namesA2.step.handedByKeyName === "Legacy Key Renamed" && namesA2.step.handedByName === "Legacy Key Renamed",
    "card " + JSON.stringify(namesA2 && { creator: namesA2.creatorKeyName, step: namesA2.step }));
  check("#121: the fallback cards still read their stored text after the rename",
    !!namesB2 && namesB2.creatorKeyName === "Ghost Key" &&
      !!namesC2 && namesC2.creatorKeyName === "Twin Key",
    "ghost " + (namesB2 && namesB2.creatorKeyName) + " twin " + (namesC2 && namesC2.creatorKeyName));
  res = await apiCall(portNames, cookieNames, "DELETE", "/api/v1/me/token/token-legacy");
  check("#121: the legacy key is deleted (revoked — its row stands)", res.status === 200, "status " + res.status);
  const stNames3 = await apiCall(portNames, cookieNames, "GET", "/api/v1/state");
  const namesA3 = namesCardOf(stNames3, "card-names-a");
  check("#121: after the delete, the maker and hander names still resolve from the standing row",
    !!namesA3 && namesA3.creatorKeyName === "Legacy Key Renamed" &&
      namesA3.step.holder === "owner" &&
      namesA3.step.handedByKeyName === "Legacy Key Renamed" && namesA3.step.handedByName === "Legacy Key Renamed",
    "card " + JSON.stringify(namesA3 && { creator: namesA3.creatorKeyName, step: namesA3.step }));
  check("stop: the names instance stops cleanly", (await stopServer(sNames)) === 0, "exit " + sNames.exited());

  // --- Behind an HTTPS front door: the Serve shape (#115) ----------------------------
  // A front door on the same machine (Tailscale Serve is the
  // known one) terminates HTTPS and forwards to a server bound
  // to this machine only, stamping the scheme it terminated
  // into X-Forwarded-Proto and carrying the public name in the
  // Host header. The config names that public address: address
  // is the https address and agentHost the bare name, with no
  // port — the shape that once broke the copy three ways (the
  // session refused as an agents'-door caller, the ceremonies
  // refused on origin, the directions naming http). The calls
  // below speak the way the front door does, and a small
  // software authenticator works the ceremonies with answers
  // naming the public https origin, as a browser's would.
  const SERVE_NAME = "serve-drill.example";
  const SERVE_ORIGIN = "https://" + SERVE_NAME;
  function serveCall(port, method, path, opts) {
    opts = opts || {};
    return new Promise((resolveCall) => {
      const headers = { Host: SERVE_NAME };
      if (opts.stamp !== false) headers["X-Forwarded-Proto"] = "https";
      if (opts.cookie) headers.Cookie = opts.cookie.split(";")[0];
      if (opts.auth) headers.Authorization = "Bearer " + opts.auth;
      let payload = null;
      if (opts.form) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        payload = new URLSearchParams(opts.form).toString();
      } else if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(opts.body);
      }
      if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
      const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(text); } catch (e) { json = null; }
          resolveCall({ status: res.statusCode, json, text, headers: res.headers });
        });
      });
      req.on("error", () => resolveCall({ status: 0, json: null, text: "", headers: {} }));
      if (payload) req.write(payload);
      req.end();
    });
  }
  const serveSessionOf = (res) =>
    (res.headers["set-cookie"] || []).find((c) => c.startsWith("ts_session=")) || null;

  // One credential, honestly built, its ceremonies naming the
  // Serve origin and the Serve name as relying party.
  function makeServeAuthenticator() {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = pair.publicKey.export({ format: "jwk" });
    const credId = randomBytes(16);
    let counter = 0;
    const b64u = (buf) => Buffer.from(buf).toString("base64url");
    const cose = encodeCBOR(new Map([
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")],
    ]));
    const rpHash = createHash("sha256").update(SERVE_NAME).digest();
    const clientData = (type, challenge) => Buffer.from(JSON.stringify({
      type, challenge, origin: SERVE_ORIGIN, crossOrigin: false,
    }));
    function attestation(challenge) {
      counter += 1;
      const countBuf = Buffer.alloc(4); countBuf.writeUInt32BE(counter);
      const lenBuf = Buffer.alloc(2); lenBuf.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpHash, Buffer.from([0x01 | 0x04 | 0x40]), countBuf,
        Buffer.alloc(16), lenBuf, credId, cose]);
      const attObj = encodeCBOR(new Map([
        ["fmt", "none"], ["attStmt", new Map()], ["authData", authData],
      ]));
      return {
        id: b64u(credId), type: "public-key",
        response: {
          clientDataJSON: b64u(clientData("webauthn.create", challenge)),
          attestationObject: b64u(attObj),
          transports: ["internal"],
        },
      };
    }
    function assertion(challenge, userHandle) {
      counter += 1;
      const countBuf = Buffer.alloc(4); countBuf.writeUInt32BE(counter);
      const authData = Buffer.concat([rpHash, Buffer.from([0x01 | 0x04]), countBuf]);
      const cd = clientData("webauthn.get", challenge);
      const signed = Buffer.concat([authData, createHash("sha256").update(cd).digest()]);
      const signer = createSign("SHA256");
      signer.update(signed);
      return {
        id: b64u(credId), type: "public-key",
        response: {
          clientDataJSON: b64u(cd),
          authenticatorData: b64u(authData),
          signature: b64u(signer.sign({ key: pair.privateKey })),
          userHandle: b64u(userHandle),
        },
      };
    }
    return { attestation, assertion };
  }

  const portServe = nextPort;
  const cfgServe = writeConfig("serve.json", {
    host: "127.0.0.1", address: SERVE_ORIGIN, agentHost: SERVE_NAME,
  });
  nextPort += 1;
  const sServe = await startServer(cfgServe);
  check("#115: an instance in the Serve shape starts",
    sServe.exited() === null, sServe.log().split("\n")[0]);
  check("#115: the startup line names the https address agents connect at",
    sServe.log().includes("Agents connect at " + SERVE_ORIGIN + "/api/v1"),
    sServe.log().split("\n").find((l) => l.includes("Agents connect")) || "line missing");
  const setupServe = await serveCall(portServe, "POST", "/setup",
    { form: { name: NAME_A, password: PW_A, confirm: PW_A } });
  const cookieServe = serveSessionOf(setupServe);
  check("#115: the first account is made through the front door's shape and signs its maker in",
    setupServe.status === 302 && !!cookieServe, "status " + setupServe.status);
  const stServe = await serveCall(portServe, "GET", "/api/v1/state", { cookie: cookieServe });
  check("#115: the session speaks at the one address — the portless agent name no longer swallows the people's door",
    stServe.status === 200 && !!stServe.json && stServe.json.boards.length === 2,
    "status " + stServe.status);
  const keyServe = await serveCall(portServe, "POST", "/api/v1/me/token",
    { cookie: cookieServe, body: { name: "Serve Drill Key" } });
  const dirServe = await serveCall(portServe, "GET", "/api/v1/directions",
    { auth: keyServe.json ? keyServe.json.key : "" });
  check("#115: the directions name the https base address",
    dirServe.status === 200 && dirServe.text.includes("Base address: " + SERVE_ORIGIN + "/api/v1"),
    (dirServe.text.split("\n").find((l) => l.startsWith("Base address:")) || "status " + dirServe.status));
  const authServe = makeServeAuthenticator();
  const enrolOptsServe = await serveCall(portServe, "POST", "/api/auth/passkeys/options",
    { cookie: cookieServe, body: {} });
  check("#115: enrolment options name the public name as the relying party",
    enrolOptsServe.status === 200 && !!enrolOptsServe.json &&
      !!enrolOptsServe.json.rp && enrolOptsServe.json.rp.id === SERVE_NAME,
    "status " + enrolOptsServe.status + " rp " +
      (enrolOptsServe.json && enrolOptsServe.json.rp ? enrolOptsServe.json.rp.id : "none"));
  const handleServe = enrolOptsServe.json
    ? Buffer.from(enrolOptsServe.json.user.id, "base64url") : null;
  const enrolledServe = await serveCall(portServe, "POST", "/api/auth/passkeys", {
    cookie: cookieServe,
    body: {
      response: authServe.attestation(enrolOptsServe.json ? enrolOptsServe.json.challenge : ""),
      nickname: "Serve drill passkey",
    },
  });
  check("#115: the passkey enrols — the ceremony's https origin is the one the door expects",
    enrolledServe.status === 201,
    "status " + enrolledServe.status + " " + enrolledServe.text.slice(0, 90));
  const assertOptsServe = await serveCall(portServe, "POST", "/login/passkey/options",
    { body: { name: NAME_A } });
  check("#115: sign-in options name the public name as the relying party",
    assertOptsServe.status === 200 && !!assertOptsServe.json && assertOptsServe.json.rpId === SERVE_NAME,
    "status " + assertOptsServe.status);
  const signedInServe = await serveCall(portServe, "POST", "/login/passkey/verify", {
    body: authServe.assertion(assertOptsServe.json ? assertOptsServe.json.challenge : "", handleServe),
  });
  check("#115: the passkey signs in behind the front door",
    signedInServe.status === 200 && !!serveSessionOf(signedInServe),
    "status " + signedInServe.status);
  // The same ceremony without the front door's stamp: the
  // request then arrives as a plain http call, the door expects
  // that origin, and the https ceremony is refused. The stamp
  // is believed only from this machine (see server.mjs), and
  // every drill call comes from this machine, so the unstamped
  // call is the half of that rule the drill can work.
  const bareOptsServe = await serveCall(portServe, "POST", "/login/passkey/options",
    { body: { name: NAME_A }, stamp: false });
  const bareTryServe = await serveCall(portServe, "POST", "/login/passkey/verify", {
    body: authServe.assertion(bareOptsServe.json ? bareOptsServe.json.challenge : "", handleServe),
    stamp: false,
  });
  check("#115: without the front door's stamp the same ceremony is refused — the door expects the origin of the address actually used",
    bareTryServe.status === 401 && !serveSessionOf(bareTryServe),
    "status " + bareTryServe.status);
  check("stop: the Serve-shape instance stops cleanly",
    (await stopServer(sServe)) === 0, "exit " + sServe.exited());

  // --- The recovery door beside a held write lock (#130) ---------------------------
  // The store has two legitimate openers: the running server
  // and the maintenance commands, and SQLite gives the file
  // one write lock. A helper process takes that lock and holds
  // it the way one of the server's own write transactions
  // does, only longer, while --invite opens the same store.
  // The open used to die on the spot with "database is locked"
  // — the pull-request checks' red, twice in a row. The invite
  // must wait the hold out, mint, and stand to be spent.
  const portLockDrill = nextPort;
  const cfgLockDrill = writeConfig("lockdrill.json", {});
  nextPort += 1;
  const sLockDrill = await startServer(cfgLockDrill);
  check("#130: the lock-drill instance starts",
    sLockDrill.exited() === null, sLockDrill.log().split("\n")[0]);
  const lockDbFile = join(scratch,
    "data-" + "lockdrill.json".replace(/\W/g, ""), "tasksparkle.sqlite");
  const holdPath = join(scratch, "hold-lock.mjs");
  writeFileSync(holdPath,
    "import { DatabaseSync } from \"node:sqlite\";\n" +
    "const db = new DatabaseSync(process.argv[2]);\n" +
    "db.exec(\"BEGIN IMMEDIATE\");\n" +
    "db.exec(\"INSERT INTO auth_meta (key, value) VALUES ('lock-drill-hold', 1) " +
    "ON CONFLICT(key) DO UPDATE SET value = 1\");\n" +
    "console.log('HELD');\n" +
    "setTimeout(() => { db.exec('COMMIT'); db.close(); }, 3000);\n");
  const holdChild = spawn(process.execPath, [holdPath, lockDbFile],
    { stdio: ["ignore", "pipe", "pipe"] });
  let holdOut = "";
  holdChild.stdout.on("data", (c) => (holdOut += c));
  for (let i = 0; i < 40 && !holdOut.includes("HELD"); i++) await sleep(100);
  check("#130: the helper holds the store's write lock",
    holdOut.includes("HELD"), holdOut.trim());
  const heldMint = mint(cfgLockDrill, "Lock Drill");
  check("#130: --invite beside the held lock waits it out and mints (no 'database is locked')",
    heldMint.status === 0 && !!heldMint.code &&
      !heldMint.out.includes("database is locked"),
    "exit " + heldMint.status);
  await new Promise((r) => holdChild.on("exit", r));
  const lockPage = heldMint.code
    ? await getText("http://127.0.0.1:" + portLockDrill + "/invite/" + heldMint.code)
    : { status: 0, text: "" };
  check("#130: the waited-for invite stands — its page answers on the running server",
    lockPage.status === 200 && lockPage.text.includes('name="password"'),
    "status " + lockPage.status);
  check("stop: the lock-drill instance stops cleanly",
    (await stopServer(sLockDrill)) === 0, "exit " + sLockDrill.exited());

  // --- The bind option (#72) ---------------------------------------------------------
  const lan = Object.values(networkInterfaces()).flat()
    .find((i) => i && i.family === "IPv4" && !i.internal);
  if (!lan) {
    check("#72: localhost bind (skipped — this machine has no LAN address)", true, "skipped");
  } else {
    const portBind = nextPort;
    const cfgBind = writeConfig("bind.json", { host: "127.0.0.1" });
    nextPort += 1;
    const sBind = await startServer(cfgBind);
    const localStatus = await getStatus("http://127.0.0.1:" + portBind + "/login");
    check("#72: bound to localhost, the sign-in page answers on localhost",
      localStatus === 200, "status " + localStatus);
    const lanStatus = await getStatus("http://" + lan.address + ":" + portBind + "/login");
    check("#72: bound to localhost, the LAN address gets no answer",
      lanStatus === 0, lan.address + ":" + portBind + " answered " + lanStatus);
    await stopServer(sBind);

    const portOpen = nextPort;
    const cfgOpen = writeConfig("open.json", {});
    nextPort += 1;
    const sOpen = await startServer(cfgOpen);
    const wideStatus = await getStatus("http://" + lan.address + ":" + portOpen + "/login");
    check("#72: with no host set, the server still answers on the LAN (today's behaviour)",
      wideStatus === 200, "status " + wideStatus);
    await stopServer(sOpen);
  }

  // --- Setup with no code configured (issue #153) ---------------------------
  // The hosted door's shape, driven in-process against the
  // shared handlers: the deployment requires a setup code but
  // none is set. Setup must fail closed AND say a code must
  // be set first — "did not match" would send the operator
  // hunting a typo in a code that does not exist.
  {
    const nocodeSchema = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "worker", "schema.sql"), "utf8");
    const nocodeDb = openDatabase(join(scratch, "nocode.sqlite"), nocodeSchema);
    const nocodePages = createAuthHandlers({
      authDb: nocodeDb,
      cfg: {
        hosted: true,
        listNames: false,
        requireSetupCode: true,
        setupCodeHash: async () => null,
        sourceOf: () => "drill",
        sourceCapMs: 60 * 1000,
        cookieSecure: () => true,
      },
    });
    const nocodePost = await nocodePages(new Request("https://hosted.example/setup", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "First Person", code: "anything",
        password: "first-person-password", confirm: "first-person-password",
      }).toString(),
    }));
    check("#153: with no setup code configured, a setup press is refused as unconfigured, not as a mismatch",
      nocodePost.status === 302 &&
        (nocodePost.headers.get("location") || "").includes("error=nocode"),
      "status " + nocodePost.status + " location " + nocodePost.headers.get("location"));
    const nocodePage = await nocodePages(
      new Request("https://hosted.example/login?error=nocode"));
    const nocodeText = await nocodePage.text();
    check("#153: the setup page says a code must be set first, in the setup family's words",
      nocodePage.status === 200 &&
        nocodeText.includes("No setup code is set on this copy yet.") &&
        nocodeText.includes("deployment settings") &&
        !nocodeText.includes("did not match"),
      "status " + nocodePage.status);
    check("#153: and no account was made",
      (await countAccounts(nocodeDb)) === 0, "accounts stand");
    const nocodeOpts = await nocodePages(new Request("https://hosted.example/setup/passkey/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "First Person", code: "anything" }),
    }));
    const nocodeOptsJson = await nocodeOpts.json().catch(() => null);
    check("#153: the passkey way's refusal says the same",
      nocodeOpts.status === 400 && !!nocodeOptsJson &&
        /No setup code is set/.test(nocodeOptsJson.error || ""),
      "status " + nocodeOpts.status + " body " + (nocodeOptsJson && nocodeOptsJson.error));
  }

  // --- The terms record (issue #43) -----------------------------------
  // The record a person's tick leaves. A copy whose config
  // names no Terms version records nothing and changes
  // nothing: accounts are made as before, no row stands, the
  // state carries no terms standing and the agree route is
  // not there. A copy whose config names a version keeps the
  // record: a row a deployment's own joining spend wrote at
  // an older version makes the state carry the standing —
  // the new version's date — and the person's tick on the
  // agree route writes the new row beside it. Sign-in spends
  // never write a row, and a key can neither see the standing
  // nor answer it.
  {
    const agreementRows = (configName) => {
      const file = join(scratch,
        "data-" + configName.replace(/\W/g, ""), "tasksparkle.sqlite");
      const raw = new DatabaseSync(file, { readOnly: true });
      try {
        const stands = raw.prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'agreements'"
        ).get();
        if (!stands || stands.n === 0) return null;
        return raw.prepare(
          "SELECT account_key, terms_version, source FROM agreements ORDER BY agreed_at, rowid"
        ).all();
      } finally { raw.close(); }
    };

    // Unconfigured: joins as before, nothing recorded.
    const portPlain = nextPort;
    const cfgPlain = writeConfig("terms-plain.json", {});
    nextPort += 1;
    const sPlain = await startServer(cfgPlain);
    res = await postForm(portPlain, "/setup",
      { name: "Terms Plain", password: "terms-plain-password", confirm: "terms-plain-password" });
    const cookiePlain = sessionOf(res);
    check("#43: an unconfigured copy makes its first account as before",
      res.status === 302 && !!cookiePlain, "status " + res.status);
    const stPlain = cookiePlain ? await apiCall(portPlain, cookiePlain, "GET", "/api/v1/state")
      : { status: 0, json: null };
    check("#43: an unconfigured copy's state carries no terms standing",
      stPlain.status === 200 && !!stPlain.json && !("termsUpdate" in stPlain.json),
      "status " + stPlain.status);
    const agreePlain = cookiePlain ? await apiCall(portPlain, cookiePlain, "POST", "/api/terms/agree", { agreed: true })
      : { status: 0, json: null };
    check("#43: an unconfigured copy has no agree route standing",
      agreePlain.status === 404, "status " + agreePlain.status);
    const rowsPlain = agreementRows("terms-plain.json");
    check("#43: an unconfigured copy records nothing",
      rowsPlain !== null && rowsPlain.length === 0,
      rowsPlain === null ? "no agreements table stands" : rowsPlain.length + " rows stand");
    check("stop: the unconfigured terms instance stops cleanly",
      (await stopServer(sPlain)) === 0, "exit " + sPlain.exited());

    // Configured: the deployment names the standing version.
    const portTerms = nextPort;
    const cfgTerms = writeConfig("terms.json", { termsVersion: "2026-11-07" });
    nextPort += 1;
    const sTerms = await startServer(cfgTerms);
    res = await postForm(portTerms, "/setup",
      { name: "Terms Person", password: "terms-person-password", confirm: "terms-person-password" });
    const cookieTerms = sessionOf(res);
    check("#43: a configured copy makes its first account as before",
      res.status === 302 && !!cookieTerms, "status " + res.status);
    const rowsMade = agreementRows("terms.json");
    check("#43: the setup spend records nothing — the record is the joining tick's, and setup is not a joining",
      rowsMade !== null && rowsMade.length === 0,
      rowsMade === null ? "no agreements table stands" : rowsMade.length + " rows stand");
    const stTerms0 = cookieTerms ? await apiCall(portTerms, cookieTerms, "GET", "/api/v1/state")
      : { status: 0, json: null };
    check("#43: a person with no row standing sees no terms standing",
      stTerms0.status === 200 && !!stTerms0.json && !("termsUpdate" in stTerms0.json),
      "status " + stTerms0.status);

    // The row a joining spend wrote at the older version,
    // placed in the data file the way the #107 family ages an
    // invite: the deployment's own spend is what writes it
    // live (the email drill proves that writing); here it
    // stands the re-tick's starting point up.
    const termsFile = join(scratch, "data-termsjson", "tasksparkle.sqlite");
    let seedStood = true;
    try {
      const seedDb = new DatabaseSync(termsFile);
      seedDb.prepare(
        "INSERT INTO agreements (account_key, terms_version, agreed_at, source) VALUES (?, ?, ?, ?)"
      ).run("terms person", "2026-10-01", Date.now(), "join");
      seedDb.close();
    } catch (e) { seedStood = false; }
    check("#43: the agreements table stands for the joining row to be placed",
      seedStood, seedStood ? "" : "the seed insert failed — no agreements table stands");

    const stTerms1 = cookieTerms ? await apiCall(portTerms, cookieTerms, "GET", "/api/v1/state")
      : { status: 0, json: null };
    check("#43: a row older than the configured version makes the state carry the standing, naming the new version",
      stTerms1.status === 200 && !!stTerms1.json && !!stTerms1.json.termsUpdate &&
        stTerms1.json.termsUpdate.changedOn === "2026-11-07",
      "status " + stTerms1.status + " termsUpdate " + JSON.stringify(stTerms1.json && stTerms1.json.termsUpdate));

    const agreeBare = cookieTerms ? await apiCall(portTerms, cookieTerms, "POST", "/api/terms/agree", {})
      : { status: 0, json: null };
    check("#43: the agree route refuses a press with no tick",
      agreeBare.status === 400, "status " + agreeBare.status);
    const agreeUnticked = cookieTerms ? await apiCall(portTerms, cookieTerms, "POST", "/api/terms/agree", { agreed: false })
      : { status: 0, json: null };
    check("#43: the agree route refuses an unticked press",
      agreeUnticked.status === 400, "status " + agreeUnticked.status);
    const rowsRefused = agreementRows("terms.json");
    check("#43: the refused presses wrote no row",
      rowsRefused !== null && rowsRefused.length === 1,
      rowsRefused === null ? "no agreements table stands" : rowsRefused.length + " rows stand");

    const agreeYes = cookieTerms ? await apiCall(portTerms, cookieTerms, "POST", "/api/terms/agree", { agreed: true })
      : { status: 0, json: null };
    check("#43: the ticked press is accepted",
      agreeYes.status === 200, "status " + agreeYes.status);
    const rowsAgreed = agreementRows("terms.json");
    check("#43: the re-tick writes a second row, at the new version, marked as a re-tick",
      rowsAgreed !== null && rowsAgreed.length === 2 &&
        rowsAgreed[1].terms_version === "2026-11-07" && rowsAgreed[1].source === "retick",
      rowsAgreed === null ? "no agreements table stands" : JSON.stringify(rowsAgreed));
    const stTerms2 = cookieTerms ? await apiCall(portTerms, cookieTerms, "GET", "/api/v1/state")
      : { status: 0, json: null };
    check("#43: with the new row standing, the state carries no terms standing",
      stTerms2.status === 200 && !!stTerms2.json && !("termsUpdate" in stTerms2.json),
      "status " + stTerms2.status);
    const agreeAgain = cookieTerms ? await apiCall(portTerms, cookieTerms, "POST", "/api/terms/agree", { agreed: true })
      : { status: 0, json: null };
    const rowsAgain = agreementRows("terms.json");
    check("#43: a press with nothing standing writes no further row",
      agreeAgain.status === 200 && rowsAgain !== null && rowsAgain.length === 2,
      "status " + agreeAgain.status + " rows " + (rowsAgain && rowsAgain.length));

    // A fresh sign-in writes nothing either.
    await getText("http://127.0.0.1:" + portTerms + "/logout", cookieTerms);
    res = await login(portTerms, "Terms Person", "terms-person-password");
    const cookieTerms2 = sessionOf(res);
    check("#43: the person signs back in",
      res.status === 302 && !!cookieTerms2, "status " + res.status);
    const rowsSignedIn = agreementRows("terms.json");
    check("#43: a returning sign-in writes no row",
      rowsSignedIn !== null && rowsSignedIn.length === 2,
      rowsSignedIn === null ? "no agreements table stands" : rowsSignedIn.length + " rows stand");

    // A key neither sees the standing nor answers it.
    const mintedKey = cookieTerms2 ? await apiCall(portTerms, cookieTerms2, "POST", "/api/me/token", { name: "Terms Key" })
      : { status: 0, json: null };
    const keyValue = mintedKey.json && mintedKey.json.key;
    check("#43: the person mints a key for the key-door checks",
      mintedKey.status === 201 && !!keyValue, "status " + mintedKey.status);
    const keyState = keyValue ? await fetch("http://127.0.0.1:" + portTerms + "/api/v1/state", {
      headers: { Authorization: "Bearer " + keyValue },
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))
      : { status: 0, json: null };
    check("#43: a key's state carries no terms standing",
      keyState.status === 200 && !!keyState.json && !("termsUpdate" in keyState.json),
      "status " + keyState.status);
    const keyAgree = keyValue ? await fetch("http://127.0.0.1:" + portTerms + "/api/terms/agree", {
      method: "POST",
      headers: { Authorization: "Bearer " + keyValue, "Content-Type": "application/json" },
      body: JSON.stringify({ agreed: true }),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))
      : { status: 0, json: null };
    check("#43: a key's press on the agree route is refused",
      keyAgree.status === 403, "status " + keyAgree.status);
    const rowsKeyed = agreementRows("terms.json");
    check("#43: the key's refused press wrote no row",
      rowsKeyed !== null && rowsKeyed.length === 2,
      rowsKeyed === null ? "no agreements table stands" : rowsKeyed.length + " rows stand");
    check("stop: the configured terms instance stops cleanly",
      (await stopServer(sTerms)) === 0, "exit " + sTerms.exited());
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(count + " checks, " + failures + " failures");
process.exit(failures === 0 ? 0 : 1);
