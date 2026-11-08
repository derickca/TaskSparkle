// TaskSparkle, self-hosted: the same app and the same API as the
// Cloudflare deployment, served from one Node process on your own
// machine. The API itself is the shared core (worker/core.js);
// this file is its local wrapper, the way worker/worker.js is the
// Cloudflare one. What stands here is only what is local:
//
// - the static app, served from public/ with the same no-cache
//   rules its _headers file declares on Cloudflare;
// - the sign-in pages, served by the shared sign-in code
//   (worker/auth.js) with this copy's shape: a page listing the
//   names of the accounts that stand, where a person picks
//   their name and types their own password, or taps a
//   passkey. The first account is made on that page itself and
//   becomes the administrator; every later password is set
//   through a single-use invite link. Sessions are rows in the
//   shared tables now, not a signed cookie (issue #109);
// - the adapters the core takes: the database (a SQLite file,
//   through d1-adapter.mjs) and push (the socket hub in
//   push-hub.mjs).
//
// Standard library only, on purpose: Node 22.5 or newer carries
// everything this needs, including the SQLite store
// (node:sqlite, which arrived in 22.5), so a self-host install
// is Node and this folder — nothing to fetch.
//
// The local sign-in suits a trusted home network. It is not a
// door to put on the open internet; docs/self-hosting.md says so
// in as many words.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiHandler, feedbackTarget } from "../worker/core.js";
import {
  createAuthHandlers, getAccount, countAccounts, mintInvite,
  eraseAccountCredentials, ensureAdminStanding,
  nameKey, nameProblem, newAccountId, randomBytes, b64uEncode,
} from "../worker/auth.js";
import { openDatabase } from "./d1-adapter.mjs";
import { createPushHub } from "./push-hub.mjs";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SERVER_DIR);
const PUBLIC_DIR = join(ROOT, "public");

// --- The config -------------------------------------------------------------
// One JSON file names everything local: the port, the data
// directory, the agent door's name and, if set, the one
// network address to listen on and the address invite links
// are built from. It names no people:
// the install is nameless (issue #107), and accounts live in
// the data file, made on the website or by invite. No password
// lives in it: people's passwords rest in the data file, set
// through invite links (see below). --config or TASKSparkle_CONFIG
// may point elsewhere; the default is server/config.json, which
// is gitignored — copy server/config.example.json to make one.
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}
const configPath = resolve(
  argValue("--config") || process.env.TASKSparkle_CONFIG || join(SERVER_DIR, "config.json")
);
if (!existsSync(configPath)) {
  console.error(
    "No config file at " + configPath + ".\n" +
    "Copy server/config.example.json to server/config.json and fill it in first."
  );
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, "utf8"));

// --- People's accounts, passwords and invites ---------------------------------
// There is no shared household password (issue #89): a password
// shared by the whole house signs anyone in as anyone, so each
// person's boards were only as private as the household's
// courtesy. Instead, each person has their own account under
// their own name, and the config names nobody at all (issue
// #107): an account is a row in the data file, made one of
// three ways — the first account on the website's own setup
// page, which flags its maker as the administrator; a later
// account by spending an invite that carries a name; and a
// password reset by spending an invite that carries an
// existing account's name. Nobody else ever knows a person's
// password — not even the administrator who minted the invite.
//
// Accounts rest in the shared sign-in tables (worker/auth.js,
// worker/schema.sql) — the same tables the hosted copy uses —
// since issue #109. This wrapper's own two tables from before
// (local_passwords, local_invites) fold into them once, on
// whichever command opens the file first (see
// migrateSignInTables below), and are then dropped. A password
// set before the move rests as a salted scrypt hash,
// "scrypt$<salt>$<hash>"; the shared code verifies that legacy
// form once (it is one of its stored-form dispatches) and
// rehashes it in the current PHC scrypt form at that same
// proof, so the old form ages out on its own and nothing ever
// rests in it again. An invite rests only as the SHA-256 hash
// of its code; the code itself is shown once, at minting.
// Invites live 7 days and die the moment they are used. A
// forgotten password is a fresh invite — there is no other
// reset machinery, on purpose.

