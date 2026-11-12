// The rig teardown check (issue #157): a Worker rig's dev stack
// must never outlive its rig folder.
//
// The sweep runs that filed #157 started `wrangler dev` by hand in
// a scratch folder, deleted the folder at the end, and left the
// stack running and listening with its working directory deleted.
// This check drives the rig lifecycle tool (rig.mjs) through the
// three shapes that must hold:
//
//   A. The plain stop: start a rig, stop it through rig.mjs, and
//      no recorded process survives, both ports are free and the
//      folder is gone.
//   B. The interrupted run: start a rig, delete its folder by hand
//      (the sweep's mistake), and rig.mjs reap — matched on the
//      folder's path — leaves no process of the rig standing
//      (the certs server counts, issue #86) and frees both ports.
//   C. The guard: rig.mjs stop on a folder with no state file
//      refuses and deletes nothing.
//
// Run it on the machine that hosts rigs, from a checkout:
//   node tests/rig/rig-check.mjs
// It stands up real wrangler dev stacks on its own ports (8891 and
// 8892) in a throwaway folder under the system temp dir, and it
// only ever stops processes it started itself. It refuses to begin
// if either of its ports is already taken.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const RIG = join(HERE, "rig.mjs");
const CERTS_PORT = 8891;
const WORKER_PORT = 8892;

const WORK = join(tmpdir(), "tasksparkle-rig-check-" + process.pid);
const startedGroups = []; // every pgid this check started, for the finally

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
  if (!ok) failures++;
}

function rig(args) {
  return spawnSync(process.execPath, [RIG, ...args], { encoding: "utf8" });
}

function portAnswers(port) {
  return new Promise((resolve) => {
    const sock = connect(port, "127.0.0.1");
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(false));
    sock.setTimeout(1500, () => { sock.destroy(); resolve(false); });
  });
}

async function waitFor(cond, deadlineMs, label) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log("  (timed out waiting for " + label + ")");
  return false;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Processes whose working directory is the named folder, deleted:
// the orphan shape from issue #157, read the way the issue read it.
function orphansOf(dir) {
  const found = [];
  let pids = [];
  try { pids = spawnSync("ls", ["/proc"], { encoding: "utf8" }).stdout.split("\n").filter((s) => /^\d+$/.test(s)); }
  catch { return found; }
  for (const pid of pids) {
    let cwd = "";
    try {
      cwd = spawnSync("readlink", ["/proc/" + pid + "/cwd"], { encoding: "utf8" }).stdout.trim();
    } catch { continue; }
    if (cwd === dir + " (deleted)") {
      let cmd = "";
      try { cmd = readFileSync("/proc/" + pid + "/cmdline", "utf8").replace(/\0/g, " "); } catch { /* gone */ }
      found.push({ pid: Number(pid), cmd });
    }
  }
  return found;
}

function readState(dir) {
  try { return JSON.parse(readFileSync(join(dir, ".rig-state.json"), "utf8")); }
  catch { return null; }
}

async function main() {
  if (await portAnswers(CERTS_PORT) || await portAnswers(WORKER_PORT)) {
    console.log("FAIL a check port is already taken — refusing to touch another run's stack " +
      "(certs " + CERTS_PORT + ", worker " + WORKER_PORT + ")");
    return 1;
  }
  mkdirSync(WORK, { recursive: true });

  // ---- A. The plain stop ----
  const dirA = join(WORK, "rig-a");
  let res = rig(["start", "--dir", dirA, "--source", ROOT,
    "--port", String(WORKER_PORT), "--certs-port", String(CERTS_PORT)]);
  const stateA = readState(dirA);
  if (stateA) for (const g of stateA.groups) startedGroups.push(g.pgid);
  check("A: rig.mjs start brings the rig up", res.status === 0 && !!stateA,
    res.status === 0 ? "" : (res.stderr || res.stdout || "").trim().split("\n").pop());
  if (stateA) {
    check("A: the worker port answers while the rig stands", await portAnswers(WORKER_PORT));
    const tomlA = readFileSync(join(dirA, "wrangler.toml"), "utf8");
    check("A: the generated settings name the run's own certs port, with no default address left standing (issue #54)",
      tomlA.includes("127.0.0.1:" + CERTS_PORT) && !tomlA.includes("127.0.0.1:8791"),
      tomlA.split("\n").find((l) => l.includes("ACCESS_TEAM_DOMAIN")) || "no ACCESS_TEAM_DOMAIN line");
    res = rig(["stop", "--dir", dirA]);
    check("A: rig.mjs stop reports success", res.status === 0,
      (res.stdout || "").trim().split("\n").pop() || "");
    const anyAlive = stateA.groups.some((g) => pidAlive(g.pid));
    check("A: no recorded process survives the stop", !anyAlive);
    check("A: both ports are free after the stop",
      !(await portAnswers(WORKER_PORT)) && !(await portAnswers(CERTS_PORT)));
    check("A: the rig folder is gone after the stop", !existsSync(dirA));
    for (const g of stateA.groups) {
      const i = startedGroups.indexOf(g.pgid);
      if (i >= 0) startedGroups.splice(i, 1);
    }
  }

  // ---- B. The interrupted run: folder deleted by hand, then reap ----
  const dirB = join(WORK, "rig-b");
  res = rig(["start", "--dir", dirB, "--source", ROOT,
    "--port", String(WORKER_PORT), "--certs-port", String(CERTS_PORT)]);
  const stateB = readState(dirB);
  if (stateB) for (const g of stateB.groups) startedGroups.push(g.pgid);
  check("B: the second rig starts", res.status === 0 && !!stateB);
  if (stateB) {
    rmSync(dirB, { recursive: true, force: true }); // the sweep's mistake
    const orphans = orphansOf(dirB);
    check("B: deleting the folder by hand does orphan the stack (the #157 shape)",
      orphans.length > 0, orphans.length + " processes with a deleted cwd");
    res = rig(["reap", "--match", dirB]);
    check("B: rig.mjs reap runs", res.status === 0, (res.stdout || "").trim().split("\n").pop() || "");
    const left = orphansOf(dirB);
    check("B: no orphan with the deleted folder as its cwd remains", left.length === 0,
      left.map((o) => o.pid).join(", "));
    check("B: the worker port is free after the reap", !(await portAnswers(WORKER_PORT)));
    check("B: the certs port is free after the reap", !(await portAnswers(CERTS_PORT)));
    for (const g of stateB.groups) {
      const i = startedGroups.indexOf(g.pgid);
      if (i >= 0) startedGroups.splice(i, 1);
    }
  }

  // ---- C. The guard: stop without a state file refuses ----
  const dirC = join(WORK, "not-a-rig");
  mkdirSync(dirC, { recursive: true });
  writeFileSync(join(dirC, "sentinel.txt"), "not a rig\n");
  res = rig(["stop", "--dir", dirC]);
  check("C: stop refuses a folder with no state file", res.status !== 0);
  check("C: the refused stop deletes nothing", existsSync(join(dirC, "sentinel.txt")));

  console.log(failures === 0 ? "\nAll rig checks passed." : "\n" + failures + " rig check(s) FAILED.");
  return failures === 0 ? 0 : 1;
}

// No process.exit inside the try: exit() would skip the finally,
// and a check for leaked rigs must never leak its own folder.
let exitCode = 1;
try {
  exitCode = await main();
} finally {
  // Only ever the groups this check started and recorded.
  for (const pgid of startedGroups) {
    try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
  }
  rmSync(WORK, { recursive: true, force: true });
}
process.exit(exitCode);
