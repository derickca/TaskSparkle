// TaskSparkle local checks: the one-command way to run the
// standing drills on your own machine, with no Cloudflare account
// and no live deployment involved. This is what `npm test` runs
// and what the pull request checks run in GitHub.
//
//     node tests/local-checks.mjs          the API drill (self-host
//                                          mode) and the server drill
//     node tests/local-checks.mjs --ui     the same, plus the UI drill
//                                          (needs the Playwright setup
//                                          in tests/README.md)
//     node tests/local-checks.mjs --smoke  the smoke tier (issue
//                                          #140): syntax, the build-
//                                          stamp agreement, the route
//                                          check below and one live
//                                          boot walked at the API
//                                          level. No drills, no
//                                          browser. This is what
//                                          `npm run test:smoke` runs —
//                                          a small change's quick
//                                          verdict, under a minute on
//                                          a warm machine.
//
// The harness writes a throwaway nameless config (issue #107:
// the config holds no people) into a scratch folder, starts the
// self-host server on port 8793 against it, and runs the drills
// at that instance. Before the API drill starts, the harness
// sets each drill person's password the way a person would: it
// mints an invite carrying their name with the server's --invite
// command (the recovery door) and redeems it over HTTP with the
// drill password for that person. The two drill people are the
// accounts named Drill A and Drill B.
// Before any drill runs, one standing check reads the standalone
// sign-in pages (worker/auth.js serves them: sign-in, setup and
// invite) for every address they call or post to, and the route
// patterns in wrangler.toml.example, and fails if a called address
// is covered by no pattern. On the hosted copy those patterns are
// the deployment's route list; a sign-in call that matches no
// route falls through to the static site and fails, while every
// local drill still passes, because here one server answers every
// address. Issue #111 was exactly that miss.
// The instance is then exercised end to end: sign-in, boards, keys,
// erasure.
// The server drill starts its own throwaway instances on its own
// ports and needs nothing from this harness but the call.
//
// Nothing here touches a real config or a real data file: the
// scratch folder is deleted when the run ends, pass or fail. The
// exit status is nonzero when any drill fails.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PORT = 8793;
const BASE = "http://localhost:" + PORT;
const PW_A = "drill-a-own-password";
const PW_B = "drill-b-own-password";
const WITH_UI = process.argv.includes("--ui");
const WITH_SMOKE = process.argv.includes("--smoke");
const STARTED_AT = Date.now();

const scratch = mkdtempSync(join(tmpdir(), "tasksparkle-checks-"));
const configPath = join(scratch, "config.json");
// No sessionSecret: sessions are rows in the shared tables
// now (issue #109), and the harness proves the copy stands
// without the retired field.
writeFileSync(configPath, JSON.stringify({
  address: BASE,
  agentHost: "localhost:" + PORT,
  dataDir: "data",
  host: "127.0.0.1",
  port: PORT,
}, null, 2));

// --- The smoke tier's static checks (issue #140) --------------------
// Syntax and the build stamps are steps of the smoke tier only;
// the full harness leaves them to the pull request checks' own
// steps, which run the same commands. The syntax walk covers the
// tree the way a clean checkout stands: every .js and .mjs file
// outside node_modules and .git, checked one by one with
// node --check, the way checks.yml walks the tracked files.
let smokeStamp = null;
function treeScriptFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) found.push(full);
    }
  };
  walk(ROOT);
  return found.sort();
}

function smokeStaticChecks() {
  const files = treeScriptFiles();
  const broken = [];
  for (const file of files) {
    const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (res.status !== 0) broken.push({ file, err: (res.stderr || "").trim() });
  }
  if (broken.length) {
    for (const b of broken) {
      console.error("Syntax: " + b.file.slice(ROOT.length) + " does not parse:\n" + b.err);
    }
    return false;
  }
  console.log("Syntax: " + files.length + " script files parse.");
  const stampOf = (rel) => {
    const m = readFileSync(join(ROOT, rel), "utf8").match(/var BUILD_ID = "([^"]*)"/);
    return m ? m[1] : null;
  };
  const workerStamp = stampOf(join("worker", "core.js"));
  const appStamp = stampOf(join("public", "app.js"));
  smokeStamp = workerStamp;
  if (!workerStamp || workerStamp !== appStamp) {
    console.error("Build stamps disagree: worker/core.js carries " +
      (workerStamp || "no stamp") + ", public/app.js carries " +
      (appStamp || "no stamp") + ".");
    return false;
  }
  console.log("Build stamps agree: " + workerStamp + ".");
  return true;
}

