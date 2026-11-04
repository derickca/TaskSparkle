// The Worker rig's lifecycle (issue #157): the one tool that
// starts a rig, and the only tool that removes one.
//
// Before this script, the run book in tests/README had a person
// start the certs server and `wrangler dev` by hand and "leave it
// running". Nothing recorded what had been started. A run that
// ended by deleting the rig folder — the sweep runs that filed
// #157 did exactly that — left the whole dev stack alive and
// listening, its working directory deleted, with nothing able to
// reap it short of hunting processes by hand.
//
// rig.mjs starts both servers as process-group leaders and writes
// the groups it started into the rig folder's state file before it
// does anything else. Teardown reads that record:
//
//   start --dir <folder> --source <checkout>
//       Copies the checkout into the folder, makes the rig's keys,
//       applies the schema to both local databases, starts the
//       certs server and the Worker, and waits until both answer.
//       If any step after the start fails, it stops what it
//       started before it exits — a failed start leaves no stack.
//   stop --dir <folder>
//       Stops the recorded groups, confirms every one of them is
//       gone, and only then removes the folder. The folder is
//       never removed while its server still runs. With no state
//       file it refuses and removes nothing: without the record it
//       will not guess which processes are the rig's.
//   reap --match <part of the folder's path>
//       For the interrupted run whose folder is already gone and
//       whose state file went with it: stops every wrangler or
//       workerd process whose working directory reads "(deleted)"
//       and matches. The match is required, and nothing whose
//       working directory still exists is ever touched.
//   status --dir <folder>
//       Prints the record and which of its processes still stand.
//
// Linux only: it reads /proc, the way the rigs run (a desktop's
// WSL Ubuntu). Ports default to the run book's 8791 (certs) and
// 8792 (Worker); --port and --certs-port move them.

import { spawn, spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  readlinkSync, rmSync, writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { connect } from "node:net";
import { join, resolve } from "node:path";

const WRANGLER = "wrangler@4.153.0";
const STATE_NAME = ".rig-state.json";

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function die(message, code) {
  console.error("rig: " + message);
  process.exit(code || 1);
}

function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}

async function waitFor(cond, deadlineMs) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Stop every recorded group: SIGTERM, wait for the groups to be
// gone, then SIGKILL and wait again. True only when nothing in
// any group stands at the end.
async function killGroups(pgids) {
  for (const pgid of pgids) {
    try { process.kill(-pgid, "SIGTERM"); } catch { /* already gone */ }
  }
  if (await waitFor(() => !pgids.some(groupAlive), 15000)) return true;
  for (const pgid of pgids) {
    try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
  }
  return waitFor(() => !pgids.some(groupAlive), 10000);
}

function portAnswers(port) {
  return new Promise((resolvePort) => {
    const sock = connect(port, "127.0.0.1");
    sock.once("connect", () => { sock.destroy(); resolvePort(true); });
    sock.once("error", () => resolvePort(false));
    sock.setTimeout(1500, () => { sock.destroy(); resolvePort(false); });
  });
}

function httpAnswers(url, insecure) {
  return new Promise((resolveReq) => {
    const get = insecure ? httpsGet : httpGet;
    const req = get(url, { rejectUnauthorized: false, timeout: 2000 }, (res) => {
      res.resume();
      resolveReq(true);
    });
    req.once("error", () => resolveReq(false));
    req.once("timeout", () => { req.destroy(); resolveReq(false); });
  });
}

function readState(dir) {
  try { return JSON.parse(readFileSync(join(dir, STATE_NAME), "utf8")); }
  catch { return null; }
}

function run(command, args, cwd) {
  const res = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(command + " " + args.join(" ") + " failed:\n" +
      (res.stdout || "") + (res.stderr || ""));
  }
}