const PORT = Number(config.port) || 8080;
const dataDir = resolve(dirname(configPath), String(config.dataDir || "data"));

// A data file from the email-keyed setup (before issue #107)
// carries the two local tables with an "email" column instead
// of the key and name columns. Those rows are carried over
// once, on whichever command opens the file first: each
// address becomes its account's sign-in name, standing as it
// is, so nobody on an older copy loses their boards or their
// password to the change. The fold into the shared sign-in
// tables (foldLocalTablesIn, above) then runs on the same
// open: afterwards the shared shape is what stands, and this
// reads as a no-op.
async function migrateSignInTables(db) {
  const pwCols = await db.prepare("PRAGMA table_info(local_passwords)").all();
  if (pwCols.results.some((r) => r.name === "email") &&
      !pwCols.results.some((r) => r.name === "key")) {
    await db.batch([
      db.prepare("ALTER TABLE local_passwords RENAME TO local_passwords_email_era"),
      db.prepare(
        "CREATE TABLE local_passwords (" +
        "key TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL, " +
        "admin INTEGER NOT NULL DEFAULT 0)"),
      db.prepare(
        "INSERT INTO local_passwords (key, name, hash, admin) " +
        "SELECT lower(email), email, hash, 0 FROM local_passwords_email_era"),
      db.prepare("DROP TABLE local_passwords_email_era"),
    ]);
  }
  const invCols = await db.prepare("PRAGMA table_info(local_invites)").all();
  if (invCols.results.some((r) => r.name === "email") &&
      !invCols.results.some((r) => r.name === "key")) {
    await db.batch([
      db.prepare("ALTER TABLE local_invites RENAME TO local_invites_email_era"),
      db.prepare(
        "CREATE TABLE local_invites (" +
        "code_hash TEXT PRIMARY KEY, key TEXT NOT NULL, name TEXT NOT NULL, " +
        "created INTEGER NOT NULL, expires INTEGER NOT NULL, used_at INTEGER)"),
      db.prepare(
        "INSERT INTO local_invites (code_hash, key, name, created, expires, used_at) " +
        "SELECT code_hash, lower(email), email, created, expires, used_at " +
        "FROM local_invites_email_era"),
      db.prepare("DROP TABLE local_invites_email_era"),
    ]);
  }
  await foldLocalTablesIn(db);
}

// Opens the one data file the way every command here does: the
// shared schema applied, and any older sign-in shape carried
// over (see migrateSignInTables).
function openLocalDb() {
  mkdirSync(dataDir, { recursive: true });
  return openDatabase(
    join(dataDir, "tasksparkle.sqlite"),
    readFileSync(join(ROOT, "worker", "schema.sql"), "utf8")
  );
}

// Carries this wrapper's own sign-in tables (local_passwords,
// local_invites) into the shared ones, once, and drops them:
// each password row becomes an account — its stored hash
// carried as it stands (a legacy scrypt row verifies once
// through the shared code's dispatch and rehashes at that
// proof), its boards
// linked through the owners row that stands under its key —
// and each invite row becomes a shared invite with its code
// hash, name and dates untouched, so a link already sent still
// spends. A key an account already stands under is skipped:
// the shared row is the one that stands.
async function foldLocalTablesIn(db) {
  const tables = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN " +
    "('local_passwords', 'local_invites')"
  ).all();
  const standing = new Set(tables.results.map((r) => r.name));
  if (standing.has("local_passwords")) {
    const rows = (await db.prepare("SELECT * FROM local_passwords").all()).results;
    for (const row of rows) {
      if (await getAccount(db, row.key)) continue;
      const owner = await db.prepare("SELECT id FROM owners WHERE email = ?")
        .bind(row.key).first();
      await db.prepare(
        "INSERT INTO accounts (id, key, name, password_hash, admin, owner_id, user_handle, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        newAccountId(), row.key, row.name, row.hash, row.admin ? 1 : 0,
        owner ? owner.id : null, b64uEncode(randomBytes(16)),
        Number(row.created_at) || Date.now()
      ).run();
    }
  }
  if (standing.has("local_invites")) {
    const rows = (await db.prepare("SELECT * FROM local_invites").all()).results;
    for (const row of rows) {
      await db.prepare(
        "INSERT OR IGNORE INTO invites " +
        "(code_hash, key, name, created, expires, used_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(row.code_hash, row.key, row.name, row.created, row.expires, row.used_at).run();
    }
  }
  if (standing.size) {
    await db.prepare("DROP TABLE IF EXISTS local_passwords").run();
    await db.prepare("DROP TABLE IF EXISTS local_invites").run();
  }
}

