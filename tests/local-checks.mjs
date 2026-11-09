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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  const icon = readFileSync(join(ROOT, "public", "icons", "icon.svg"), "utf8");
  const svgOf = (html, label) => {
    const m = html.match(new RegExp("aria-label=\\\"" + label + "\\\"[^>]*><svg[^>]*>[\\s\\S]*?</svg>"));
    return m ? m[0].slice(m[0].indexOf("<svg")) : "";
  };
  const glyphOf = (name) => {
    const m = glyphSpan.match(new RegExp(name + ": \"((?:[^\"\\\\]|\\\\.)*)\""));
    return m ? m[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\") : "";
  };
  const drift = [];
  for (const [name, label] of [["terms", "Terms"], ["feedback", "Feedback"], ["help", "Help"]]) {
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
    drift.push("the brand mark differs from public/icons/icon.svg");
  }
  if (drift.length) {
    console.error("The account pages' heading drawings have drifted: " +
      drift.join("; ") + ". Bring worker/auth.js's BRAND_MARK and " +
      "HEAD_GLYPHS back in line with the site pages.");
    process.exit(1);
  }
  console.log("Account pages' heading drawings: the brand mark and the " +
    "three glyphs in worker/auth.js match the site pages' own.");
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