async function start() {
  const dirArg = arg("dir");
  const sourceArg = arg("source");
  if (!dirArg || !sourceArg) {
    die("start needs --dir <folder> and --source <checkout>", 2);
  }
  const dir = resolve(dirArg);
  const source = resolve(sourceArg);
  const port = Number(arg("port", "8792"));
  const certsPort = Number(arg("certs-port", "8791"));
  if (dir === source || dir.startsWith(source + "/")) {
    die("the rig folder must stand outside the source checkout", 2);
  }
  if (!existsSync(join(source, "tests", "rig", "wrangler.toml.example"))) {
    die(source + " does not look like a TaskSparkle checkout", 2);
  }
  const standing = readState(dir);
  if (standing && standing.groups.some((g) => groupAlive(g.pgid))) {
    die("a rig already stands in " + dir + " — stop it first (rig.mjs stop --dir " + dir + ")", 2);
  }
  if (existsSync(dir) && readdirSync(dir).length > 0 && !standing) {
    die(dir + " exists, is not empty and holds no rig state — refusing to overwrite it", 2);
  }
  if (await portAnswers(port) || await portAnswers(certsPort)) {
    die("a rig port is already taken (worker " + port + ", certs " + certsPort +
      ") — refusing to start over another run's stack", 2);
  }

  const groups = [];
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    cpSync(source, dir, {
      recursive: true,
      filter: (src) => {
        const base = src.split("/").pop();
        return ![".git", "node_modules", ".wrangler", "wrangler.toml", STATE_NAME]
          .includes(base);
      },
    });
    const toml = readFileSync(join(dir, "tests", "rig", "wrangler.toml.example"), "utf8")
      .replace("127.0.0.1:8791", "127.0.0.1:" + certsPort);
    writeFileSync(join(dir, "wrangler.toml"), toml);

    run(process.execPath, [join(dir, "tests", "rig", "mkkeys.mjs")], dir);
    for (const db of ["tasksparkle-rig", "tasksparkle-rig-auth"]) {
      run("npx", [WRANGLER, "d1", "execute", db, "--local",
        "--file=worker/schema.sql"], dir);
    }

    const logDir = join(dir, ".rig-logs");
    mkdirSync(logDir, { recursive: true });
    const spawnLogged = (name, command, args, extraEnv) => {
      const fd = openSync(join(logDir, name + ".log"), "a");
      const child = spawn(command, args, {
        cwd: dir, detached: true, stdio: ["ignore", fd, fd],
        env: { ...process.env, ...extraEnv },
      });
      child.unref();
      return child;
    };
    const certs = spawnLogged("certs", process.execPath,
      [join(dir, "tests", "rig", "certs-server.mjs")],
      { RIG_CERTS_PORT: String(certsPort) });
    groups.push({ name: "certs", pid: certs.pid, pgid: certs.pid, port: certsPort });
    const worker = spawnLogged("worker", "npx",
      [WRANGLER, "dev", "--local-protocol", "https", "--ip", "127.0.0.1",
       "--port", String(port)], {});
    groups.push({ name: "worker", pid: worker.pid, pgid: worker.pid, port });

    // The record goes down before the waits: from here on, stop
    // and reap can always find what this start made.
    writeFileSync(join(dir, STATE_NAME), JSON.stringify(
      { version: 1, dir, startedAt: new Date().toISOString(), groups }, null, 2));

    const certsUp = await waitFor(
      () => httpAnswers("http://127.0.0.1:" + certsPort + "/cdn-cgi/access/certs", false),
      30000);
    if (!certsUp) throw new Error("the certs server did not answer on " + certsPort +
      " — see " + join(logDir, "certs.log"));
    const workerUp = await waitFor(
      () => httpAnswers("https://127.0.0.1:" + port + "/", true), 90000);
    if (!workerUp) throw new Error("the Worker did not answer on " + port +
      " — see " + join(logDir, "worker.log"));
  } catch (err) {
    // A failed start leaves no stack: stop what was started, drop
    // the record, and leave the folder and its logs for diagnosis.
    if (groups.length > 0) await killGroups(groups.map((g) => g.pgid));
    rmSync(join(dir, STATE_NAME), { force: true });
    die(err.message + "\nrig: the half-started stack was stopped; the folder stands at " +
      dir + " for its logs.");
  }
  console.log("rig standing in " + dir + ": certs on " + certsPort +
    ", Worker on " + port + ", groups " + groups.map((g) => g.pgid).join(" and ") + ".");
  console.log("stop it with: node tests/rig/rig.mjs stop --dir " + dir);
}