// The address invite links are built from: the config's
// address when it names one, the machine's own localhost
// otherwise.
function inviteBase() {
  return String(config.address || "").trim().replace(/\/+$/, "") ||
    "http://localhost:" + PORT;
}

// Erasing one person from a data file: the owners row (the
// schema's cascades take everything under it — boards,
// columns, labels, projects, cards, steps, links, comments,
// card labels and every key the person holds) and the
// account's own credentials in the shared tables — its
// password, passkeys, sessions and invites. The
// --delete-person command below is its caller now; inside the
// running app the same whole is the shared core's removal
// route, so both doors erase alike.
async function erasePersonRows(db, key) {
  const account = await getAccount(db, key);
  let ownerRow = null;
  if (account && account.owner_id) {
    ownerRow = await db.prepare("SELECT id FROM owners WHERE id = ?")
      .bind(account.owner_id).first();
  }
  if (!ownerRow) {
    ownerRow = await db.prepare("SELECT id FROM owners WHERE email = ?")
      .bind(key).first();
  }
  const boardsBefore = ownerRow
    ? Number((await db.prepare("SELECT COUNT(*) AS n FROM boards WHERE owner_id = ?")
        .bind(ownerRow.id).first()).n || 0)
    : 0;
  if (ownerRow) {
    await db.prepare("DELETE FROM owners WHERE id = ?").bind(ownerRow.id).run();
  }
  if (account) await eraseAccountCredentials(db, key);
  return { account, ownerRow, boardsBefore };
}

// --- Minting an invite: the recovery door ---------------------------------------
//   node server/server.mjs --invite "Their Name" [--config <file>]
//
// One of this server's two maintenance commands (deleting a
// person is the other, below). Day to day, invites are the
// administrator's job inside the app; this command is the
// recovery door, for when no administrator can sign in. It
// works whether or not the server is running (the data file
// is the meeting point) and whether or not the config is
// current — minting is one of the remedies the old-config
// refusals below name, so it must not refuse the configs that
// need it. The invite carries a name and nothing else; a name
// that already stands as an account makes it a reset.
if (process.argv.includes("--invite")) {
  const name = String(argValue("--invite") || "").trim();
  const problem = nameProblem(name);
  if (problem) {
    console.error(
      problem + "\nMint an invite like this: node server/server.mjs --invite \"Their Name\""
    );
    process.exit(1);
  }
  const mintDb = openLocalDb();
  await migrateSignInTables(mintDb);
  const minted = await mintInvite(mintDb, name);
  const stands = await getAccount(mintDb, minted.key);
  mintDb.close();
  console.log(
    "Invite for " + minted.name +
    (stands ? " — spending it sets a new password for the account under that name" : "") +
    ".\n" +
    "Send this link to " + minted.name + " directly — in a private " +
    "message, not a group chat. It works for 7 days (until " +
    new Date(minted.expires).toDateString() + ") and stops working the moment it is used.\n\n" +
    "  " + inviteBase() + "/invite/" + minted.code + "\n\n" +
    "If the link arrives broken, the code on its own works too: it goes in the\n" +
    "\"Have an invite?\" box on the sign-in page.\n\n" +
    "  " + minted.code
  );
  if ("householdPassword" in config || "householdPasswordHash" in config || "people" in config) {
    console.log(
      "\nNote: this config still carries fields the server no longer reads " +
      "(\"householdPassword\", \"householdPasswordHash\" or \"people\").\n" +
      "The server will not start until they are removed from it — the invite above works regardless."
    );
  }
  process.exit(0);
}

