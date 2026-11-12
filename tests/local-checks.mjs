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
//                                          a warm machine. The
//                                          smoke tier also carries
//                                          the slop gate scan below
//                                          (deploy issue #202).
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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

// --- The slop gate scan (deploy issue #202) --------------------------
// The fleet's slop gate stands vendored in tools/slop-gate (copied
// from derickca/certifiablemedia's tools/slop-gate; that folder's
// README names the credit and the rules for the copy). The scan
// searches EXTRACTED reader-facing text, never raw files: the pages
// in SLOP_PAGES are staged as they stand, and the string literals of
// the files in SLOP_STRING_FILES are extracted with the reader below
// and staged as text pages of their own, so a watchlist word in a
// code comment is never read, and a word standing in a string is
// read as the words a reader sees. A hit on a ruled entry in the
// service's own words fails the smoke tier; the watchlist's
// [proposed] section is printed as report lines and never fails.
// A literal use of a sense-limited entry — a real agent key, a real
// cryptographic key — stands recorded in the vendored exemptions
// file, against the exact sentence on the exact page it covers.
// The lists are THIS tree's: the scan demands every file its list
// names, so a page missing from a tree that should carry it fails
// here rather than passing in silence. The deploy repo's copy of
// this block names that tree's pages and string files instead —
// the live pages stand only there.
const SLOP_PAGES = ["public/index.html"];
const SLOP_STRING_FILES = [
  ["worker/auth.js", "strings/worker-auth.html"],
  ["public/app.js", "strings/public-app.html"],
];
// The deploy tree also scans its email closing block: a span of one
// file, named here as { file, from, to, out } where this tree has
// none.
const SLOP_FOOTER = null;