async function stop() {
  const dirArg = arg("dir");
  if (!dirArg) die("stop needs --dir <folder>", 2);
  const dir = resolve(dirArg);
  const state = readState(dir);
  if (!state) {
    die(dir + " holds no rig state (" + STATE_NAME + "), so rig.mjs will not guess " +
      "which processes are the rig's, and the folder is left untouched. If the folder " +
      "is already gone and its stack still stands, run: node tests/rig/rig.mjs reap --match " +
      dir, 2);
  }
  const pgids = state.groups.map((g) => g.pgid);
  const gone = await killGroups(pgids);
  if (!gone) {
    const survivors = state.groups.filter((g) => groupAlive(g.pgid))
      .map((g) => g.name + " (group " + g.pgid + ")");
    die("still running after SIGKILL: " + survivors.join(", ") +
      ". The folder was NOT removed — a rig folder is never removed while its server runs.");
  }
  for (const g of state.groups) {
    if (await portAnswers(g.port)) {
      console.log("note: port " + g.port + " still answers, but the rig's processes are " +
        "gone — something else holds it now, and it is not rig.mjs's to stop.");
    }
  }
  rmSync(dir, { recursive: true, force: true });
  console.log("stopped groups " + pgids.join(" and ") + " and removed " + dir + ".");
}

async function reap() {
  const match = arg("match");
  if (!match || match.length < 4) {
    die("reap needs --match <part of the deleted folder's path>, at least 4 characters — " +
      "it stops processes by that match and will not run unscoped", 2);
  }
  const found = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let cwd = "";
    try { cwd = readlinkSync("/proc/" + entry + "/cwd"); } catch { continue; }
    if (!cwd.endsWith(" (deleted)") || !cwd.includes(match)) continue;
    let cmd = "";
    try { cmd = readFileSync("/proc/" + entry + "/cmdline", "utf8").replace(/\0/g, " "); }
    catch { continue; }
    if (!/wrangler|workerd/.test(cmd)) continue;
    let pgid = Number(entry);
    try {
      const stat = readFileSync("/proc/" + entry + "/stat", "utf8");
      pgid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
    } catch { /* the pid itself is the fallback */ }
    found.push({ pid: Number(entry), pgid, cwd, cmd });
  }
  if (found.length === 0) {
    console.log("no orphaned wrangler or workerd process stands on a deleted folder matching " +
      match + ".");
    return;
  }
  for (const f of found) {
    console.log("orphan: pid " + f.pid + ", group " + f.pgid + ", cwd " + f.cwd);
  }
  const pgids = [...new Set(found.map((f) => f.pgid))];
  const gone = await killGroups(pgids);
  if (!gone) die("some orphaned processes survived SIGKILL — see the list above.");
  console.log("reaped " + found.length + " orphaned process(es) in group(s) " +
    pgids.join(", ") + ".");
}

function status() {
  const dirArg = arg("dir");
  if (!dirArg) die("status needs --dir <folder>", 2);
  const dir = resolve(dirArg);
  const state = readState(dir);
  if (!state) { console.log("no rig state in " + dir + "."); return; }
  console.log("rig in " + dir + ", started " + state.startedAt);
  for (const g of state.groups) {
    console.log("  " + g.name + ": pid " + g.pid + ", group " + g.pgid +
      ", port " + g.port + " — " + (groupAlive(g.pgid) ? "running" : "gone"));
  }
}

const command = process.argv[2];
if (command === "start") await start();
else if (command === "stop") await stop();
else if (command === "reap") await reap();
else if (command === "status") status();
else {
  console.error("usage: node tests/rig/rig.mjs start|stop|reap|status [--dir <folder>] " +
    "[--source <checkout>] [--port 8792] [--certs-port 8791] [--match <path part>]");
  process.exit(2);
}