// --- Deleting a person: the recovery door ---------------------------------------
//   node server/server.mjs --delete-person "Their Name" [--config <file>]
//
// The recovery erasure path (issues #57 and #107), for when no
// administrator can sign in to remove the person from inside
// the app. It erases the account under the name from the data
// file — the same whole the app's own removal route erases
// (see erasePersonRows above). It works whether or not the
// server is running. When there is nothing to erase it says so
// and exits non-zero, so a mistyped name can never pass as a
// success.
if (process.argv.includes("--delete-person")) {
  const name = String(argValue("--delete-person") || "").trim();
  if (!name) {
    console.error(
      "Name the person: node server/server.mjs --delete-person \"Their Name\""
    );
    process.exit(1);
  }
  const key = nameKey(name);
  const eraseDb = openLocalDb();
  await migrateSignInTables(eraseDb);
  const { account, ownerRow, boardsBefore } = await erasePersonRows(eraseDb, key);
  eraseDb.close();
  if (!ownerRow && !account) {
    console.error(
      "Nothing to delete: no account, password or invite stands in the data file for " +
      name + ".\nCheck the name — a deletion that finds nothing is not a success."
    );
    process.exit(1);
  }
  console.log(
    "Erased " + (account ? account.name : name) + ": their account and " + boardsBefore +
    (boardsBefore === 1 ? " board" : " boards") +
    " with everything on them, their agent keys, and their password, passkeys and invites are gone." +
    (ownerRow ? "" : " (No boards account stood in the file; the account rows were the whole of it.)")
  );
  process.exit(0);
}

// A config from the shared-password setup names its retirement
// plainly rather than failing strangely later: those fields are
// simply not read any more, and a start that silently ignored
// them would lock the whole household out without a word.
if ("householdPassword" in config || "householdPasswordHash" in config) {
  console.error(
    "This config still carries the household password fields " +
    "(\"householdPassword\" / \"householdPasswordHash\") from the shared-password setup.\n" +
    "TaskSparkle no longer signs everyone in with one household password: each person\n" +
    "has their own name and their own password. To move over:\n" +
    "  1. Remove \"householdPassword\" and \"householdPasswordHash\" from the config.\n" +
    "  2. Start the server again.\n" +
    "  3. The first person to open the site makes the first account on the setup\n" +
    "     page and becomes the administrator; everyone after arrives by an invite\n" +
    "     carrying their name — the administrator mints invites inside the app,\n" +
    "     under Settings, then Admin. Each person sets their own password, and\n" +
    "     nobody else ever knows it. If no administrator can sign in, an invite\n" +
    "     can still be minted from the command line:\n" +
    "       node server/server.mjs --invite \"Their Name\""
  );
  process.exit(1);
}

// A config that still carries a "people" list refuses to
// start (issue #107): the install is nameless now — accounts
// live in the data file, made on the website and by invite —
// and starting up silently ignoring the list would leave the
// operator believing it still decides who can sign in. The
// refusal names the change and the way over; the two commands
// above still run on this config, because minting is one of
// the remedies this flow names.
if ("people" in config) {
  console.error(
    "This config still carries a \"people\" list, from the setup where the config\n" +
    "named who could sign in. TaskSparkle no longer reads it: the install is\n" +
    "nameless, and accounts live in the data file — the first account is made on\n" +
    "the website (its maker becomes the administrator), and everyone after\n" +
    "arrives by an invite carrying their name. To move over:\n" +
    "  1. Remove \"people\" from the config.\n" +
    "  2. Start the server again.\n" +
    "Accounts already in the data file stand as they were. A person whose account\n" +
    "stood under an address signs in under that address as their name, and the\n" +
    "earliest account standing becomes the administrator."
  );
  process.exit(1);
}