// A string-literal reader for whole files: walks the source with a
// small state machine, so comments and regex literals are skipped
// (their words are never reader-facing), quoted strings are
// collected with their escapes undone, and template literals give
// up their text parts while the code inside ${ } is walked as code.
function jsStringLiteralsAll(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  const isIdChar = (c) => /[A-Za-z0-9_$]/.test(c);
  function regexAllowed(prev) {
    if (prev === "") return true;
    if (isIdChar(prev) || prev === ")" || prev === "]" ||
        prev === '"' || prev === "'" || prev === "`") return false;
    return true;
  }
  function scanCode(stopAtBrace) {
    let prev = "";
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") {
        while (i < n && src[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (c === "/" && regexAllowed(prev)) {
        i++;
        let inClass = false;
        while (i < n) {
          if (src[i] === "\\") { i += 2; continue; }
          if (src[i] === "[") inClass = true;
          else if (src[i] === "]") inClass = false;
          else if (src[i] === "/" && !inClass) { i++; break; }
          else if (src[i] === "\n") break;
          i++;
        }
        while (i < n && isIdChar(src[i])) i++;
        prev = '"';
        continue;
      }
      if (c === '"' || c === "'") { scanString(c); prev = '"'; continue; }
      if (c === "`") { scanTemplate(); prev = '"'; continue; }
      if (stopAtBrace) {
        if (c === "{") depth++;
        if (c === "}") {
          if (depth === 0) { i++; return; }
          depth--;
        }
      }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  function unescape(raw) {
    return raw.replace(/\\(.)/g, (m, c) =>
      c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "" : c);
  }
  function scanString(q) {
    i++;
    let raw = "";
    while (i < n) {
      const c = src[i];
      if (c === "\\") { raw += src.slice(i, i + 2); i += 2; continue; }
      if (c === q) { i++; break; }
      if (c === "\n") break;
      raw += c; i++;
    }
    out.push(unescape(raw));
  }
  function scanTemplate() {
    i++;
    let raw = "";
    while (i < n) {
      const c = src[i];
      if (c === "\\") { raw += src.slice(i, i + 2); i += 2; continue; }
      if (c === "`") { i++; break; }
      if (c === "$" && src[i + 1] === "{") {
        out.push(unescape(raw)); raw = "";
        i += 2;
        scanCode(true);
        continue;
      }
      raw += c; i++;
    }
    out.push(unescape(raw));
  }
  scanCode(false);
  return out;
}

// Of the literals collected, the ones that are reader-facing prose:
// markup is stripped to the words it carries (an inline script or
// style body is code, and goes with its tags), and the machinery
// that shares these files — queries, selectors, keyword lists for
// search and icon pickers, bare code fragments — is set aside by
// its shape. A fragment of a composed string stays: the words are
// the reader's, in pieces.
const SLOP_SQL_RE = /\b(SELECT|INSERT INTO|DELETE FROM)\b|^UPDATE\s|\bSET\s+[\w`]+\s*=|\bWHERE\s+[\w`]+\s*=/;
function slopProseStrings(src) {
  const kept = [];
  for (const lit of jsStringLiteralsAll(src)) {
    const text = lit
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (!text.includes(" ")) continue;
    if (text.includes("{") || text.includes("}")) continue;
    if (SLOP_SQL_RE.test(text)) continue;
    if (/[A-Za-z]_[A-Za-z]/.test(text)) continue;
    if (/===|!==|&&|\|\||=>|\('/.test(text)) continue;
    if (/\b(var|let|const)\s+[A-Za-z_$]/.test(text)) continue;
    if (/[\w$]\.[\w$]+\s*=/.test(text)) continue;
    if (text.includes("[data-") || text.includes("] [")) continue;
    if (/^[a-z0-9]+([ -][a-z0-9-]+)+$/.test(text)) continue;
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    const alnum = (text.match(/[A-Za-z0-9]/g) || []).length;
    if (letters < 8) continue;
    if (alnum / text.length < 0.5) continue;
    kept.push(text);
  }
  return kept;
}

function slopGateScan() {
  const gateDir = join(ROOT, "tools", "slop-gate");
  const gate = join(gateDir, "slop-gate.py");
  if (!existsSync(gate)) {
    console.error("Slop gate: the vendored gate is missing at " +
      "tools/slop-gate — the scan cannot run, so the tier fails " +
      "rather than passing over it.");
    return false;
  }
  const named = [...SLOP_PAGES,
    ...SLOP_STRING_FILES.map(([rel]) => rel),
    ...(SLOP_FOOTER ? [SLOP_FOOTER.file] : [])];
  const missing = named.filter((rel) => !existsSync(join(ROOT, rel)));
  if (missing.length) {
    console.error("Slop gate: files this tree's scan list names are " +
      "missing: " + missing.join(", ") + ". The scan demands every " +
      "page and string file on its list; restore the file or take " +
      "it off the list in the open.");
    return false;
  }
  const dist = join(scratch, "slop-dist");
  const stageStrings = (outName, literals) => {
    const esc = (s) => s.replace(/&/g, "&amp;")
      .replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const path = join(dist, outName);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "<!doctype html>\n<html><head><title>" +
      "Extracted strings</title></head><body>\n" +
      literals.map((t) => "<p>" + esc(t) + "</p>").join("\n") +
      "\n</body></html>\n");
  };
  for (const rel of SLOP_PAGES) {
    const dst = join(dist, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(ROOT, rel), dst);
  }
  for (const [rel, outName] of SLOP_STRING_FILES) {
    stageStrings(outName,
      slopProseStrings(readFileSync(join(ROOT, rel), "utf8")));
  }
  if (SLOP_FOOTER) {
    const src = readFileSync(join(ROOT, SLOP_FOOTER.file), "utf8");
    const at = src.indexOf(SLOP_FOOTER.from);
    const span = at < 0 ? "" :
      src.slice(at, src.indexOf(SLOP_FOOTER.to, at));
    stageStrings(SLOP_FOOTER.out, slopProseStrings(span));
  }
  const res = spawnSync("python3", [gate, "check", "--dist", dist],
    { encoding: "utf8" });
  if (res.error || res.status === 2) {
    console.error("Slop gate: the vendored gate could not run (" +
      (res.error ? res.error.message : (res.stderr || "").trim()) +
      "). The scan does not pass a tree it could not read.");
    return false;
  }
  const report = /^(PROPOSED-HIT|FURNITURE-HIT|QUOTE-HIT|EXEMPTED|HIT|REVIEW-FAIL|Slop gate:)/;
  for (const line of (res.stdout || "").split("\n")) {
    if (report.test(line)) console.log(line);
  }
  if (res.status !== 0) {
    console.error("Slop gate: the scan failed — the HIT lines above " +
      "name the pages and the sentences. Fix the words, or, for a " +
      "literal use of a sense-limited entry, record the exemption " +
      "the vendored README describes.");
    return false;
  }
  return true;
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
  if (!slopGateScan()) return false;
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

// The terms record's wiring (issue #43): the schema carries
// the agreements table, both entry points hand the core a
// Terms version read from the deployment's own settings (the
// Worker's TERMS_VERSION, the self-host config's
// termsVersion), and the app carries the gate it stands
// before the boards. A copy that lost a piece would keep the
// record in one shape and drop it in another, silently.
{
  const schema = readFileSync(join(ROOT, "worker", "schema.sql"), "utf8");
  const workerEntry = readFileSync(join(ROOT, "worker", "worker.js"), "utf8");
  const serverEntry = readFileSync(join(ROOT, "server", "server.mjs"), "utf8");
  const index = readFileSync(join(ROOT, "public", "index.html"), "utf8");
  const app = readFileSync(join(ROOT, "public", "app.js"), "utf8");
  const missing = [];
  if (!schema.includes("CREATE TABLE IF NOT EXISTS agreements")) {
    missing.push("worker/schema.sql carries no agreements table");
  }
  if ((workerEntry.match(/termsVersion: termsVersionOf\(env\)/g) || []).length !== 2) {
    missing.push("worker/worker.js does not hand the deployment's TERMS_VERSION to both handler configs");
  }
  if ((serverEntry.match(/termsVersion: config\.termsVersion/g) || []).length !== 2) {
    missing.push("server/server.mjs does not hand the config's termsVersion to both handler configs");
  }
  if (!index.includes('id="terms-state"') || !app.includes("/api/terms/agree")) {
    missing.push("the app carries no terms gate before the boards");
  }
  if (missing.length) {
    console.error("The terms record's wiring is incomplete: " + missing.join("; ") + ".");
    process.exit(1);
  }
  console.log("Terms record: the schema, both entry points and the app's gate stand wired.");
}

// The sign-out wording (issue #45) and the stylesheet's version
// pin (issue #49): the app says Sign out everywhere — the words
// Log out stand nowhere in it — and the app's stylesheet address
// carries the build stamp as its version, so a new build never
// serves a stale sheet under an old address. Both are read off
// the files themselves, the way the terms wiring above is.
{
  const index = readFileSync(join(ROOT, "public", "index.html"), "utf8");
  const core = readFileSync(join(ROOT, "worker", "core.js"), "utf8");
  const stamp = (core.match(/var BUILD_ID = "([^"]*)"/) || [])[1] || null;
  const pin = (index.match(/href="styles\.css\?v=([^"]*)"/) || [])[1] || null;
  const missing = [];
  if (index.includes("Log out")) {
    missing.push("public/index.html still says Log out");
  }
  if (!pin || pin !== stamp) {
    missing.push("the stylesheet's version pin in public/index.html is " +
      (pin || "missing") + ", the build stamp is " + (stamp || "missing"));
  }
  // The step-up refusal (the password dead end): it names
  // the proofs the account can actually give — a
  // passwordless account is named the emailed link.
  if (!core.includes("account.password_hash")) {
    missing.push("the step-up refusal does not judge by the account's standing password");
  }
  if (!core.includes("sign in again through the emailed link, then try again.")) {
    missing.push("the step-up refusal does not name the emailed link to a passwordless account");
  }
  if (missing.length) {
    console.error("The wording and stylesheet pins are off: " + missing.join("; ") + ".");
    process.exit(1);
  }
  console.log("Wording and stylesheet pin: Sign out stands, and the sheet is pinned to " + stamp + ".");
}

// The version check's road (issue #10, settled 2026-11-08):
// the app's standing check reads the static build file and
// never calls the Worker's version route — an open board used
// to spend 1,440 Worker requests a day a tab on that poll —
// and the check pauses while the tab is hidden. The build
// file carries the build stamp itself, so the stamp's copies
// agree or this fails.
{
  const app = readFileSync(join(ROOT, "public", "app.js"), "utf8");
  const core = readFileSync(join(ROOT, "worker", "core.js"), "utf8");
  const stamp = (core.match(/var BUILD_ID = "([^"]*)"/) || [])[1] || null;
  let buildFile = null;
  try { buildFile = JSON.parse(readFileSync(join(ROOT, "public", "build.json"), "utf8")); }
  catch { buildFile = null; }
  const missing = [];
  if (!buildFile || buildFile.build !== stamp) {
    missing.push("public/build.json carries " +
      (buildFile ? JSON.stringify(buildFile.build) : "no readable build") +
      ", the build stamp is " + (stamp || "missing"));
  }
  if (!app.includes("fetch(\"/build.json\"")) {
    missing.push("the app's version check does not read the static build file");
  }
  if (app.includes("fetch(\"/api/version\"")) {
    missing.push("the app still calls the Worker's version route");
  }
  if (!app.includes("if (document.hidden) return;")) {
    missing.push("the version check does not pause while the tab is hidden");
  }
  if (missing.length) {
    console.error("The version check pins are off: " + missing.join("; ") + ".");
    process.exit(1);
  }
  console.log("Version check pin: the standing check reads public/build.json (" +
    stamp + "), never the version route, and pauses while hidden.");
}

// The glyphs are Lucide's own drawings (deploy issue #198,
// Derick's ruling of 2026-11-08, Option B): the path data
// below is copied character for character from the lucide
// repo's icon files (lucide-icons/lucide,
// circle-question-mark.svg, search.svg,
// columns-3.svg, calendar.svg, arrow-up.svg, monitor.svg, settings.svg,
// sun.svg, moon.svg, layout-list.svg,
// text-align-justify-start.svg and star.svg). The header
// glyphs stand in worker/auth.js's HEAD_GLYPHS and, in a
// deployment's layer, on the site's pages — the check below
// further down holds the two copies equal where both stand.
// The topbar's drawings stand in public/index.html's markup,
// and the theme and display buttons' faces in public/app.js.
// A hand drawing swapped back in fails here.
{
  const LUCIDE = {
    help: '<svg viewBox="0 0 24 24" width="44" height="44" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
    overview: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="M15 3v18"/></svg>',
    schedule: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v3"/><path d="M16 2v3"/><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>',
    topSearch: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></svg>',
    settings: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /><circle cx="12" cy="12" r="3" /></svg>',
    backToTop: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>',
    themeSystem: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>',
    themeLight: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
    themeDark: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>',
    doorDefault: '<svg viewBox="0 0 24 24" width="44" height="44" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>',
    doorLight: '<svg viewBox="0 0 24 24" width="44" height="44" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
    doorDark: '<svg viewBox="0 0 24 24" width="44" height="44" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>',
    displayBoth: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/><path d="M14 4h7"/><path d="M14 9h7"/><path d="M14 15h7"/><path d="M14 20h7"/></svg>',
    displayWords: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18"/><path d="M3 12h18"/><path d="M3 19h10"/></svg>',
    displayIcons: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>',
  };
  const index = readFileSync(join(ROOT, "public", "index.html"), "utf8");
  const app = readFileSync(join(ROOT, "public", "app.js"), "utf8");
  const auth = readFileSync(join(ROOT, "worker", "auth.js"), "utf8");
  const glyphSpan = auth.slice(auth.indexOf("var HEAD_GLYPHS = {"),
    auth.indexOf("};", auth.indexOf("var HEAD_GLYPHS = {")));
  const glyphOf = (name) => {
    const m = glyphSpan.match(new RegExp(name + ": \"((?:[^\"\\\\]|\\\\.)*)\""));
    return m ? m[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\") : "";
  };
  const faceOf = (text, name) => {
    const m = text.match(new RegExp(name + ": '(<svg[\\s\\S]*?)'(?=[,\\n])"));
    return m ? m[1] : "";
  };
  const drift = [];
  for (const name of ["help"]) {
    if (glyphOf(name) !== LUCIDE[name]) {
      drift.push("worker/auth.js's " + name + " heading glyph is not Lucide's own drawing");
    }
  }
  for (const name of ["themeDefault", "themeLight", "themeDark"]) {
    const key = "door" + name.slice(5);
    if (glyphOf(name) !== LUCIDE[key]) {
      drift.push("worker/auth.js's " + name + " heading glyph is not Lucide's own drawing");
    }
  }
  for (const name of ["overview", "schedule", "topSearch", "backToTop", "settings"]) {
    if (!index.includes(LUCIDE[name])) {
      drift.push("public/index.html's " + name + " topbar glyph is not Lucide's own drawing");
    }
  }
  if (index.includes('viewBox="0 0 16 16"')) {
    drift.push("public/index.html still carries a glyph drawn on the 16 grid");
  }
  for (const [key, name] of [["themeSystem", "system"], ["themeLight", "light"], ["themeDark", "dark"]]) {
    if (faceOf(app, name) !== LUCIDE[key]) {
      drift.push("public/app.js's " + name + " theme face is not Lucide's own drawing");
    }
  }
  for (const [key, name] of [["displayBoth", "both"], ["displayWords", "words"], ["displayIcons", "icons"]]) {
    if (faceOf(app, name) !== LUCIDE[key]) {
      drift.push("public/app.js's " + name + " display face is not Lucide's own drawing");
    }
  }
  if (drift.length) {
    console.error("The glyphs have drifted from Lucide's own drawings " +
      "(deploy issue #198): " + drift.join("; ") + ". The path data " +
      "stands in the lucide repo's icon files; copy it character " +
      "for character, never redraw it.");
    process.exit(1);
  }
  console.log("Glyphs: the heading, topbar, theme and display drawings " +
    "are Lucide's own path data (deploy issue #198).");
}

// The Standard theme's hairlines (issue #142, Derick's ruling
// on sweep row THM-03): the border colour --line against the
// page background --bg must clear 3:1 in both default
// palettes, measured from the stylesheet itself — so a softer
// value cannot drift back in unmeasured. The standard look's
// colours are the Spark family tokens now (issue #59): the
// stylesheet names them as var(--ms-…) references, so the
// reading resolves each reference through public/tokens.css
// before measuring.
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
function cssVarRaw(block, name) {
  const m = block && block.match(new RegExp("--" + name + ":\\s*([^;]+);"));
  return m ? m[1].trim() : null;
}
// The family tokens for one theme, read from public/tokens.css:
// the theme's own colours with this product's accent laid over
// them, the way the stylesheet's cascade settles them.
function tokenMapOf(tokensCss, theme) {
  const themeBlock = theme === "dark"
    ? themeBlockOf(tokensCss, /^:root\[data-theme="dark"\] \{/m)
    : themeBlockOf(tokensCss, /^:root \{/m);
  const productBlock = theme === "dark"
    ? themeBlockOf(tokensCss, /^:root\[data-theme="dark"\]\[data-product="tasksparkle"\] \{/m)
    : themeBlockOf(tokensCss, /^:root\[data-product="tasksparkle"\] \{/m);
  const map = {};
  for (const block of [themeBlock, productBlock]) {
    if (!block) continue;
    for (const m of block.matchAll(/(--ms-[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) map[m[1]] = m[2];
  }
  return map;
}
function cssVarOf(block, name, tokenMap) {
  const raw = cssVarRaw(block, name);
  if (!raw) return null;
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  const ref = raw.match(/^var\((--ms-[\w-]+)\)$/);
  return ref && tokenMap ? tokenMap[ref[1]] || null : null;
}
{
  const css = readFileSync(join(ROOT, "public", "styles.css"), "utf8");
  const tokensCss = readFileSync(join(ROOT, "public", "tokens.css"), "utf8");
  const readings = [
    ["Standard light", themeBlockOf(css, /^:root \{/m), tokenMapOf(tokensCss, "light")],
    ["Standard dark", themeBlockOf(css, /^:root\[data-theme="dark"\] \{/m), tokenMapOf(tokensCss, "dark")],
  ].map(([label, block, tokenMap]) => {
    const bg = cssVarOf(block, "bg", tokenMap);
    const line = cssVarOf(block, "line", tokenMap);
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

// The Spark family adoption (issue #59, MemberSpark#61): the
// pinned design system at design/system/ is the source; the
// served tokens copy, the product mark and the few values
// that must stand as literals are held to it here, so a
// drift in any copy fails the run instead of reaching a
// visitor. The pairs measured are the ones this product
// paints with: the product accent under its on-accent, in
// both themes, at the text bar of 4.5:1.
{
  const failures = [];
  const pinned = readFileSync(join(ROOT, "design", "system", "tokens.css"), "utf8");
  const served = readFileSync(join(ROOT, "public", "tokens.css"), "utf8");
  if (pinned !== served) {
    failures.push("public/tokens.css differs from the pinned design/system/tokens.css");
  }
  const light = tokenMapOf(served, "light");
  const dark = tokenMapOf(served, "dark");
  for (const [label, map] of [["light", light], ["dark", dark]]) {
    const accent = map["--ms-color-accent"];
    const onAccent = map["--ms-color-on-accent"];
    if (!accent || !onAccent || contrastRatio(onAccent, accent) < 4.5) {
      failures.push("the tasksparkle " + label + " accent pair (on-accent " +
        onAccent + " on accent " + accent + ") is under 4.5:1");
    }
  }
  const css = readFileSync(join(ROOT, "public", "styles.css"), "utf8");
  const standardLight = themeBlockOf(css, /^:root \{/m);
  if (cssVarRaw(standardLight, "bg") !== "var(--ms-color-page)" ||
      cssVarRaw(standardLight, "accent") !== "var(--ms-color-accent)") {
    failures.push("public/styles.css's standard look no longer reads the family tokens");
  }
  for (const [block, map, label] of [
    [themeBlockOf(css, /^:root \{/m), light, "light"],
    [themeBlockOf(css, /^:root\[data-theme="dark"\] \{/m), dark, "dark"],
  ]) {
    const swatch = ".look-swatch-standard-" + label +
      " { background: linear-gradient(135deg, " + map["--ms-color-page"] +
      " 0 55%, " + map["--ms-color-accent"] + " 55% 100%); }";
    if (!css.includes(swatch)) {
      failures.push("the standard " + label + " look swatch in public/styles.css " +
        "does not carry the family page and accent colours");
    }
    void block;
  }
  // The sign-in pages' inline token subset (worker/auth.js's
  // PAGE_STYLE standard blocks): every --ms- value standing
  // there must be the tokens file's own value for that theme.
  const auth = readFileSync(join(ROOT, "worker", "auth.js"), "utf8");
  const pageStyleSpan = auth.slice(auth.indexOf("var PAGE_STYLE = ["),
    auth.indexOf("].join(", auth.indexOf("var PAGE_STYLE = [")));
  const literals = [...pageStyleSpan.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\")).join("\n");
  const subsetOf = (re) => {
    const block = themeBlockOf(literals, re);
    const out = {};
    if (block) {
      for (const m of block.matchAll(/(--ms-[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
    }
    return out;
  };
  for (const [re, map, label] of [
    [/^:root \{/m, light, "light"],
    [/^:root\[data-theme="dark"\] \{/m, dark, "dark"],
  ]) {
    const subset = subsetOf(re);
    if (!Object.keys(subset).length) {
      failures.push("worker/auth.js's " + label + " sign-in palette carries no inline token subset");
    }
    for (const [name, value] of Object.entries(subset)) {
      if (map[name] !== value) {
        failures.push("worker/auth.js's inline " + name + " (" + label + ") is " +
          value + ", the tokens file carries " + (map[name] || "no value"));
      }
    }
  }
  // The product mark: the family's spark drawing on a tile of
  // the light accent, and the places a literal colour must
  // stand — the manifest and the app page's theme colour.
    // The browser icon is the family's spark drawn full-bleed \u2014
  // MemberSpark's favicon construction (Derick, 2026-11-10):
  // the glyph's tips touch the canvas edges, in the light
  // accent. The page mark's tile stands in public/icons/
  // mark.svg, held equal to the account pages' BRAND_MARK by
  // the drift check below.
  const icon = readFileSync(join(ROOT, "public", "icons", "icon.svg"), "utf8");
  if (!icon.includes('d="M12 0l2.933 8.8L24 12l-9.067 3.2L12 24l-2.933-8.8L0 12l9.067-3.2z"')) {
    failures.push("public/icons/icon.svg does not carry the full-bleed spark drawing");
  }
  if (!icon.includes('fill="' + light["--ms-color-accent"] + '"')) {
    failures.push("public/icons/icon.svg is not the tasksparkle light accent");
  }
  // The two kinds never trade places in the page head either:
  // the SVG favicon link names the browser icon (icon.svg); the
  // page tile (mark.svg) stands only as the header image. (The
  // r-43 header-mark swap once rewrote the favicon link too.)
  for (const page of ["index.html", "404.html", "about.html", "feedback.html", "help.html", "learn.html", "privacy.html", "terms.html", "help/agents-and-keys.html", "help/boards-and-cards.html", "help/emailed-link.html", "help/getting-back-in.html", "help/joining.html", "help/passkeys.html"]) {
    const pp = join(ROOT, "public", page);
    if (!existsSync(pp)) continue;
    const html = readFileSync(pp, "utf8");
    if (!html.includes('<link rel="icon" type="image/svg+xml" href="/icons/icon.svg')) {
      failures.push("public/" + page + "'s SVG favicon does not name the browser icon");
    }
    if (html.includes('<link rel="icon" type="image/svg+xml" href="/icons/mark.svg')) {
      failures.push("public/" + page + "'s SVG favicon names the page tile");
    }
  }
  const manifest = JSON.parse(readFileSync(join(ROOT, "public", "manifest.webmanifest"), "utf8"));
  if (manifest.theme_color !== light["--ms-color-accent"]) {
    failures.push("the manifest's theme_color is not the tasksparkle light accent");
  }
  if (manifest.background_color !== light["--ms-color-page"]) {
    failures.push("the manifest's background_color is not the family page colour");
  }
  const index = readFileSync(join(ROOT, "public", "index.html"), "utf8");
  if (!index.includes('<meta name="theme-color" content="' + light["--ms-color-accent"] + '">')) {
    failures.push("public/index.html's theme colour is not the tasksparkle light accent");
  }
  if (failures.length) {
    console.error("Spark family adoption drift (issue #59): " + failures.join("; ") + ".");
    process.exit(1);
  }
  console.log("Spark family adoption: the served tokens match the pinned " +
    "design/system copy, both accent pairs clear 4.5:1, the sign-in " +
    "pages' inline subset matches the tokens, and the mark and the " +
    "standing colours carry the family values.");
}

// Icon-only controls draw at the design system's size (issue
// #61): the pinned components.css holds a 20px Lucide drawing
// in a 44px tap target (.ms-icon-btn), and every icon-only
// control here — the site heading's glyphs, the app header's
// search, theme, Help and settings glyphs and the schedule's
// back-to-top arrow — draws at that same size, its target
// unchanged. The board row's tools (See all columns, Schedule,
// the display button) stand at the same 44px floor since
// issue #67, their drawings at 20px in their own rules.
{
  const failures = [];
  const design = readFileSync(join(ROOT, "design", "system", "components.css"), "utf8");
  const dm = design.match(/\.ms-icon-btn svg \{\s*width: (\d+)px;\s*height: (\d+)px;/);
  if (!dm || dm[1] !== dm[2]) {
    failures.push("the pinned design/system/components.css carries no " +
      ".ms-icon-btn drawing size to hold the controls to");
  }
  const size = dm ? dm[1] : null;
  const holds = (label, text, re) => {
    const m = text.match(re);
    if (!m) { failures.push(label + ": its drawing rule was not found"); return; }
    if (size && (m[1] !== size || m[2] !== size)) {
      failures.push(label + " draws at " + m[1] + "px by " + m[2] +
        "px; the design system's icon drawing is " + size + "px");
    }
  };
  if (size) {
    const auth = readFileSync(join(ROOT, "worker", "auth.js"), "utf8");
    const pageStyleSpan = auth.slice(auth.indexOf("var PAGE_STYLE = ["),
      auth.indexOf("].join(", auth.indexOf("var PAGE_STYLE = [")));
    const literals = [...pageStyleSpan.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => m[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\")).join("\n");
    holds("the site heading's glyphs (worker/auth.js)",
      literals, /\.site-head \.site-link svg \{ width: (\d+)px; height: (\d+)px;/);
    const css = readFileSync(join(ROOT, "public", "styles.css"), "utf8");
    holds("the app header's search, theme, Help and settings glyphs (public/styles.css)",
      css, /#search-toggle svg,\s*#theme-toggle svg,\s*#help-open svg,\s*#settings-open svg \{\s*display: block;\s*width: (\d+)px;\s*height: (\d+)px;/);
    // The settings drawing is Lucide's own, held character for
    // character by the glyph pin above (issue #67); its size
    // rides the combined rule the holds() check just read.
    const index = readFileSync(join(ROOT, "public", "index.html"), "utf8");
    holds("the schedule's back-to-top arrow (public/index.html)",
      index, /id="back-to-top"[\s\S]{0,300}?<svg[^>]* width="(\d+)" height="(\d+)"/);
  }
  if (failures.length) {
    console.error("Icon drawing sizes (issue #61): " + failures.join("; ") + ".");
    process.exit(1);
  }
  console.log("Icon drawings: the site heading's glyphs, the app header's " +
    "search, theme, Help and settings, and the back-to-top arrow all draw at the " +
    "design system's " + size + "px, inside their standing tap targets.");
}

// The review fixes (deploy issues #214–#218): the Pilot tag
// stands beside the product name at the design's measure, the
// brand tile is the design's 36px, the header's right side
// runs Help and the dark toggle with no Feedback entry, the
// display face stands self-hosted in /fonts, and the app
// files and icons carry Part 8's short lives in
// public/_headers. These pins hold
// the shapes at the source; the rendered walks measure them.
{
  const failures = [];
  const css = readFileSync(join(ROOT, "public", "styles.css"), "utf8");
  const auth = readFileSync(join(ROOT, "worker", "auth.js"), "utf8");
  const index = readFileSync(join(ROOT, "public", "index.html"), "utf8");
  const headers = readFileSync(join(ROOT, "public", "_headers"), "utf8");
  const tagRule = /\.pilot-tag \{[^}]*font-size: \.68rem;[^}]*font-weight: 800;[^}]*letter-spacing: \.09em;[^}]*line-height: 1;[^}]*padding: 3px 9px;[^}]*border-radius: 99px;/;
  if (!tagRule.test(css)) {
    failures.push("public/styles.css's Pilot tag does not stand at the " +
      "design's measure (.68rem, 800, .09em, 3px 9px, 99px pill)");
  }
  if (!auth.includes(".site-head .pilot-tag { font-size: .68rem; " +
      "font-weight: 800; letter-spacing: .09em; line-height: 1; " +
      "padding: 3px 9px;")) {
    failures.push("worker/auth.js's Pilot tag copy does not stand at " +
      "the design's measure");
  }
  // The tag's seat: in the app header it stands immediately
  // after the name, and nowhere in the action group.
  const nameAt = index.indexOf("<h1>TaskSparkle</h1>");
  const tagAt = index.indexOf('<span class="pilot-tag">Pilot</span>');
  const actionsAt = index.indexOf('<div class="header-actions">');
  if (!(nameAt >= 0 && tagAt > nameAt && tagAt < actionsAt)) {
    failures.push("public/index.html's Pilot tag does not stand " +
      "beside the product name in the app header");
  }
  if (index.slice(actionsAt).includes("pilot-tag")) {
    failures.push("public/index.html's action group still carries " +
      "the Pilot tag");
  }
  // The brand tile: 36px on the sign-in pages' copy, desktop
  // and phone alike (the stylesheet's own copy is pinned in
  // the deployment tree, where the site section stands).
  if (!auth.includes(".site-brand svg { display: block; " +
      "border-radius: 7px; width: 36px; height: 36px; }") ||
      !auth.includes(".site-brand svg { width: 36px; height: 36px; }")) {
    failures.push("worker/auth.js's brand tile does not stand at " +
      "36px at both widths");
  }
  // The sign-in header's order: brand, tag, then Help and
  // the dark toggle — and no Feedback entry at all: Feedback
  // stands as the footer's word, never in the header
  // (Derick's direction, 2026-11-10, on issue #214).
  const headFn = auth.slice(auth.indexOf("function pageHead"),
    auth.indexOf("\nfunction ", auth.indexOf("function pageHead") + 10));
  const order = ["BRAND_MARK", "pilot-tag", "/help", "data-theme-toggle"];
  let last = -1;
  for (const piece of order) {
    const at = headFn.indexOf(piece, last + 1);
    if (at < 0) {
      failures.push("worker/auth.js's pageHead lost its header " +
        "order at " + piece);
      break;
    }
    last = at;
  }
  if (headFn.includes("/feedback") || auth.includes("data-feedback-link")) {
    failures.push("worker/auth.js still carries a Feedback entry " +
      "for the header");
  }
  // The tag's colours are the design's badge pair, in both
  // copies, and the board tabs' icons stand in the topbar's
  // one drawing size, 20px.
  if (!/\.pilot-tag \{[^}]*color: var\(--ms-color-badge-due-fg\);[^}]*background: var\(--ms-color-badge-due-bg\);/.test(css)) {
    failures.push("public/styles.css's Pilot tag does not wear the " +
      "design's badge colours");
  }
  if (!auth.includes("border-radius: 99px; " +
      "color: var(--ms-color-badge-due-fg); " +
      "background: var(--ms-color-badge-due-bg); }")) {
    failures.push("worker/auth.js's Pilot tag copy does not wear " +
      "the design's badge colours");
  }
  if (!/\.board-tab-icon \{[^}]*width: 20px;[^}]*height: 20px;[^}]*font-size: 20px;/.test(css) ||
      css.includes(".board-tab-icon { font-size: 17px; }")) {
    failures.push("the board tabs' icons do not stand at the " +
      "topbar's 20px drawing size");
  }
  // The display face stands in /fonts with its @font-face.
  if (!existsSync(join(ROOT, "public", "fonts", "bricolage-grotesque.woff2"))) {
    failures.push("public/fonts/bricolage-grotesque.woff2 is missing");
  }
  if (!css.includes('font-family: "Bricolage Grotesque";') ||
      !css.includes('src: url("/fonts/bricolage-grotesque.woff2")')) {
    failures.push("public/styles.css carries no @font-face for the " +
      "display face");
  }
  // Part 8's lives in public/_headers.
  const lives = (path, line) => {
    const at = headers.indexOf("\n" + path + "\n");
    if (at < 0 || !headers.slice(at, at + 200).includes(line)) {
      failures.push("public/_headers gives " + path + " no " + line);
    }
  };
  const HOUR = "Cache-Control: public, max-age=3600, stale-while-revalidate=86400";
  const DAY = "Cache-Control: public, max-age=86400";
  for (const p of ["/boot.js", "/app.js", "/manifest.webmanifest", "/sw.js"]) {
    lives(p, HOUR);
  }
  for (const p of ["/favicon.ico", "/icons/icon-192.png", "/icons/icon-512.png",
      "/icons/icon-maskable-512.png", "/icons/icon-180.png",
      "/icons/icon-64.png", "/icons/icon.svg"]) {
    lives(p, DAY);
  }
  if (failures.length) {
    console.error("Review fixes (deploy issues #214–#218): " +
      failures.join("; ") + ".");
    process.exit(1);
  }
  console.log("Review fixes: the Pilot tag stands beside the name at " +
    "the design's measure, the tile at 36px, the header order runs " +
    "Help and the toggle with no Feedback entry, the display face stands in /fonts, and " +
    "_headers carries Part 8's short lives.");
}

{
  // Standards round 2 (deploy issues #219, #220). Part 9:
  // fonts do not swap — the display face loads with
  // font-display: optional, and the reading pages preload
  // it (the preload stands in the deployment tree, whose
  // pages those are; its checks hold it there). Part 2: a
  // header that carries wayfinding sticks to the top — the
  // sign-in pages' header copy carries the stick in this
  // tree; the site stylesheet's copy stands in the
  // deployment tree, held there the same way.
  const failures = [];
  const css = readFileSync(join(ROOT, "public", "styles.css"), "utf8");
  const auth = readFileSync(join(ROOT, "worker", "auth.js"), "utf8");
  const faceAt = css.indexOf('font-family: "Bricolage Grotesque";');
  const faceBlock = css.slice(faceAt, css.indexOf("}", faceAt));
  if (!faceBlock.includes("font-display: optional;") ||
      faceBlock.includes("font-display: swap;")) {
    failures.push("the display face does not load with " +
      "font-display: optional, so headings swap on first paint");
  }
  if (!/\.site-head \{[^}]*position: sticky;[^}]*top: 0;/.test(auth)) {
    failures.push("worker/auth.js's header copy does not stick " +
      "to the top");
  }
  if (failures.length) {
    console.error("Standards round 2 (deploy issues #219, " +
      "#220): " + failures.join("; ") + ".");
    process.exit(1);
  }
  console.log("Standards round 2: the display face loads with " +
    "font-display: optional, and the sign-in pages' header " +
    "copy sticks to the top.");
}


{
  // Standards round 3 (deploy issue #221). Part 2: the
  // Pilot tag stands inside the name-and-logo home link —
  // part of the brand unit, not its own element in the
  // header row split off by the header's gap. The sign-in
  // pages' header copy and the front page's landing header
  // carry the grouping here; the reading pages' copies
  // stand in the deployment tree, held there the same way.
  const failures = [];
  const auth = readFileSync(join(ROOT, "worker", "auth.js"), "utf8");
  const index = readFileSync(join(ROOT, "public", "index.html"), "utf8");
  const headFn = auth.slice(auth.indexOf("function pageHead"),
    auth.indexOf("\nfunction ", auth.indexOf("function pageHead") + 10));
  const tagAt = headFn.indexOf("pilot-tag");
  const linksAt = headFn.indexOf("var links");
  if (!(tagAt > headFn.indexOf("BRAND_MARK") && tagAt < linksAt) ||
      headFn.slice(linksAt).includes("pilot-tag")) {
    failures.push("worker/auth.js's Pilot tag does not stand " +
      "inside the name-and-logo home link");
  }
  // The tag must be built into the brand ahead of the
  // heading's first return, applied by no later replace:
  // a copy that names no site address takes that early
  // return, and its brand once came back tagless because
  // the tag was patched in afterwards, on the other path
  // only (issue #94).
  const firstReturn = headFn.indexOf("return");
  if (!headFn.slice(0, firstReturn).includes("pilot-tag") ||
      headFn.includes("brand.replace")) {
    failures.push("worker/auth.js's Pilot tag is not built " +
      "into the brand ahead of the heading's first return, " +
      "so a copy naming no site address would stand tagless");
  }
  const headAt = index.indexOf('<header class="site-head">');
  if (headAt >= 0) {
    const head = index.slice(headAt, index.indexOf("</header>", headAt));
    const brandAt = head.indexOf('<a class="site-brand"');
    const brandEnd = head.indexOf("</a>", brandAt);
    const headTagAt = head.indexOf("pilot-tag");
    if (!(headTagAt > brandAt && headTagAt < brandEnd)) {
      failures.push("the front page's Pilot tag does not stand " +
        "inside the name-and-logo home link");
    }
  }
  if (failures.length) {
    console.error("Standards round 3 (deploy issue #221): " +
      failures.join("; ") + ".");
    process.exit(1);
  }
  console.log("Standards round 3: the Pilot tag stands inside " +
    "the name-and-logo home link in the sign-in pages' copy " +
    "and on the front page.");
}

// The account pages' palette, boot script and heading
// drawings are copies of the site's own (public/styles.css,
// public/boot.js, the site pages' heading), standing inline
// in worker/auth.js because those pages' policy allows no
// stylesheet or script file but their own inline ones. The
// three checks below hold the copies equal to their
// originals, so a change to a palette, the settling rules
// or a glyph that misses the copy fails here rather than
// reaching a visitor as pages whose colours or heading
// changed between the site's pages and the sign-in page.
function jsStringLiterals(text, from, to) {
  const span = text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));
  return [...span.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\")).join("\n");
}
function paletteBlocksOf(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const ok = /^:root(\[data-theme="dark"\]|\[data-look="[a-z]+"\](\[data-theme="dark"\])?)?$/;
  const blocks = {};
  for (const m of css.matchAll(/(:root[^{]*)\{([^}]*)\}/g)) {
    const sel = m[1].slice(m[1].lastIndexOf(":root")).trim();
    if (!ok.test(sel) || blocks[sel]) continue;
    const vars = {};
    for (const vm of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[vm[1]] = vm[2].trim();
    const scheme = m[2].match(/color-scheme:\s*(\w+)/);
    blocks[sel] = { scheme: scheme ? scheme[1] : "", vars };
  }
  return blocks;
}
{
  const auth = readFileSync(join(ROOT, "worker", "auth.js"), "utf8");
  const pageStyle = jsStringLiterals(auth, "var PAGE_STYLE = [", "].join(");
  const css = readFileSync(join(ROOT, "public", "styles.css"), "utf8");
  const used = ["--bg", "--column-bg", "--ink", "--accent", "--accent-ink",
    "--field-bg", "--danger-bg", "--danger-ink", "--danger-border",
    "--font", "--font-display"];
  const fromCss = paletteBlocksOf(css);
  const fromPages = paletteBlocksOf(pageStyle);
  const drift = [];
  for (const sel of new Set([...Object.keys(fromCss), ...Object.keys(fromPages)])) {
    const a = fromCss[sel]; const b = fromPages[sel];
    if (!a || !b) { drift.push(sel + " stands in only one of the two"); continue; }
    if (a.scheme !== b.scheme) drift.push(sel + " colour scheme " + a.scheme + " vs " + b.scheme);
    for (const v of used) {
      if ((a.vars[v] || "") !== (b.vars[v] || "")) {
        drift.push(sel + " " + v + ": " + (a.vars[v] || "unset") + " vs " + (b.vars[v] || "unset"));
      }
    }
  }
  if (drift.length) {
    console.error("The account pages' palette copy has drifted from " +
      "public/styles.css: " + drift.join("; ") + ". The sign-in pages " +
      "would paint in different colours from the site's pages. Bring " +
      "worker/auth.js's PAGE_STYLE palette back in line.");
    process.exit(1);
  }
  console.log("Account pages' palette: the copy in worker/auth.js matches " +
    "public/styles.css across all " + Object.keys(fromCss).length +
    " look and theme blocks.");
}
{
  const auth = readFileSync(join(ROOT, "worker", "auth.js"), "utf8");
  const pageBoot = jsStringLiterals(auth, "var PAGE_BOOT = [", "].join(");
  const boot = readFileSync(join(ROOT, "public", "boot.js"), "utf8");
  const looksOf = (t) => {
    const m = t.match(/var looks = \[([^\]]*)\]/);
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort() : [];
  };
  const facts = [
    ["the device store's key", "tasksparkle-device"],
    ["the mirror store's key", "tasksparkle-mirror"],
    ["the theme attribute", "data-theme"],
    ["the theme mode attribute", "data-theme-mode"],
    ["the look attribute", "data-look"],
  ];
  const drift = [];
  for (const [label, needle] of facts) {
    if (!boot.includes(needle) || !pageBoot.includes(needle)) {
      drift.push(label + " (" + needle + ") stands in only one of the two");
    }
  }
  if (JSON.stringify(looksOf(boot)) !== JSON.stringify(looksOf(pageBoot))) {
    drift.push("the look lists differ: " + looksOf(boot).join(", ") +
      " vs " + looksOf(pageBoot).join(", "));
  }
  if (drift.length) {
    console.error("The account pages' settling script has drifted from " +
      "public/boot.js: " + drift.join("; ") + ". The two must settle a " +
      "visitor's stored theme and look the same way.");
    process.exit(1);
  }
  console.log("Account pages' settling script: the copy in worker/auth.js " +
    "reads the same stores and settles the same looks as public/boot.js.");
}
{
  // The glyph originals stand with the site's pages, which a
  // deployment's layer carries; a tree without them has no
  // original to compare against, and the deployment tree's
  // own run of this check holds the copies equal there.
  const termsPath = join(ROOT, "public", "terms.html");
  if (!existsSync(termsPath)) {
    console.log("Account pages' heading drawings: no site pages stand " +
      "in this tree to compare against — the check runs in the tree " +
      "that carries them.");
  } else {
  const auth = readFileSync(join(ROOT, "worker", "auth.js"), "utf8");
  const glyphSpan = auth.slice(auth.indexOf("var HEAD_GLYPHS = {"),
    auth.indexOf("};", auth.indexOf("var HEAD_GLYPHS = {")));
  const terms = readFileSync(termsPath, "utf8");
  const icon = readFileSync(join(ROOT, "public", "icons", "mark.svg"), "utf8");
  const svgOf = (html, label) => {
    const m = html.match(new RegExp("aria-label=\\\"" + label + "\\\"[^>]*><svg[^>]*>[\\s\\S]*?</svg>"));
    return m ? m[0].slice(m[0].indexOf("<svg")) : "";
  };
  const glyphOf = (name) => {
    const m = glyphSpan.match(new RegExp(name + ": \"((?:[^\"\\\\]|\\\\.)*)\""));
    return m ? m[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\") : "";
  };
  const drift = [];
  for (const [name, label] of [["help", "Help"]]) {
    if (!glyphOf(name) || glyphOf(name) !== svgOf(terms, label)) {
      drift.push("the " + label + " glyph differs from the site pages'");
    }
  }
  const brandOf = () => {
    const span = jsStringLiterals(auth, "var BRAND_MARK =", ";");
    const m = span.match(/<svg[\s\S]*<\/svg>/);
    return m ? m[0] : "";
  };
  const squash = (s) => s.replace(/\s+/g, " ").replace(/> </g, "><").trim();
  const innerOf = (svg) => {
    const open = svg.indexOf(">");
    return open === -1 ? "" : squash(svg.slice(open + 1, svg.lastIndexOf("</svg>")));
  };
  if (!brandOf() || innerOf(brandOf()) !== innerOf(icon)) {
    drift.push("the brand mark differs from public/icons/mark.svg");
  }
  if (drift.length) {
    console.error("The account pages' heading drawings have drifted: " +
      drift.join("; ") + ". Bring worker/auth.js's BRAND_MARK and " +
      "HEAD_GLYPHS back in line with the site pages.");
    process.exit(1);
  }
  console.log("Account pages' heading drawings: the brand mark and the " +
    "Help glyph in worker/auth.js match the site pages' own.");
  }
}
{
  // The heading's measures and the frame's: the account
  // pages' inline copies of the heading's rules and of the
  // frame's rules (the body rule and the reading column)
  // must give those pages the same boxes the site
  // stylesheet gives the site's pages — same padding, gaps,
  // sizes, standing height and phone rules, the frame's
  // same width, centring and side padding — or the account
  // pages would stand in different margins from the site's
  // pages. The rendered walks measure the boxes themselves;
  // this check holds the rules that produce them equal at
  // the source (issues #39, #40).
  const auth = readFileSync(join(ROOT, "worker", "auth.js"), "utf8");
  const pageStyle = jsStringLiterals(auth, "var PAGE_STYLE = [", "].join(");
  const css = readFileSync(join(ROOT, "public", "styles.css"), "utf8");
  if (!css.includes(".site-head {")) {
    console.log("Account pages' heading rules: the site stylesheet in " +
      "this tree carries no site heading to compare against — the " +
      "check runs in the tree that carries it.");
  } else {
  const rulesOf = (text) => {
    text = text.replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = {};
    for (const m of text.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      const decls = {};
      for (const d of m[2].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) decls[d[1]] = d[2].trim();
      for (const sel of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        rules[sel] = { ...(rules[sel] || {}), ...decls };
      }
    }
    return rules;
  };
  const tailOf = (text) => text.slice(text.lastIndexOf("@media (max-width: 640px)"));
  const pairs = [
    [".site-head", ["display", "align-items", "gap", "padding", "min-height"]],
    [".site-brand", ["display", "align-items", "gap", "color",
      "text-decoration", "font-family", "font-weight", "font-size"]],
    [".site-links", ["display", "align-items", "gap", "margin-left"]],
    [".site-link", ["display", "align-items", "justify-content", "gap",
      "color", "text-decoration", "font-size", "min-width", "height",
      "padding", "border-radius"]],
    [".site-head .site-link", ["min-width", "height", "padding"]],
    [".site-head .site-link svg", ["width", "height", "flex"]],
    [".site-link:hover", ["background"]],
  ];
  const phonePairs = [
    [".site-link", ["padding"]],
    [".site-brand", ["order", "font-size", "gap"]],
    [".site-head", ["flex-wrap", "row-gap", "padding-top", "padding-bottom",
      "min-height"]],
    [".site-links", ["order", "flex-basis", "margin-left"]],
  ];
  const framePairs = [
    ["body", ["margin", "font-family", "background", "color", "line-height"]],
    [".static-wrap", ["max-width", "margin", "padding"]],
  ];
  const drift = [];
  const compare = (aRules, bRules, selA, selB, props, where) => {
    for (const p of props) {
      const a = aRules[selA] && aRules[selA][p];
      const b = bRules[selB] && bRules[selB][p];
      if ((a || "") !== (b || "")) {
        drift.push(where + " " + selA + " " + p + ": " + (a || "unset") + " vs " + (b || "unset"));
      }
    }
  };
  const cssRules = rulesOf(css); const pageRules = rulesOf(pageStyle);
  for (const [sel, props] of framePairs) compare(cssRules, pageRules, sel, sel, props, "frame");
  for (const [sel, props] of pairs) compare(cssRules, pageRules, sel, sel, props, "heading");
  compare(cssRules, pageRules, ".site-brand img", ".site-brand svg",
    ["display", "border-radius", "width", "height"], "heading");
  const cssPhone = rulesOf(tailOf(css)); const pagePhone = rulesOf(tailOf(pageStyle));
  for (const [sel, props] of phonePairs) compare(cssPhone, pagePhone, sel, sel, props, "phone heading");
  compare(cssPhone, pagePhone, ".site-brand img", ".site-brand svg",
    ["width", "height"], "phone heading");
  if (drift.length) {
    console.error("The account pages' heading and frame rules have " +
      "drifted from public/styles.css: " + drift.join("; ") + ". The " +
      "heading or the frame would stand in a different box on the " +
      "sign-in pages than on the site's pages. Bring worker/auth.js's " +
      "PAGE_STYLE heading and frame rules back in line.");
    process.exit(1);
  }
  console.log("Account pages' heading and frame rules: the measures in " +
    "worker/auth.js match public/styles.css, phone rules included.");
  }
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