if (WITH_SMOKE && !smokeStaticChecks()) {
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}

// The standalone sign-in pages' addresses, read out of the pages
// themselves: every fetch call and form action they carry, every
// address the handler answers at, and the invite address with a
// sample code standing in for a real one. A pattern covers an
// address when it is the address exactly, or ends in /* and the
// address stands under that prefix. Returns the uncovered list.
function uncoveredStandalonePaths() {
  const auth = readFileSync(join(ROOT, "worker", "auth.js"), "utf8");
  const example = readFileSync(join(ROOT, "wrangler.toml.example"), "utf8");
  const paths = new Set();
  for (const m of auth.matchAll(/fetch\('(\/[^']+)'/g)) paths.add(m[1]);
  for (const m of auth.matchAll(/action=\\?"(\/[^"\\']+)/g)) paths.add(m[1]);
  for (const m of auth.matchAll(/path === "(\/[^"]+)"/g)) paths.add(m[1]);
  if (auth.includes("/^\\/invite\\/")) paths.add("/invite/CODE");
  for (const p of [...paths]) {
    if (p.startsWith("/invite/") && !p.endsWith("/")) paths.add("/invite/CODE");
    if (p.endsWith("/")) paths.delete(p);
  }
  const patterns = [...example.matchAll(/pattern\s*=\s*"[^"/]*(\/[^"]*)"/g)]
    .map((m) => m[1]);
  const covered = (p) => patterns.some((pat) =>
    pat === p || (pat.endsWith("/*") && p.startsWith(pat.slice(0, -1))));
  return [...paths].filter((p) => !covered(p)).sort();
}

const uncovered = uncoveredStandalonePaths();
if (uncovered.length) {
  console.error("The standalone sign-in pages call addresses no route " +
    "pattern in wrangler.toml.example covers: " + uncovered.join(", ") +
    ". On the hosted copy those calls would fall through to the static " +
    "site and fail. Add the patterns to wrangler.toml.example (and to " +
    "the deployment's own settings) and run this again.");
  process.exit(1);
}
console.log("Standalone sign-in routes: every address the sign-in, " +
  "setup and invite pages call is covered by wrangler.toml.example.");

// The Standard theme's hairlines (issue #142, Derick's ruling
// on sweep row THM-03): the border colour --line against the
// page background --bg must clear 3:1 in both default
// palettes, measured from the stylesheet itself — so a softer
// value cannot drift back in unmeasured.
function hexLuminance(hex) {
  const chan = (i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(1) + 0.7152 * chan(3) + 0.0722 * chan(5);
}
function contrastRatio(a, b) {
  const la = hexLuminance(a); const lb = hexLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function themeBlockOf(css, selectorRe) {
  const m = css.match(selectorRe);
  if (!m) return null;
  const open = css.indexOf("{", m.index);
  return css.slice(open, css.indexOf("}", open));
}
function cssVarOf(block, name) {
  const m = block && block.match(new RegExp("--" + name + ":\\s*(#[0-9a-fA-F]{6})"));
  return m ? m[1] : null;
}
{
  const css = readFileSync(join(ROOT, "public", "styles.css"), "utf8");
  const readings = [
    ["Standard light", themeBlockOf(css, /^:root \{/m)],
    ["Standard dark", themeBlockOf(css, /^:root\[data-theme="dark"\] \{/m)],
  ].map(([label, block]) => {
    const bg = cssVarOf(block, "bg");
    const line = cssVarOf(block, "line");
    return { label, bg, line, ratio: bg && line ? contrastRatio(line, bg) : 0 };
  });
  if (readings.some((r) => !(r.ratio >= 3))) {
    console.error("Standard theme hairlines under the 3:1 bar (issue #142): " +
      readings.map((r) => r.label + " --line " + r.line + " on --bg " + r.bg +
        " = " + r.ratio.toFixed(2) + ":1").join("; ") + ".");
    process.exit(1);
  }
  console.log("Standard theme hairlines: " +
    readings.map((r) => r.label + " " + r.ratio.toFixed(2) + ":1").join(", ") +
    " — both clear 3:1 (issue #142).");
}

let server = null;
function stopServer() {
  if (server && !server.killed) server.kill();
  server = null;
}

// Set one person's password through their invite, the person's
// own route: mint the invite (it carries the person's name) with
// the server's command, then press the Set password button over
// HTTP, as the redemption page does. No name field is sent — the
// account takes the invite's name, as it does for a person who
// leaves the field as it stands.
async function setPasswordByInvite(name, password) {
  const out = execFileSync(process.execPath, [
    join(ROOT, "server", "server.mjs"), "--config", configPath, "--invite", name,
  ], { encoding: "utf8" });
  const m = out.match(/\/invite\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error("minting an invite for " + name + " printed no link");
  const res = await fetch(BASE + "/invite/" + m[1], {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password, confirm: password }).toString(),
  });
  const cookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (!cookie.some((c) => c.startsWith("ts_session="))) {
    throw new Error("redeeming the invite for " + name + " set no session cookie (status " + res.status + ")");
  }
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(BASE + "/login");
      if (res.status === 200) return true;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// The smoke tier's live boot (issue #140): one person arriving the
// way a person arrives — an invite minted by the server's own
// command and redeemed over HTTP, then a password sign-in — and
// the smallest honest exercise of the standing copy: the seeded
// state read, one card made and read back, and the version and
// directions stamps. Steps mint and redeem the way
// setPasswordByInvite does for the drills; here each step is a
// named check instead of a thrown error. API level only — the
// browser belongs to the UI drill.
let smokeFailures = 0;
function smokeCheck(name, cond, detail) {
  if (!cond) smokeFailures += 1;
  console.log((cond ? "PASS" : "FAIL") + "  smoke: " + name + (detail ? "  — " + detail : ""));
  return !!cond;
}

async function smokeWalk() {
  const password = "smoke-own-password";
  let cookie = null;
  const sessionOf = (res) => {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    return set.map((c) => c.split(";")[0])
      .find((c) => c.startsWith("ts_session=") && c.length > "ts_session=".length) || null;
  };
  const formPost = async (path, fields) => {
    const res = await fetch(BASE + path, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    const found = sessionOf(res);
    await res.text();
    return { status: res.status, cookie: found };
  };
  const call = async (method, path, body) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    let payload = null;
    if (body != null) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers, body: payload, redirect: "manual" });
    const rotated = sessionOf(res);
    if (rotated) cookie = rotated;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* the directions are plain text */ }
    return { status: res.status, text, json };
  };

  let code = null;
  try {
    const out = execFileSync(process.execPath, [
      join(ROOT, "server", "server.mjs"), "--config", configPath, "--invite", "Smoke",
    ], { encoding: "utf8" });
    const m = out.match(/\/invite\/([A-Za-z0-9_-]+)/);
    if (m) code = m[1];
  } catch (e) { /* the check below names the failure */ }
  if (!smokeCheck("the server command mints an invite", !!code)) return false;

  const spent = await formPost("/invite/" + code, { password, confirm: password });
  if (!smokeCheck("the invite redeems and sets the password", !!spent.cookie,
    "status " + spent.status)) return false;

  const signed = await formPost("/login", { name: "Smoke", password });
  if (!smokeCheck("the password signs in", !!signed.cookie,
    "status " + signed.status)) return false;
  cookie = signed.cookie;

  let res = await call("GET", "/api/v1/state");
  const st = res.json;
  const personal = st && Array.isArray(st.boards)
    ? st.boards.find((b) => b.name === "Personal") : null;
  if (!smokeCheck("the seeded state reads back",
    res.status === 200 && !!personal &&
      !!st.boards.find((b) => b.name === "Professional") &&
      typeof st.version === "number",
    "status " + res.status)) return false;

  res = await call("POST", "/api/v1/cards",
    { board_id: personal.id, column_id: "inbox", title: "Smoke card" });
  const cardId = res.json && res.json.card && res.json.card.id;
  if (!smokeCheck("a card is made", res.status === 201 && !!cardId,
    "status " + res.status)) return false;

  res = await call("GET", "/api/v1/state");
  const card = res.json && Array.isArray(res.json.cards)
    ? res.json.cards.find((c) => c.id === cardId) : null;
  smokeCheck("the card reads back in the inbox",
    !!card && card.title === "Smoke card" && card.columnId === "inbox",
    card ? card.columnId : "missing");

  res = await call("GET", "/api/v1/version");
  smokeCheck("the version answer carries the build stamp",
    res.status === 200 && res.json && res.json.build === smokeStamp,
    res.json ? "build " + res.json.build : "status " + res.status);

  res = await call("GET", "/api/v1/directions");
  smokeCheck("the directions carry the same stamp",
    res.status === 200 && res.text.includes("Build: " + smokeStamp),
    "status " + res.status);

  return smokeFailures === 0;
}

function run(label, args) {
  console.log("\n=== " + label + " ===");
  const res = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (res.status !== 0) {
    console.log("=== " + label + ": FAILED ===");
    return false;
  }
  console.log("=== " + label + ": passed ===");
  return true;
}

let ok = true;
try {
  server = spawn(process.execPath,
    [join(ROOT, "server", "server.mjs"), "--config", configPath],
    { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
  if (!(await waitForServer())) {
    console.error("The throwaway server did not answer on " + BASE + " — the drills cannot run.");
    process.exit(1);
  }

  if (WITH_SMOKE) {
    ok = (await smokeWalk()) && ok;
  } else {
    await setPasswordByInvite("Drill A", PW_A);
    await setPasswordByInvite("Drill B", PW_B);

    ok = run("API drill, self-host mode", [
      join(HERE, "api-drill.mjs"),
      "--base", BASE, "--mode", "selfhost",
      "--password-a", PW_A, "--password-b", PW_B,
      "--server-config", configPath,
    ]) && ok;

    if (WITH_UI) {
      ok = run("UI drill", [
        join(HERE, "ui-drill.mjs"),
        "--base", BASE,
        "--name", "Drill A", "--password", PW_A,
        // B's password for the UI drill is the API drill's
        // fresh-start one: the erasure family ends the API
        // drill by erasing B and starting B again from an
        // invite spent with "drill-b-fresh-password".
        "--password-b", "drill-b-fresh-password",
        "--out", join(scratch, "shots"),
        // The change-password walk ages the session's proof in
        // the data file, so the proof panel it answers is the
        // server's own refusal (issue #114).
        "--data-file", join(scratch, "data", "tasksparkle.sqlite"),
      ]) && ok;
    }

    stopServer();
    ok = run("Server drill", [join(HERE, "server-drill.mjs")]) && ok;
  }
} finally {
  stopServer();
  rmSync(scratch, { recursive: true, force: true });
}

if (WITH_SMOKE) {
  console.log(ok ? "\nAll smoke checks passed." : "\nSmoke checks FAILED — read the first failure above.");
  // The tier's own evidence, printed by the harness itself: the
  // budget is a target the README states, never a failure line —
  // a loaded machine is not a broken build (issue #140).
  console.log("Elapsed: " + ((Date.now() - STARTED_AT) / 1000).toFixed(1) + "s");
} else {
  console.log(ok ? "\nAll local checks passed." : "\nLocal checks FAILED — read the first drill failure above.");
}
process.exit(ok ? 0 : 1);