// The config's sessionSecret field is no longer read: sessions
// are rows in the shared tables now (issue #109), not a cookie
// this wrapper signs. A config that still carries the field is
// fine — it is simply ignored.
const agentHost = String(config.agentHost || "").trim() || "localhost:" + PORT;
// The one address to listen on, when the config names one:
// "127.0.0.1" keeps this copy on the machine itself, for people
// who reach it through their own proxy or tunnel. Unset, the
// server listens on every address, as it always has.
const bindHost = String(config.host || "").trim();

// --- The database -------------------------------------------------------------
// One file holds the app's tables and the sign-in tables, all
// in the shared schema (idempotent creates, so every start is
// a no-op after the first). The sign-in fold-in then carries
// any rows this wrapper's own tables still hold into the
// shared ones, and the administrator standing is settled: if
// accounts stand and none is flagged, the earliest account
// standing takes the flag — the recovery shape, for an install
// grown through command-line invites alone.
mkdirSync(dataDir, { recursive: true });
const schemaSql = readFileSync(join(ROOT, "worker", "schema.sql"), "utf8");
const db = openDatabase(join(dataDir, "tasksparkle.sqlite"), schemaSql);
await migrateSignInTables(db);
await ensureAdminStanding(db);

// --- The core, with this deployment's adapters ---------------------------------
const hub = createPushHub();
// Sockets that arrived as HTTP upgrades, waiting for the core to
// settle who they belong to: socket id -> { socket, head }.
const pendingSockets = new Map();

// The core keys owners by an identity string. On this door
// the string is an account's key, and the allowlist the core is
// handed names nobody: once any account stands, a key speaks
// only while its owner's account stands and is linked (the
// core reads the shared tables itself), and before any account
// stands no key is answered at all — a fresh copy has no keys
// until its first person makes one in the app.
// The scheme the directions name for the agents' door. It
// follows the address the config names: an https address — the
// address a front door such as Tailscale Serve reports is one —
// names https, so the directions point agents at the door as it
// actually answers; a plain home address names http, as before.
const agentScheme = /^https:\/\//i.test(String(config.address || "")) ? "https" : "http";

const coreEnv = {
  OWNER_EMAILS: "",
  AGENT_HOST: agentHost,
  AGENT_SCHEME: agentScheme,
  // The deployment's feedback target (issue #22), from the
  // config's feedbackUrl: the address this copy's Feedback
  // page posts its notes to. Absent — the config.example.json
  // default — the copy shows no Feedback page and no Feedback
  // link, and the core's submit route answers not found.
  FEEDBACK_URL: String(config.feedbackUrl || ""),
};

// The sign-in config this copy hands both the page handlers
// and the core: a home copy's source is the socket's own
// address (the dispatch below stamps it into the x-ts-source
// header, because nothing between a browser on the home
// network and this process can be trusted to carry one), its
// lockout ceiling is one minute — the household brake's whole
// force, kept where it belongs, on the door itself — and its
// legacy rows verify through Node's scrypt.
const authConfig = {
  sourceOf: (request) => request.headers.get("x-ts-source") || "unknown",
  sourceCapMs: 60 * 1000,
  publicBase: inviteBase(),
};

// The sign-in pages, from the shared code, in this copy's
// shape: the pick list of names stands (a home copy is reached
// by the household), and no setup code is asked — the house
// itself is the gate the design accepts for a first run here.
const authPages = createAuthHandlers({
  authDb: db,
  cfg: {
    hosted: false,
    listNames: true,
    requireSetupCode: false,
    setupCodeHash: null,
    sourceOf: authConfig.sourceOf,
    sourceCapMs: authConfig.sourceCapMs,
    cookieSecure: () => false,
    },
});

const handler = createApiHandler({
  db,
  authDb: db,
  env: coreEnv,
  auth: authConfig,
  sessionCookieName: null, // a stale local session simply reads as signed out
  onOwnerDeleted: async (owner) => {
    // An erasure (issue #57): the core has deleted the owners
    // row and its whole cascade and the account's credentials
    // with it; what is left here is only this wrapper's own
    // state — the sockets the person's open boards hold are
    // let go.
    hub.dropOwner(owner.id);
  },
  pushNotify: (ownerId, version) => hub.broadcast(ownerId, version),
  acceptPush: async (request, owner) => {
    const id = request.headers.get("x-ts-socket-id");
    const pending = id ? pendingSockets.get(id) : null;
    if (!pending) return null;
    pendingSockets.delete(id);
    if (!hub.handshake(pending.socket, pending.head, String(owner.id))) return null;
    // The socket is the hub's now; the response below is never
    // written anywhere — the upgrade path ignores it.
    return new Response(null, { status: 200 });
  },
});

// --- Turning Node requests into the core's web requests -------------------------
// The scheme a request is spoken to this copy on. The server
// itself speaks plain HTTP. A front door on this same machine —
// Tailscale Serve is the known one — terminates HTTPS in front
// of it and says so in X-Forwarded-Proto. That stamp is believed
// only from the machine itself: a process on this machine is
// the one neighbour whose word about what it terminated the
// network cannot coach, and all the stamp moves is the address
// the sign-in door expects a passkey ceremony to name — the
// browser's own ceremony answer must still match it exactly, so
// a stamped https gains a caller nothing its browser cannot
// honestly say (issue #115).
function requestScheme(req) {
  const from = String(req.socket.remoteAddress || "");
  const thisMachine = from === "127.0.0.1" || from === "::1" || from === "::ffff:127.0.0.1";
  const stamped = String(req.headers["x-forwarded-proto"] || "").trim().toLowerCase();
  return thisMachine && stamped === "https" ? "https" : "http";
}

function toWebRequest(req, body, extraHeaders) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  Object.assign(headers, extraHeaders || {});
  const init = { method: req.method, headers };
  if (body && body.length) init.body = body;
  return new Request(requestScheme(req) + "://" + (req.headers.host || "localhost") + req.url, init);
}

// Bodies are read with a cap, and the cap is enforced while
// reading, before the core (and any sign-in check) sees the
// request: past the limit the read refuses, the handler answers
// 413 and the connection closes, so a flood costs the sender
// its connection instead of costing this machine its memory.
// 1 MB is far past any real call — the core itself caps a
// card's notes at ten thousand characters.
const BODY_LIMIT = 1024 * 1024;

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (c) => {
      if (settled) return;
      size += c.length;
      if (size > BODY_LIMIT) {
        settled = true;
        const err = new Error("Request body past the size limit.");
        err.code = "BODY_TOO_LARGE";
        rejectBody(err);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!settled) { settled = true; resolveBody(Buffer.concat(chunks)); }
    });
    req.on("error", (e) => {
      if (!settled) { settled = true; rejectBody(e); }
    });
  });
}

function redirect(res, location, extraHeaders) {
  res.writeHead(302, { Location: location, ...(extraHeaders || {}) });
  res.end();
}

async function sendWebResponse(res, webResponse) {
  const headers = {};
  webResponse.headers.forEach((value, name) => { headers[name] = value; });
  const setCookies = typeof webResponse.headers.getSetCookie === "function"
    ? webResponse.headers.getSetCookie() : [];
  if (setCookies.length) headers["set-cookie"] = setCookies;
  const body = Buffer.from(await webResponse.arrayBuffer());
  res.writeHead(webResponse.status, headers);
  res.end(body);
}

// --- The static app -------------------------------------------------------------
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};
// The files public/_headers declares no-cache for on Cloudflare,
// plus the icons it names: the app must never be served stale.
const NO_CACHE = new Set([
  "/", "/index.html", "/boot.js", "/app.js", "/styles.css", "/manifest.webmanifest", "/sw.js",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png", "/icons/icon-180.png",
  "/icons/icon-64.png", "/icons/icon.svg", "/fonts/comfortaa-bold.woff2",
  // The public pages (issue #14) and the feedback page's
  // script revalidate the same way, so a change to their
  // words is what every open gets. The Help topics stand
  // under /help/ and are covered by the prefix check where
  // this set is read.
  "/feedback.js", "/help", "/help.html",
  "/feedback", "/feedback.html", "/site.js",
]);

// The app's security headers (issue #70), the same set
// public/_headers declares on Cloudflare — the two lists are
// kept alike by hand. The policy names the app's own origin
// and nothing else: its own script, styles and icons, its own
// API and socket, and no framing by anyone. The Feedback
// page's form posts to the app's own API, which passes the
// note to the deployment's configured target from the server
// side (issue #22), so no outside origin stands here either.
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
    "connect-src 'self'; manifest-src 'self'; worker-src 'self'; " +
    "base-uri 'self'; form-action 'self'; " +
    "frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
};
// The sign-in pages carry their own plainer policy, set by
// the shared handlers that serve them (worker/auth.js) — the
// set above is the app's alone.

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  let file = resolve(PUBLIC_DIR, "." + rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(404); res.end("Not found."); return;
  }
  let info;
  try { info = statSync(file); } catch (e) { info = null; }
  if ((!info || !info.isFile()) && !extname(rel)) {
    // A page's pretty path: /help stands for /help.html, the
    // way the Cloudflare copy answers — its _headers rules name
    // both forms for the same reason. The same guard applies
    // to the candidate as to the path itself.
    const alt = resolve(PUBLIC_DIR, "." + rel + ".html");
    if (alt.startsWith(PUBLIC_DIR + sep)) {
      try {
        const altInfo = statSync(alt);
        if (altInfo.isFile()) { file = alt; info = altInfo; }
      } catch (e) { /* no page by that name */ }
    }
  }
  if (!info || !info.isFile()) { res.writeHead(404); res.end("Not found."); return; }
  const headers = {
    "Content-Type": CONTENT_TYPES[extname(file).toLowerCase()] || "application/octet-stream",
    ...SECURITY_HEADERS,
  };
  if (NO_CACHE.has(rel) || rel.startsWith("/help/")) headers["Cache-Control"] = "no-cache";
  res.writeHead(200, headers);
  res.end(readFileSync(file));
}

// --- The server --------------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    const pathname = url.pathname;

    // The sign-in pages and the door's own posts, served by the
    // shared handlers (worker/auth.js): the login page and its
    // passkey calls, the setup page, the invite pages, the
    // pasted-code entry and the sign-out. The request is
    // stamped with the socket's own address as its source —
    // the throttle keys on it, and on a home network the
    // socket is the one witness that cannot be coached. The
    // app's own Log out link names the Cloudflare address in
    // the shared markup; locally it lands on the same handler.
    if (pathname === "/login" || pathname.startsWith("/login/") ||
        pathname === "/setup" || pathname.startsWith("/setup/") ||
        pathname === "/invite-code" ||
        pathname === "/logout" || pathname === "/cdn-cgi/access/logout" ||
        pathname.startsWith("/invite/")) {
      const body = (req.method === "POST" || req.method === "PUT" ||
        req.method === "PATCH")
        ? await readBody(req) : null;
      const pageAnswer = await authPages(toWebRequest(req, body, {
        "x-ts-source": req.socket.remoteAddress || "unknown",
      }));
      if (pageAnswer) {
        // The shared handlers set the pages' own headers —
        // including the policy that admits the sign-in page's
        // one inline script, the passkey button's — so the
        // answer goes out as it stands.
        await sendWebResponse(res, pageAnswer);
        return;
      }
    }

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      const body = await readBody(req);
      await sendWebResponse(res, await handler(toWebRequest(req, body, {
        "x-ts-source": req.socket.remoteAddress || "unknown",
      })));
      return;
    }

    // The Feedback page stands only on a copy whose config
    // names a feedback target (issue #22): with no target set
    // the page's addresses answer not found here, before the
    // static files are read — the same answer the core's
    // submit route gives on such a copy.
    if ((pathname === "/feedback" || pathname === "/feedback.html") && !feedbackTarget(coreEnv)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
      res.end("Not found.");
      return;
    }

    // Page loads: the app itself, served openly like the files
    // around it (its script, styles, icons) — the API above is
    // the gate that matters, as it is on Cloudflare, where the
    // root is a Pages file no Worker route covers. The app
    // decides what a load shows: boards for a signed-in
    // account, the public page for a signed-out visitor
    // (issue #16 — a server-side bounce here meant the public
    // page could never show on a self-host copy).
    serveStatic(req, res, pathname);
  } catch (err) {
    if (err && err.code === "BODY_TOO_LARGE") {
      // The read was refused mid-stream (see readBody): answer
      // 413 and close, rather than drain the flood first.
      if (!res.headersSent) {
        res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
      }
      res.end("That request is larger than this server accepts.");
      res.on("finish", () => req.destroy());
      return;
    }
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Something went wrong on the server.");
  }
});

// Live updates arrive as an upgrade, outside the request flow:
// the core still settles who the socket belongs to — this path
// builds the same web request the core always sees, marks it
// with a socket id, and the acceptPush adapter pairs the two.
// A refused caller gets the core's own answer written plainly
// onto the socket before it closes.
server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  if (url.pathname !== "/api/push" && url.pathname !== "/api/v1/push") {
    socket.destroy();
    return;
  }
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  pendingSockets.set(id, { socket, head: req.headers });
  try {
    const response = await handler(toWebRequest(req, null, { "x-ts-socket-id": id }));
    if (pendingSockets.has(id)) {
      // Nobody claimed the socket: the caller was refused, and
      // the response says why.
      pendingSockets.delete(id);
      const body = Buffer.from(await response.text());
      // One write, whole: ending the socket on the headers first
      // and writing the body after it is a write-after-end, whose
      // unhandled error takes the whole process down (issue #108).
      const head = Buffer.from(
        "HTTP/1.1 " + response.status + " " + (response.statusText || "Error") + "\r\n" +
        "Content-Type: application/json\r\nContent-Length: " + body.length + "\r\n\r\n"
      );
      socket.end(Buffer.concat([head, body]));
    }
  } catch (err) {
    pendingSockets.delete(id);
    console.error(err);
    socket.destroy();
  }
});

const accountCountAtStart = await countAccounts(db).catch(() => 0);
function onListening() {
  console.log("TaskSparkle is running at http://localhost:" + PORT + "/");
  console.log(
    accountCountAtStart + (accountCountAtStart === 1 ? " account stands" : " accounts stand") +
    " on this copy."
  );
  if (accountCountAtStart === 0) {
    console.log(
      "No accounts yet: open the address above and add the first name — " +
      "it becomes the administrator."
    );
  }
  if (bindHost) {
    console.log("Listening on " + bindHost + " only: other machines cannot reach this copy directly.");
  }
  console.log("Agents connect at " + agentScheme + "://" + agentHost + "/api/v1");
  console.log("Data lives in " + dataDir);
}
if (bindHost) server.listen(PORT, bindHost, onListening);
else server.listen(PORT, onListening);

// A plain stop (Ctrl-C, or the service manager's stop) closes the
// database properly: the write-ahead log folds back into the one
// data file, so the folder a backup copies holds a single current
// tasksparkle.sqlite.
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    try { db.close(); } catch (e) { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
