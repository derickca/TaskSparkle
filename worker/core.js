"use strict";

// TaskSparkle API core.
//
// This file is the whole API: the routes, the data access, the
// caller checks, the seeding and the agent directions. It runs in
// two homes — the Cloudflare Worker (worker/worker.js, a thin
// entry around this core) and the self-host server (server/) —
// and takes its three ties to the outside world as adapters
// handed to createApiHandler at the bottom of this file: the
// database, in the D1 shape (prepare, bind, run, first, all,
// batch); the person-door sign-in, which resolves a request to a
// person's email and name or to nothing; and push, which carries
// a new version number to the owner's open boards. Everything
// else in this file is shared, word for word.
//
// The Worker serves one API on two hosts, named by the BROWSER_HOST
// and AGENT_HOST settings in wrangler.toml:
// - The browser host is the people's door. A person signs in
//   with their own account — a name and a password, or a
//   passkey — and the deployment hands the core a session row
//   (worker/auth.js) for the cookie the browser carries. During
//   the transition window the door also still accepts a
//   Cloudflare Access token (JWT) in the Cf-Access-Jwt-Assertion
//   header, verified in full by the wrapper; that path resolves
//   only owner rows that already stand and seeds nothing new.
// - The agent host is the agents' door. It is in no
//   Access app. On this host Access headers are ignored completely and
//   only an agent key works, sent as Authorization: Bearer <key>.
//
// Either way the caller resolves to one owner, and every query below
// is scoped to that owner. One person's boards, labels, projects and
// cards are never visible to another person or to another person's
// agent key.
//
// Accounts live in the shared sign-in tables (worker/auth.js):
// an account links to its board set through accounts.owner_id,
// a link the claim flow is the only writer of. A key speaks for
// its owner while the owner's account stands and is linked;
// before any account stands on a deployment, the OWNER_EMAILS
// allowlist still answers for keys, as it always has.
//
// An agent key is stored only as its SHA-256 hash plus its last four
// characters. The full key is returned once, when it is made, and is
// never stored or shown again.
//
// An account linked to no board set yet seeds its space on its
// first request, when no board set stands unclaimed: an owners
// row, Personal and Professional boards, the five columns on each
// board and the default labels. Production seeding creates no
// projects and no cards. While board sets stand unclaimed, new
// accounts wait for the claim flow instead (see linkSeededOwner
// and resolveCaller).
//
// Every owner also carries a change marker: one version number that
// every accepted change raises by one, whoever made the change. It
// rides in the state and in every change's response, so a reader
// always knows which version it is looking at, and a writer can
// send the version it read as baseVersion to have a stale write
// refused rather than land on top of someone else's change. The
// moment a change lands, the new number is also pushed to the
// owner's open browsers through the deployment's push adapter (a
// Durable Object on Cloudflare, a socket hub in the self-host
// server), so a board left open shows changes as they happen. The number is all a push ever carries.
//
// Boards, columns, labels and projects can each carry an icon: one
// emoji. An unset board icon reads from the board's name and an
// unset column icon reads as the keycap number of its position;
// both are filled in on read, in the Icons section below.

// The two doors' hosts are settings, not constants: they stand in
// wrangler.toml under [vars], beside the routes that carry them, so
// a copy of this app deployed under other names reads its own. The
// agent host is the value the door checks truly need: a request
// arriving on it is an agent-door request, and a request arriving
// anywhere else may carry a person's Access token instead. The
// browser host is named too, so the Cloudflare entry's plain-HTTP
// redirect can tell the two real doors from a local rig's hostnames.
import {
  getAccount, listAccounts, countAccounts, countAdmins, createAccount, renameAccount,
  ensureAdminStanding, onlyAdminBlocked, ONLY_ADMIN_MESSAGE,
  mintInvite, getPasskey, listPasskeys, countPasskeys, addPasskey,
  removePasskey, notePasskeyUse, issueChallenge, spendChallenge,
  sessionFromRequest, touchSession, stampProof, rotateSession,
  revokeAccountSessions, writeAudit, recentAudit,
  throttleLocked, noteThrottleFailure, clearThrottle,
  verifyPassword, hashPassword, isCurrentHash, passwordProblem,
  verifyRegistration, verifyAssertion, nameKey, nameProblem,
  sessionCookieValue, expiredSessionCookieValue, viewCookieValue,
  eraseAccountCredentials, recordAgreement, latestAgreement,
  PROOF_FRESH_MS, CHALLENGE_MS, SESSION_COOKIE,
  b64uDecode
} from "./auth.js";

export function browserHost(env) {
  return String((env && env.BROWSER_HOST) || "").trim().toLowerCase();
}

export function agentHost(env) {
  return String((env && env.AGENT_HOST) || "").trim().toLowerCase();
}

// The scheme the agents' door is spoken to on. Cloudflare
// deployments leave AGENT_SCHEME unset and get "https", as the
// directions have always said; the self-host server sets it
// from its config's address, so a copy behind an HTTPS front
// door names https and a plain home-network copy names http.
// Anything but the word "http" reads as "https".
function agentScheme(env) {
  return String((env && env.AGENT_SCHEME) || "https").trim().toLowerCase() === "http" ? "http" : "https";
}

// The kinds of the five columns every board starts with. After that
// the columns are the owner's own: a column added later carries a
// generated kind of its own (see newColumnKind), and a column's kind
// never changes when the column is renamed or reordered.

var DEFAULT_BOARDS = [
  { kind: "personal", name: "Personal", position: 0 },
  { kind: "professional", name: "Professional", position: 1 }
];

var DEFAULT_COLUMNS = [
  { kind: "inbox", name: "Inbox", position: 0 },
  { kind: "ready", name: "Ready", position: 1 },
  { kind: "doing", name: "Doing", position: 2 },
  { kind: "waiting", name: "Waiting", position: 3 },
  { kind: "done", name: "Done", position: 4 }
];

// Label colours are palette ids from the front end's label palette.
// Each default label also starts with an icon (issue #44): one emoji
// that suits the name, so a fresh board reads with pictures from the
// first minute. An owner can change or clear any of them afterwards,
// the way any label icon works.
var DEFAULT_LABELS = {
  personal: [
    { kind: "household", name: "Household", colour: "green", icon: "🏠" },
    { kind: "family", name: "Family", colour: "amber", icon: "👪" },
    { kind: "health", name: "Health", colour: "blue", icon: "🩺" },
    { kind: "errands", name: "Errands", colour: "purple", icon: "🛒" }
  ],
  professional: [
    { kind: "admin", name: "Admin", colour: "grey", icon: "📋" },
    { kind: "writing", name: "Writing", colour: "violet", icon: "✍️" },
    { kind: "building", name: "Building", colour: "teal", icon: "🛠️" },
    { kind: "outreach", name: "Outreach", colour: "pink", icon: "📣" },
    { kind: "money", name: "Money", colour: "lime", icon: "💰" }
  ]
};

var THEME_MODES = ["system", "light", "dark"];

// Size limits, sized well past ordinary use. They exist for the
// one caller who can hurt a board without meaning to: an agent
// holding a valid key, stuck in a loop. A write past a limit is
// refused whole, like any other invalid write. Lengths count
// characters as the caller sent them.
var LIMITS = {
  nameChars: 120,        // board, column, label and project names
  colourChars: 40,       // a palette id or a hex colour
  titleChars: 300,       // a card's title
  notesChars: 10000,     // a card's notes
  stepChars: 500,        // one checklist step
  linkNameChars: 200,    // a link's name
  linkUrlChars: 2000,    // a link's address, after cleaning
  commentChars: 2000,    // one comment's body
  boardsPerOwner: 50,
  keysPerOwner: 10,
  columnsPerBoard: 30,
  labelsPerBoard: 100,
  projectsPerBoard: 100,
  cardsPerBoard: 2000,
  stepsPerCard: 200,
  linksPerCard: 100,
  commentsPerCard: 500
};

// True when a text value runs past its limit.
function overLimit(value, max) {
  return value != null && String(value).length > max;
}

// How many rows a count query found, read as a plain number.
function countOf(row) {
  return row ? Number(row.count || 0) : 0;
}

// The build stamp. The same stamp stands in app.js, word for
// word: on every open the app reads the stamp this Worker serves
// (on the version route) and, when the two disagree, reloads
// itself once — a browser still holding an older app from its
// cache is how a stale copy used to strand a person on the
// loading line. The deploy checks the two stamps agree and fails
// when they do not, so a release can never ship them mismatched.
// Bump both together whenever the app files change.
var BUILD_ID = "r2026-11-07-19";

// Every API answer carries two standing headers. Cache-Control:
// no-store, because state answers hold a person's boards and the
// key-creation answer holds a key shown once — neither may rest
// in any cache. Strict-Transport-Security, because the agents'
// door once answered over plain HTTP: a client that has ever
// reached either door over HTTPS is told to keep using HTTPS.
function json(data, status, headers) {
  var all = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "strict-transport-security": "max-age=31536000; includeSubDomains"
  };
  if (headers) {
    Object.keys(headers).forEach(function (name) { all[name] = headers[name]; });
  }
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: all
  });
}

function error(message, status) {
  return json({ error: message }, status || 400);
}

// A plain-text answer, with the same standing headers every API
// answer carries: no-store, because the text is read fresh each
// time, and the transport-security header the json helper sends.
function plainText(text, status) {
  return new Response(text, {
    status: status || 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "strict-transport-security": "max-age=31536000; includeSubDomains"
    }
  });
}

// The directions an agent works from, served by the API itself at
// GET /api/directions and GET /api/v1/directions (issue #17). They
// live in this file so they deploy in the same act as the API they
// describe and can never describe a different API than the one
// answering. The build stamp rides at the top, so an agent can
// name the revision it read. Everything the Set Up Agent panel's
// copied text once carried as its Reference stands here instead,
// corrected to the rules as they now stand; the panel's text is a
// short bootstrap that ends by pointing the agent here. When a
// route, a field or a rule changes, this text changes in the same
// commit, or the change is not finished.
function agentDirections(env) {
  var lines = [
    "TaskSparkle directions for agents",
    "Build: " + BUILD_ID,
    "",
    "TaskSparkle is a personal kanban board. The person who owns these boards has given you their agent key. These directions are served by the API itself, so they always match the API that answers you. Read them once when you connect, and read them again when the build stamp above changes.",
    "",
    "Base address: " + agentScheme(env) + "://" + agentHost(env) + "/api/v1",
    agentScheme(env) === "https"
      ? "Every route below is that address plus the path shown. The same routes also answer without the v1 segment: /api/state in place of /api/v1/state, on both doors. Only HTTPS answers; a call to the http spelling is redirected to https before any key is read."
      : "Every route below is that address plus the path shown. The same routes also answer without the v1 segment: /api/state in place of /api/v1/state, on both doors. This deployment answers over plain HTTP on its own network; there is no https spelling of it.",
    "Your first calls: read these directions, then GET /state, then work from what it shows. When an answer tells you the boards changed, read /state again rather than guessing.",
    "",
    "How to call",
    "- Send the key on every request as a header: Authorization: Bearer <key>.",
    "- Send an ordinary browser User-Agent on every request. The default header some HTTP libraries send is refused at the door with Cloudflare error 1010, before your key is even read.",
    "- Send every write as a JSON body with Content-Type: application/json.",
    "- Answers are JSON, except these directions, which are plain text. An error answer is one object with one field: error, a plain sentence saying what was refused and why.",
    "- No answer is cached: every answer carries Cache-Control: no-store.",
    "",
    "Reading the boards",
    "GET /state returns the owner's whole state in one answer: me (the owner's id and the name they go by — never their email, which a key does not need), version, theme, boards, labels, projects, cards and keys, plus agentHost: the agents' door host from this deployment's settings, the host the base address above names. keys is the owner's live agent keys, each an id and a name: the app's Next step chooser names them, and a hand-over to another key names its id from this list (see Handing over). The person's own sign-in reads a fuller state than a key does: their email, the newest key's last four characters and the date it was made, and the stamp of the latest change ride on the person's answer only, because the app's settings pages and its change marker use them; a key's state carries none of the three.",
    "Reads speak camelCase. Writes speak snake_case. The same fact has two spellings, one per direction, and each call takes only its own.",
    "A board reads as: id, name, icon, position, labelColourMode and columns. Its columns ride inside it: id, kind, name, icon and position, in board order.",
    "labelColourMode says how the app paints a card's first label colour on this board: chip keeps the colour on the label alone, background gives the card's face that colour faded, trim rings the card with a thick border in it, and top sets a thick band of it across the card's top. First means first in the board's own label order; a card with no labels is never painted. The label chips themselves always show. The mode is the board's own — it is part of what tells one board from another — and a board copy carries it. It starts at chip.",
    "A label reads as: id, boardId, name, icon and colour. A project reads as: id, boardId, name and icon. Each belongs to one board.",
    "A card reads as: id, boardId, columnId, title, notes, labels, due, projectId, archived, important, position, steps, links, comments, creatorKeyId, creatorKeyName and step.",
    "A card's columnId on a read is the column's kind, not its row id. The five starting kinds are inbox, ready, doing, waiting and done. A column added later carries a generated kind of its own. A kind never changes when its column is renamed or reordered, and a write takes that kind as column_id (a column's row id is accepted too).",
    "A card's labels are a list of label ids in the board's label order. Its steps are a list of id, text and done, in the order they stand on the card. Its links are a list of id, url and name, in the order the links were added. Its comments are a list of id, body, createdAt, authorKeyName and authorName, in the order the comments were written (see Comments).",
    "creatorKeyName is the name of the agent key that created the card, resolved from that key's record as the card is read, or null when the person made the card in the app. creatorKeyId, riding beside it, is that key's id, or null the same way: it tells two keys of one name apart, and it is what a step's keyId is compared against to know the maker holds the step — matched by id, never by name. The card records the key's id, never the name, so renaming the key renames the maker name on every card it made at once, and deleting the key changes nothing: its row stands, and its cards keep reading with its name. Cards made before the stamp existed also read null. See Cards.",
    "step says whose turn the card's next step is (see Handing over): step.holder is owner (the person), agent or none. When it is agent, step.keyId names the holding key and step.keyName is that key's name as it stands now, resolved from the key's record as the card is read. step.handedAt says when the step was last handed over, or null when it never has been; step.handedByKeyName names the key that handed it over the same way, or null when the person did, and step.handedByName names whoever handed it over — the key's current name, or the person's name as it stands now — or null when the step has never been handed over. step.waiting is true while the holder has not picked the card up yet: the holder's first write to the card clears it.",
    "due is the due date written YYYY-MM-DD, or an empty string when the card has none. projectId is null when the card carries no project.",
    "Archived cards come back in every state read, flagged archived: true. Archiving is not deleting: an archived card leaves the board and keeps its steps, its links and its labels.",
    "Icons on a read: a board, a column, a label and a project can each carry one emoji, and it rides in the state as icon. A board with no icon stored reads one from its name: a person for Personal, a building for Professional and a card box for any other name. A column with no icon stored reads the keycap number of its position. A project or label with no icon stored reads an empty icon.",
    "",
    "Version and baseVersion",
    "Every state read carries version: one number per owner. Every accepted change raises it by exactly one, whoever made the change, and every change's answer carries the new number as version. A refused change never raises it, and neither does a write that changes nothing.",
    "GET /version returns just that number and the build stamp: {version, build}. Read it when you only want to know whether anything changed.",
    "Each rise of the version also records, on the server, a stamp of who made that change — the person through their sign-in, or an agent with a key — and the time it landed. The stamp rides on the person's own answers only, never on a key's: a key watching the version learns that something changed, and nothing about when the person themselves is at their boards. You never need the stamp to work: baseVersion, below, is the whole contract — a 409 tells you the boards moved since your read. A write that changes nothing, and a refused write, raise no version and leave no stamp.",
    "Send the version you read as baseVersion with each change. If the boards changed since you read them, the change is refused with a 409 and this message: 'The boards changed since you read them. Read the state again, then send your change again.' Nothing is applied. Read the state again, then send your change again against the new version.",
    "A baseVersion that is not a number gets the same 409. A write with no baseVersion is applied unchecked, the way the person's own browser writes; an agent should always send one.",
    "",
    "Writing rules",
    "- A field a call does not take is refused with a 400 that names it: the answer reads that the field 'is not part of this call'. A misspelled field never passes quietly, so if a change seems to have had no effect, read the answer before anything else.",
    "- Every field of a write is judged before anything is written. A refused write changes nothing at all: no field lands, no update is sent and the version does not rise.",
    "- A body that is not JSON is refused with a 400. A route that needs a body refuses a missing or empty one the same way.",
    "- Ids that belong to another owner read as not found (404), on reads and writes alike. Your key reaches only its owner's boards.",
    "- Multi-step changes land as one act. A board copy, a new board with its columns and a card with its labels are each written as one database batch, so a failure partway leaves nothing half-done standing.",
    "- Answers to a write carry the thing written (board, column, label, project, card, step or link) plus the new version. A delete answers {ok: true} plus the new version.",
    "",
    "Routes",
    "GET /me - your id and the name the owner goes by. The owner's own sign-in gets their email on this answer too; a key does not.",
    "PATCH /me - set the owner's theme: theme, one of system, light or dark. The display name /me reports is the person's own to set, in the app; a key cannot change it.",
    "DELETE /me - delete the person's whole account: their boards, cards, comments and keys, gone in one act. The person's own call only — a key gets a 403, because a key can never erase its owner. See Keys and access.",
    "GET /state - the whole state (see Reading the boards).",
    "GET /queue - the cards whose next step is yours, across every board, each in the full card shape state carries (see Handing over). For the person it answers the cards whose step is theirs.",
    "GET /version - just the version number and the build stamp.",
    "GET /directions - these directions, as plain text.",
    "GET /push - a WebSocket for live updates (see Live updates).",
    "POST /boards - make a board: name, plus icon if one is given. A new board starts with the five standard columns (Inbox, Ready, Doing, Waiting and Done), with no labels and no projects.",
    "PATCH /boards/{board id} - change a board: name, position, icon and label_colour_mode, any of them. label_colour_mode takes chip, background, trim or top; anything else is refused.",
    "DELETE /boards/{board id} - delete a board. The board goes whole: its cards, active and archived alike, and its columns, labels and projects go with it. The one refusal is the owner's last board — a person always keeps at least one board.",
    "POST /boards/{board id}/copy - copy a board in one call: name for the copy, plus four true-or-false flags named columns, labels, projects and cards, saying what rides along. See Copying a board.",
    "POST /columns - add a column: board_id and name, plus kind and icon if given. The column lands at the end of its board. A kind is used only when it is a plain slug (lowercase letters, digits and hyphens) that no column on the board carries yet; otherwise one is generated.",
    "PATCH /columns/{column id} - change a column: name, position and icon, any of them. Position is its place counting from the left, starting at 0; the board's other columns shift around it.",
    "DELETE /columns/{column id} - remove a column. When the column holds cards, the body names the column that receives them as move_to_column_id (a column id or kind, on the same board): every card moves to the end of that column, the active ones in their order, archived ones after them and still archived, and the column is removed in the same act. A column holding cards but naming no destination is refused, and so is the board's last column. An empty column takes no body.",
    "POST /labels - add a label: board_id and name, plus colour and icon if given. Colour defaults to grey.",
    "PATCH /labels/{label id} - change a label: name, colour and icon, any of them.",
    "DELETE /labels/{label id} - delete a label. It lifts off its cards; a card's other labels stay.",
    "POST /projects - add a project: board_id and name, plus icon if given.",
    "PATCH /projects/{project id} - change a project: name and icon, any of them.",
    "DELETE /projects/{project id} - delete a project. Its cards carry on with no project.",
    "POST /cards - create a card: board_id, column_id and title are required; notes, labels, project_id, due_date and important may ride along, and next_step may name the step's first holder (see Handing over). The card lands at the end of its column.",
    "PATCH /cards/{card id} - edit a card: title, notes, labels, project_id, due_date, important, column_id, position, board_id, archived, next_step and comment, any of them. See Cards and Handing over.",
    "DELETE /cards/{card id} - delete a card for good, with its steps, its links and its comments.",
    "POST /cards/{card id}/steps - add a step: text, plus done if it starts ticked.",
    "PATCH /cards/{card id}/steps/{step id} - change a step: text, done and position, any of them. A position is the step's place in the card's list counting from the top at 0; the other steps shift around it.",
    "DELETE /cards/{card id}/steps/{step id} - remove a step.",
    "POST /cards/{card id}/links - add a link: url, plus name if one is given.",
    "PATCH /cards/{card id}/links/{link id} - change a link: url and name, either of them.",
    "DELETE /cards/{card id}/links/{link id} - remove a link.",
    "POST /cards/{card id}/comments - add a comment: body. See Comments.",
    "DELETE /cards/{card id}/comments/{comment id} - remove a comment.",
    "There is no key route for you, on purpose: see Keys and access.",
    "",
    "Cards",
    "- position is the card's place in its column, counting from the top starting at 0. Send position with a card edit to place the card: it takes that place, the column's other active cards shift around it, and every position is written back as one clean run from 0. A create takes no position; a new card lands at the end of its column.",
    "- column_id on an edit moves the card to that column on its board. board_id moves the card to another board in the same one edit: send column_id (a column id or kind on the new board) to choose the column it lands in, and project_id to choose its project on the new board, or null for no project. With no column_id it lands in the new board's column at the same place counting from the left as the column it leaves, or in the last column when the new board has fewer; with no project_id it takes the new board's project with the same name as the card's project, or none. The card lands at the end of its new column unless position rides along. Labels cross by name: a label the new board carries under the same name is worn there as that board's label, with its own colour and icon, and a label with no match on the new board is left behind. A labels list sent with a board move is not read — the server works the crossing out from the card's labels as they stand. Everything else travels: title, notes, due date, steps, links, comments, the archived state and whose step is next. The move is refused, and nothing changes, when the new board already holds as many cards as one board holds.",
    "- labels on a create or an edit replaces the card's whole set: send the full list of label ids the card should wear, or an empty list for none. Every id must be a label on the card's board. An id from another board, or one that does not exist, refuses the whole write and nothing changes.",
    "- project_id names a project on the card's board, or null for no project. A project from another board refuses the write.",
    "- due_date is a real calendar date written YYYY-MM-DD, or empty (an empty string or null) for no date. Anything else is refused: a shape that is not a date, and a date that does not exist, such as 2026-02-30.",
    "- important is a single flag: true or false, nothing else. There are no levels. The flag never changes a card's order.",
    "- archived: true archives the card. archived: false restores it: the card returns to its column, or to the board's first column if that column is gone. Steps, links, labels and comments survive archiving and restoring. Deleting a card is forever.",
    "- creatorKeyName records who wrote the card's first version. A card made with an agent key records that key's id, and the name it reads with is the key's name as it stands when the card is read: rename the key and the maker name on every card it made follows at once, and delete it and its cards keep its name, because its row stands as its record. A card the person made in the app carries null, and so does a card made before the stamp existed. A card made by copying a board takes whoever made the copy as its creator: the copy is a new first version.",
    "- There are no bulk calls. Clearing a column means archiving or deleting its cards one at a time, naming each card: every archive is a deliberate act on a named card.",
    "",
    "Handing over",
    "Every card's next step belongs to someone: the person, one of their keys, or no one. A card you create starts as your step; a card the person creates starts as theirs. GET /queue lists the cards whose next step is yours: work those cards. When you start on one, write to it — a comment, a step, any change — because your first write to the card is what marks it picked up; until then it stands as waiting on you, and the person can see that it waits.",
    "Hand a card over by sending next_step on a card edit (or on the create, to name its first holder): \"owner\" for the person, another key's id from the keys list in state, or \"none\" when no one holds the next step. A hand-over to someone else marks the card waiting for them; a hand-over to yourself, or a create that starts as your step, does not wait. Archiving a card clears its step to none, and no column move ever changes it: moving a card is not handing it over. Deleting a key hands every card it held back to the person.",
    "When you need the person, hand the step over with a comment saying what you need: send next_step and comment in the same card edit, and the comment posts as part of that one write. Never leave a card whose step is yours sitting idle without a comment on it saying why.",
    "",
    "Checklist steps",
    "A step carries text and a tick (done), nothing else. Steps come back with the card in the order they stand on the card. Add, rename, tick, untick, reorder and remove them through the step routes above: a step's order changes by sending its new position on the step's PATCH, and the card's steps are written back as one clean run.",
    "",
    "Links",
    "A link carries a web address and an optional name. An address typed without a scheme is stored with https:// added. A bare host with a port (a name, a colon, then digits) is stored the same way. Anything that is not an http or https address is refused with a 400 and nothing is stored. The address is stored cleaned, as the absolute address it names. TaskSparkle stores web addresses only, never files.",
    "",
    "Comments",
    "A comment is a note left on a card: progress updates and anything else worth saying about the card, kept with the card. A comment reads as id, body, createdAt, authorKeyName and authorName, and a card's comments come back in the order they were written. A comment records who wrote it as an identity — the key's id, or the person's — and the names are resolved from those records as the comment is read: authorKeyName is the writing key's name as it stands now, or null when the person wrote it, and authorName names the author either way, the key's current name or the person's current name. Rename the key or the person and every standing comment's author name follows at once. Add a comment with POST /cards/{card id}/comments and remove one with DELETE /cards/{card id}/comments/{comment id}; each is a change like any other, raising the version once. There is no edit: a comment is removed whole or stands as written. Archiving a card keeps its comments; deleting the card takes them with it. A board copy does not copy comments: they are the source board's conversation, not the card's content, so a copied card starts with none. Working a card starts with its comments: read them before changing anything on the card, because the person's progress updates and instructions about the card live there. Leave your own progress as comments on the card as the work goes, so the person and every other agent see it in one place.",
    "",
    "Icons on a write",
    "Send icon in the same call that sets the name. The value must be one emoji: one grapheme cluster carrying a pictograph, or a keycap sequence. An empty string clears it: a board or column falls back to its read default, and a project or label falls back to none. A value that is not one emoji is refused, and nothing is stored.",
    "",
    "Copying a board",
    "POST /boards/{board id}/copy makes the whole copy as one act with one version rise. The body names the copy and sets the four flags. Without columns: true, the copy starts with the five standard columns. Copied cards are the source's active cards only; archived cards never copy. A copied card lands in the new board's column at the same position index as its source column, clamped to the last column. Its labels and project point at the copies when labels and projects ride along, and land empty when those flags are off. Steps and links ride along with their cards. Comments never ride along: a copied card starts with no comments. A copied card's creator is whoever made the copy (see Cards).",
    "",
    "Live updates",
    "GET /push opens a WebSocket, authorized exactly like every other route. Each time a change lands, the socket receives the new version number as plain text: the number and nothing else, never state or card data. A socket that misses an update catches up by reading /version or /state.",
    "",
    "Watching for changes",
    "Polling GET /version is one small request, and a key's answer carries the version number alone (with the build stamp): the change stamp the server keeps — who made the latest change, and when — rides on the person's own answers only, never on a key's (see Version and baseVersion). When the number has moved past the last one you saw, something changed; read GET /state and compare it with the snapshot you keep to work out what.",
    "Who did the work is read off the work itself, from the stamps the work carries. A card's creatorKeyName names the key that created the card, as that key is named as the card is read, standing null when the person made the card in the app. A comment names its author outright: authorName is the writing key's current name for a key's comment and the person's current name for theirs, resolved as the comment is read, and authorKeyName names the writing key the same way or stands null when the person wrote it. Moves, edits and ticks carry no stamp: a card that changed columns, a step ticked, a title rewritten — the state shows the new shape and names nobody, so a watcher cannot attribute those, and must not guess.",
    "A hand-over is the one change of shape that does carry its author. When a card's step names a different holder than the last state you read, that change is a handed-over entry: it carries the name the step left and the name it went to — each the person, a key's name, or no one — and step.handedByKeyName names the key that handed it over, or stands null when the person did. A card that stops waiting between two states was picked up by its holder.",
    "Offer the person a recurring check (a cron) that watches their boards: on each run it reads /version, and when the number has moved it reads /state, works out what changed against the snapshot it keeps, and sends a short note about those changes to the chat each change belongs to. A few minutes between polls is plenty: the poll is one small request. Keep the snapshot and the version you last reported, so each change is reported once. Tell the person's work from an agent's by the stamps above: a new card or comment carrying a key's name is that key's work; one carrying none is the person's. The rest — moves, edits and ticks — arrive unattributed; report them as changes, never as the person's own acts. Offer the check; never set it up unasked. When you work out what changed, comments are part of it: a new comment on a card is a change worth routing, and the note about it carries the comment's text, not just the fact of it.",
    "",
    "Limits",
    "Sizes are capped well past ordinary use, and a write past a cap is refused whole. Lengths count characters as sent.",
    "- Names (board, column, label and project): 120 characters. A colour: 40. A card title: 300. A card's notes: 10000. A step: 500. A link's name: 200. A link's address, after cleaning: 2000. A comment's body: 2000.",
    "- Per owner: 50 boards and 10 agent keys. Per board: 30 columns, 100 labels, 100 projects and 2000 cards. Per card: 200 steps, 100 links and 500 comments.",
    "",
    "Keys and access",
    "- An owner holds a list of named keys, all live at once, up to 10. Each key stands on its own: it carries its owner's full powers over the boards, and making, renaming or revoking another key never touches it.",
    "- Keys are managed by the person alone, in the app under Settings, then Set Up Agent: they make a key under a name (the full key shows once, at that moment), rename a key (the name only; the key itself never changes), and delete a key (that key stops working at once; the others are untouched).",
    "- A key's name rides on the work it does as the key is named when the work is read: the cards it creates and holds, the comments it writes and the hand-overs it makes all record the key itself, never its name, so renaming a key renames its name on the work everywhere at once, and deleting a key leaves its name standing on its work, because the key's row stands as its record. The person is told this where keys are named, before they name one.",
    "- The /me/token routes answer only the signed-in browser: a call carrying a key gets a 403. Do not call them. A key can never mint, rename or revoke a key, so a leaked key cannot lock the person's other agents out.",
    "- The sign-in routes answer only the signed-in browser the same way: passkeys, the password and the Admin page are the person's own, under /api/auth. A call carrying a key gets a 403 on every one of them. A key can never enrol a passkey, change a password, mint an invite or be exchanged for the person's session.",
    "- A key speaks for its owner while the owner's account stands and is linked to their boards, and that is checked on every request, at both doors. If the person's account is removed, their keys stop working from the next request on. An account that stands but is not linked to any boards yet — a new account waiting to be linked — answers its keys the same way: not yet.",
    "- A person can delete their own boards and account in the app, under Settings, then Account (DELETE /me): the act deletes the owner's row and everything under it — boards, cards, steps, links, comments and keys — in one act, and their keys stop working in the same act, yours included. It is the person's own act only; a key calling the route gets a 403. Copies inside the nightly backups are the one remainder: each export holds the whole database, and exports age out of the backup bucket within 14 days, so a deletion is fully gone once the exports that predate it have aged out. An administrator removing a person under Settings, then Admin, is the same whole erasure done by another hand; there is no softer removal that keeps the boards.",
    "- 401 means the key did not work: it is wrong or revoked. 403 means the key worked but the call is not allowed, or the owner's account no longer stands linked to their boards. Either way, tell the person, and they will check the key in TaskSparkle under Settings, then Set Up Agent.",
    "- Keep the key secret. Never write it into a file, a card or a message, and never show it back to the person in full."
  ];
  return lines.join("\n") + "\n";
}

function newId(prefix) {
  return prefix + "-" + crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

async function sha256Hex(value) {
  var bytes = new TextEncoder().encode(value);
  var digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(function (byte) {
    return byte.toString(16).padStart(2, "0");
  }).join("");
}

// An agent key is the prefix plus 32 random bytes written as hex.
function makeAgentKey() {
  var bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  var body = Array.from(bytes).map(function (byte) {
    return byte.toString(16).padStart(2, "0");
  }).join("");
  return "tsk_live_" + body;
}

function ownerNameFromEmail(email) {
  var local = email.split("@")[0].split(/[._-]+/).filter(Boolean);
  if (!local.length) return "Owner";
  return local.map(function (part) {
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(" ");
}

function allowlist(env) {
  return String(env.OWNER_EMAILS || "").split(",").map(function (s) {
    return s.trim().toLowerCase();
  }).filter(Boolean);
}

// --- Owners and seeding ---

async function seedOwnerBoards(db, owner) {
  var existing = await db.prepare("SELECT COUNT(*) AS count FROM boards WHERE owner_id = ?")
    .bind(owner.id).first();
  if (existing && Number(existing.count) > 0) return;

  for (var b = 0; b < DEFAULT_BOARDS.length; b++) {
    var boardDef = DEFAULT_BOARDS[b];
    var boardId = owner.id + "-" + boardDef.kind;
    var stamp = nowIso();
    await db.prepare("INSERT INTO boards (id, owner_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(boardId, owner.id, boardDef.name, boardDef.position, stamp, stamp).run();

    for (var c = 0; c < DEFAULT_COLUMNS.length; c++) {
      var columnDef = DEFAULT_COLUMNS[c];
      await db.prepare('INSERT INTO "columns" (id, board_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(boardId + "-" + columnDef.kind, boardId, columnDef.name, columnDef.position, stamp, stamp).run();
    }

    var labelDefs = DEFAULT_LABELS[boardDef.kind] || [];
    for (var l = 0; l < labelDefs.length; l++) {
      var labelDef = labelDefs[l];
      await db.prepare("INSERT INTO labels (id, board_id, name, icon, colour, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(boardId + "-" + labelDef.kind, boardId, labelDef.name, labelDef.icon || null, labelDef.colour, stamp, stamp).run();
    }
  }
}

// The name a person goes by everywhere the app and the API
// show one: the name they set for themselves in Settings
// (owners.display_name) when they have set one, and otherwise
// the name their sign-in carries (owners.name). The two are
// kept apart so a sign-in refresh can never overwrite the
// person's own choice (issue #66).
function effectiveName(owner) {
  return owner.display_name || owner.name;
}

// The transition door's owner lookup (issue #109): while the
// Access path still stands beside the new door, it resolves
// only owner rows that already stand — it creates nothing and
// seeds no board set, so the claim page's inventory cannot grow
// mid-migration. The OWNER_EMAILS allowlist remains its brake
// for the window: an email off the list resolves to nothing.
// The name refresh (issue #66) stands: a real name arriving
// with the sign-in replaces a stored guess, and the person's
// own display_name outranks it wherever one is shown.
async function accessOwnerFromEmail(db, env, email, displayName) {
  var normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;
  if (allowlist(env).indexOf(normalized) === -1) return null;
  var owner = await db.prepare("SELECT * FROM owners WHERE email = ?").bind(normalized).first();
  if (!owner) return null;
  var claim = displayName ? String(displayName).trim() : "";
  if (claim && (owner.name_guessed || owner.name !== claim)) {
    await db.prepare("UPDATE owners SET name = ?, name_guessed = 0 WHERE id = ?")
      .bind(claim, owner.id).run();
    owner.name = claim;
    owner.name_guessed = 0;
  }
  return owner;
}

// The fresh owner row an account seeds for itself, in the
// owners table's own shape. The identity string it carries is
// the account's key: on a home copy that is the sign-in name
// folded to lower case, the string the owners table has always
// held there; on a hosted fresh install it is the same — the
// person's name, not an address, and the app shows it as such.
function freshOwnerRow(account) {
  return {
    id: newId("owner"),
    email: account.key,
    name: account.name,
    display_name: null,
    name_guessed: 0,
    theme: "system",
    state_version: 0,
    last_change_by: null,
    last_change_at: null,
    created_at: nowIso()
  };
}

// Links an account to a board set of its own, when it may have
// one: while board sets stand unclaimed — owner rows no
// account points at — a new account does NOT seed a fresh set
// (its boards might be one of the standing ones; the claim
// flow decides). When nothing stands unclaimed, the account
// seeds its own set, as accounts always have, and the link is
// written. Answers the owner row, or null when the account
// must wait to be linked.
async function linkSeededOwner(db, authDb, account) {
  var linkedRows = (await authDb.prepare(
    "SELECT owner_id FROM accounts WHERE owner_id IS NOT NULL"
  ).all()).results;
  var linkedIds = {};
  linkedRows.forEach(function (row) { linkedIds[row.owner_id] = true; });
  var ownerRows = (await db.prepare("SELECT id FROM owners").all()).results;
  var unclaimed = ownerRows.filter(function (row) { return !linkedIds[row.id]; });
  if (unclaimed.length > 0) return null;
  var owner = freshOwnerRow(account);
  await db.prepare("INSERT INTO owners (id, email, name, name_guessed, theme, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(owner.id, owner.email, owner.name, owner.name_guessed, owner.theme, owner.created_at).run();
  await authDb.prepare("UPDATE accounts SET owner_id = ? WHERE key = ?")
    .bind(owner.id, account.key).run();
  account.owner_id = owner.id;
  return owner;
}

// Whether the request carried the door's session cookie, under
// the name the deployment's adapter gives (CF_Authorization on
// Cloudflare). The check reads the Cookie header's pairs, nothing
// else.
function presentedCookie(request, name) {
  var header = request.headers.get("Cookie") || "";
  var pairs = header.split(";");
  for (var i = 0; i < pairs.length; i++) {
    if (pairs[i].trim().indexOf(name + "=") === 0) return true;
  }
  return false;
}

// Resolves the caller to an owner, or to the error response to send.
// Bearer key first, on either host. Without a key, only the people's
// door accepts a signed-in person: first the account session (the
// ts_session cookie, resolved against the session rows by
// worker/auth.js), then — during the transition window only — the
// deployment's Access adapter, which resolves owner rows that
// already stand and creates nothing. The agents' door takes keys
// only.
//
// A session caller whose account is not linked to a board set
// resolves with an account and no owner: the handler below lets
// such a caller reach the sign-in routes (the claim flow among
// them) and nothing else.
async function resolveCaller(request, deps, host) {
  var db = deps.db;
  var env = deps.env;
  var authDb = deps.authDb || deps.db;
  var auth = request.headers.get("Authorization") || "";

  if (auth.indexOf("Bearer ") === 0) {
    var token = auth.slice("Bearer ".length).trim();
    if (token) {
      var hash = await sha256Hex(token);
      var row = await db.prepare(
        "SELECT owners.*, api_tokens.id AS token_id, api_tokens.label AS token_label " +
        "FROM api_tokens JOIN owners ON owners.id = api_tokens.owner_id " +
        "WHERE api_tokens.token_hash = ? AND api_tokens.revoked_at IS NULL"
      ).bind(hash).first();
      if (row) {
        // A key speaks for its owner while the owner's account
        // stands and is linked to the owner's boards. Once any
        // account stands on the deployment, an unclaimed board
        // set's keys answer the same 403 an off-allowlist owner
        // gets — the set is inert until it is claimed. Before
        // any account stands (the window before the first setup
        // press), the allowlist still answers for keys, as it
        // always has.
        if ((await countAccounts(authDb)) > 0) {
          var linkedAccount = await authDb.prepare(
            "SELECT key FROM accounts WHERE owner_id = ?"
          ).bind(row.id).first();
          if (!linkedAccount) {
            return { error: error("This key's owner is not on the TaskSparkle allowlist.", 403) };
          }
        } else if (allowlist(env).indexOf(String(row.email || "").trim().toLowerCase()) === -1) {
          return { error: error("This key's owner is not on the TaskSparkle allowlist.", 403) };
        }
        await seedOwnerBoards(db, row);
        // The key's own identity rides along: a card or a comment
        // written through this call is stamped with the key that
        // wrote it — its id — so the work names its maker. The
        // name rides this call for the answers that need it now;
        // the name the work reads with resolves from the key's
        // row as the work is read (issues #120, #121).
        return { owner: row, via: "agent-token", key: { id: row.token_id, name: row.token_label || "Agent" } };
      }
    }
    return { error: error("That key does not work. Check the key in TaskSparkle under Settings, then Set Up Agent.", 401) };
  }

  // The people's door is every host but the agents' door — where
  // the deployment has an agents' door of its own at all. The
  // hosted copy names two hosts, a people's and an agents', and
  // there the split binds: a session is worth nothing at the
  // agents' address. A copy that names no people's host beside
  // the agents' one — the self-host server, which serves one
  // address — has one door: a request with a key is an agent and
  // a request with a session is a person at the same name. The
  // split once rested on the agents' address carrying a port a
  // bare hostname never carries; a portless agents' address (a
  // Tailscale Serve address is one) made every request read as
  // an agents'-door request and locked every person out (issue
  // #115). The session is preferred over the transition door's
  // token when both are presented: once a person holds the new
  // door's session, it is the one that speaks.
  var twoDoors = !!browserHost(env) && browserHost(env) !== agentHost(env);
  if (!twoDoors || host !== agentHost(env)) {
    var standing = await sessionFromRequest(authDb, request);
    if (standing) {
      await touchSession(authDb, standing.session);
      var account = standing.account;
      var owner = null;
      if (account.owner_id) {
        owner = await db.prepare("SELECT * FROM owners WHERE id = ?")
          .bind(account.owner_id).first();
        if (!owner) account.owner_id = null; // the set is gone; the account waits again
      }
      if (!owner) {
        owner = await linkSeededOwner(db, authDb, account);
      }
      if (owner) await seedOwnerBoards(db, owner);
      return {
        owner: owner, account: account, session: standing.session,
        via: "account"
      };
    }
    if (deps.auth && typeof deps.auth.accessIdentity === "function") {
      var identity = await deps.auth.accessIdentity(request);
      if (identity) {
        var person = await accessOwnerFromEmail(db, env, identity.email, identity.name || null);
        if (!person) {
          return { error: error("This sign-in is not on the TaskSparkle allowlist.", 403) };
        }
        await seedOwnerBoards(db, person);
        return { owner: person, via: "access" };
      }
    }
    // No door vouched for this caller. When the request still
    // carried the transition door's session cookie, the 401
    // answer expires that cookie (issue #49): a session the
    // door refuses would otherwise ride along on every retry,
    // and the app's Reload would present it forever and never
    // reach a fresh sign-in. A deployment whose adapter names
    // no such cookie skips this, as it has nothing to expire.
    var refused = error("Sign-in is required.", 401);
    if (deps.sessionCookieName && presentedCookie(request, deps.sessionCookieName)) {
      refused.headers.set("Set-Cookie",
        deps.sessionCookieName + "=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
    }
    return { error: refused };
  }

  return { error: error("An agent key is required on this address. Send it as Authorization: Bearer <key>.", 401) };
}

// --- Row lookups, all scoped to the caller ---

async function ownerBoard(db, ownerId, boardId) {
  return db.prepare("SELECT * FROM boards WHERE id = ? AND owner_id = ?")
    .bind(boardId, ownerId).first();
}

async function ownerColumn(db, ownerId, columnId) {
  return db.prepare(
    'SELECT "columns".* FROM "columns" JOIN boards ON boards.id = "columns".board_id ' +
    'WHERE "columns".id = ? AND boards.owner_id = ?'
  ).bind(columnId, ownerId).first();
}

async function ownerLabel(db, ownerId, labelId) {
  return db.prepare(
    "SELECT labels.* FROM labels JOIN boards ON boards.id = labels.board_id " +
    "WHERE labels.id = ? AND boards.owner_id = ?"
  ).bind(labelId, ownerId).first();
}

async function ownerProject(db, ownerId, projectId) {
  return db.prepare(
    "SELECT projects.* FROM projects JOIN boards ON boards.id = projects.board_id " +
    "WHERE projects.id = ? AND boards.owner_id = ?"
  ).bind(projectId, ownerId).first();
}

async function ownerCardRow(db, ownerId, cardId) {
  return db.prepare(
    "SELECT cards.* FROM cards JOIN boards ON boards.id = cards.board_id " +
    "WHERE cards.id = ? AND boards.owner_id = ?"
  ).bind(cardId, ownerId).first();
}

// One checklist step on one of the caller's cards. The step scopes
// to the caller through its card and its card's board, the same way
// the card itself does.
async function ownerChecklistItem(db, ownerId, cardId, itemId) {
  return db.prepare(
    "SELECT checklist_items.* FROM checklist_items " +
    "JOIN cards ON cards.id = checklist_items.card_id " +
    "JOIN boards ON boards.id = cards.board_id " +
    "WHERE checklist_items.id = ? AND checklist_items.card_id = ? AND boards.owner_id = ?"
  ).bind(itemId, cardId, ownerId).first();
}

// One link on one of the caller's cards. The link scopes to the
// caller through its card and its card's board, the same way the
// card itself does.
async function ownerCardLink(db, ownerId, cardId, linkId) {
  return db.prepare(
    "SELECT card_links.* FROM card_links " +
    "JOIN cards ON cards.id = card_links.card_id " +
    "JOIN boards ON boards.id = cards.board_id " +
    "WHERE card_links.id = ? AND card_links.card_id = ? AND boards.owner_id = ?"
  ).bind(linkId, cardId, ownerId).first();
}

// One comment on one of the caller's cards. The comment scopes
// to the caller through its card and its card's board, the same
// way the card itself does.
async function ownerCardComment(db, ownerId, cardId, commentId) {
  return db.prepare(
    "SELECT card_comments.* FROM card_comments " +
    "JOIN cards ON cards.id = card_comments.card_id " +
    "JOIN boards ON boards.id = cards.board_id " +
    "WHERE card_comments.id = ? AND card_comments.card_id = ? AND boards.owner_id = ?"
  ).bind(commentId, cardId, ownerId).first();
}

// A link address from a caller, cleaned to the absolute http or
// https address to store, or null when the value is not one. An
// address typed without a scheme gains https://. Anything carrying
// another scheme (ftp, mailto, javascript and friends) is refused,
// as is anything the URL parser cannot read as an address with a
// host. The editor runs the same rule before it sends, so the
// refusal a person sees is the refusal the server would give. Links
// are addresses only: TaskSparkle never stores files.
function cleanLinkUrl(value) {
  var raw = String(value == null ? "" : value).trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      // A scheme-shaped prefix is present. A bare host with a port
      // (a name, a colon, then digits) is the one scheme-shaped
      // value that is still an address without a scheme.
      var afterColon = raw.slice(raw.indexOf(":") + 1);
      if (!/^\d+([/?#]|$)/.test(afterColon)) return null;
    }
    raw = "https://" + raw;
  }
  var parsed;
  try {
    parsed = new URL(raw);
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return parsed.href;
}

// --- Icons ---
//
// A board, a column, a label and a project can each carry an icon:
// one emoji, stored in the row's icon column. One component in the
// app picks them and this one rule cleans them, so the value a
// caller sends is judged the same way everywhere.
//
// An unset icon is filled on read, never in the row. A board reads
// an icon from its name: Personal a person, Professional a
// building, any other board a card box. A column reads the keycap
// number of its position, so the five seeded columns read 0 to 4 —
// the Inbox is 0 — and a column added later reads its own place.
// A reorder never renumbers a stored icon; it only changes which
// number an unset column reads. Projects and labels have no
// default: unset reads as no icon at all.

var BOARD_ICON_DEFAULTS = { "Personal": "👤", "Professional": "🏢" };
var BOARD_ICON_FALLBACK = "🗂️";
var COLUMN_ICON_NUMBERS = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
var COLUMN_ICON_FALLBACK = "🔢";

function boardIcon(row) {
  if (row.icon) return row.icon;
  return BOARD_ICON_DEFAULTS[row.name] || BOARD_ICON_FALLBACK;
}

// The four ways a board paints a card's first label colour
// (issue #95): chip keeps the colour on the label alone, and
// background, trim and top put it on the card itself — as a
// faded background, a thick trim around the card or a band
// across its top. A board row written before the mode existed,
// or holding anything else, reads as chip: the way boards have
// always looked.
var LABEL_COLOUR_MODES = ["chip", "background", "trim", "top"];
function boardLabelMode(row) {
  return LABEL_COLOUR_MODES.indexOf(row.label_colour_mode) !== -1 ? row.label_colour_mode : "chip";
}

function columnIcon(row) {
  if (row.icon) return row.icon;
  var position = Number(row.position) || 0;
  return COLUMN_ICON_NUMBERS[position] || COLUMN_ICON_FALLBACK;
}

// How many grapheme clusters a string holds. A keycap emoji is
// three code points and one cluster, so clusters are what count.
// Intl.Segmenter does the counting where it exists; the fallback
// strips the marks that join an emoji into one cluster (the
// variation selector, the keycap mark and the zero-width joiner)
// and counts whole characters.
function graphemeCount(value) {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    var segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(value)).length;
  }
  return Array.from(value.replace(/[\uFE0F\u20E3\u200D]/g, "")).length;
}

// Cleans an icon value from a request body. Returns the icon to
// store, "" when the value clears the icon, and null when the value
// is not one emoji, so the caller can refuse it and store nothing.
function cleanIcon(value) {
  if (value == null) return "";
  var text = String(value).trim();
  if (!text) return "";
  if (text.length > 16) return null;
  if (graphemeCount(text) !== 1) return null;
  // One cluster is not enough on its own: a bare letter or digit is
  // one cluster too, and it is not an emoji. An icon carries a
  // pictograph, or the keycap mark that makes 1️⃣ and its friends.
  if (!/[\u20E3\p{Extended_Pictographic}\p{Emoji_Presentation}]/u.test(text)) return null;
  return text;
}

// Reads the icon a request body carries. Returns undefined when the
// body has no icon field at all, so a caller can tell "leave it
// alone" apart from "clear it".
function bodyIcon(body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, "icon")) return undefined;
  return cleanIcon(body.icon);
}

// A column value from a caller can be the column row id or its kind.
// Both resolve on the board.
async function columnForBoard(db, boardId, columnValue) {
  var direct = await db.prepare('SELECT * FROM "columns" WHERE id = ? AND board_id = ?')
    .bind(columnValue, boardId).first();
  if (direct) return direct;
  return db.prepare('SELECT * FROM "columns" WHERE id = ? AND board_id = ?')
    .bind(boardId + "-" + columnValue, boardId).first();
}

// A column's kind is the part of its row id after the board id. Every
// column this Worker makes carries its kind there: the seeded columns
// carry inbox, ready, doing, waiting or done, and a column added
// later carries a generated kind. The name and the position live in
// their own columns, so renaming or reordering a column never changes
// its kind, and a card addressed by kind keeps meaning the same
// column. A row id that does not follow the pattern reads as its own
// kind, which still names exactly that column.
function columnKind(columnRow) {
  var prefix = columnRow.board_id + "-";
  if (columnRow.id.indexOf(prefix) === 0 && columnRow.id.length > prefix.length) {
    return columnRow.id.slice(prefix.length);
  }
  return columnRow.id;
}

// A board's columns in their order: position first, oldest first
// where positions tie.
async function boardColumns(db, boardId) {
  return (await db.prepare(
    'SELECT * FROM "columns" WHERE board_id = ? ORDER BY position, created_at'
  ).bind(boardId).all()).results;
}

// The kind for a column being added to a board. A caller may ask for
// a kind; it is used when it is a plain slug and no column on the
// board carries it yet. Otherwise one is generated. Kinds only have
// to be unique on their own board.
async function newColumnKind(db, boardId, wanted) {
  var taken = {};
  var rows = await boardColumns(db, boardId);
  rows.forEach(function (row) { taken[columnKind(row)] = true; });
  if (wanted && /^[a-z0-9][a-z0-9-]*$/.test(wanted) && !taken[wanted]) {
    return wanted;
  }
  var kind = "";
  do {
    kind = "c" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  } while (taken[kind]);
  return kind;
}

// Writes positions 0, 1, 2 and on back onto a board's columns, in the
// order the rows are given. Used after a reorder or a removal, so a
// board's positions always read as one clean run from the left.
async function renumberColumns(db, orderedRows) {
  var stamp = nowIso();
  var statements = [];
  for (var i = 0; i < orderedRows.length; i++) {
    if (Number(orderedRows[i].position) !== i) {
      statements.push(db.prepare('UPDATE "columns" SET position = ?, updated_at = ? WHERE id = ?')
        .bind(i, stamp, orderedRows[i].id));
    }
  }
  await batchRun(db, statements);
}

// A column's cards in their order, the active ones: position first,
// oldest first where positions tie. Archived cards sit outside the
// run a column's order is counted in.
async function columnCards(db, columnId) {
  return (await db.prepare(
    "SELECT * FROM cards WHERE column_id = ? AND archived = 0 ORDER BY position, created_at"
  ).bind(columnId).all()).results;
}

// Writes positions 0, 1, 2 and on back onto a column's cards, in
// the order the rows are given — the cards' half of the same clean
// run renumberColumns keeps for a board's columns.
async function renumberCards(db, orderedRows) {
  var stamp = nowIso();
  var statements = [];
  for (var i = 0; i < orderedRows.length; i++) {
    if (Number(orderedRows[i].position) !== i) {
      statements.push(db.prepare("UPDATE cards SET position = ?, updated_at = ? WHERE id = ?")
        .bind(i, stamp, orderedRows[i].id));
    }
  }
  await batchRun(db, statements);
}

// Writes positions 0, 1, 2 and on back onto a card's steps, in
// the order the rows are given — the steps' half of the same clean
// run renumberCards keeps for a column's cards.
async function renumberSteps(db, orderedRows) {
  var stamp = nowIso();
  var statements = [];
  for (var i = 0; i < orderedRows.length; i++) {
    if (Number(orderedRows[i].position) !== i) {
      statements.push(db.prepare("UPDATE checklist_items SET position = ?, updated_at = ? WHERE id = ?")
        .bind(i, stamp, orderedRows[i].id));
    }
  }
  await batchRun(db, statements);
}

// A card's steps in their order: position first, oldest first
// where positions tie. The rows stepsForCard shapes for a read,
// unshaped, for a write that is about to move one of them.
async function stepRowsForCard(db, cardId) {
  return (await db.prepare(
    "SELECT * FROM checklist_items WHERE card_id = ? ORDER BY position, created_at"
  ).bind(cardId).all()).results;
}

// Puts a step at one place in its card's list, counting from the
// top starting at 0. The card's other steps shift around it and
// every position is written back as one clean run.
async function placeStepAtIndex(db, cardId, stepRow, index) {
  var rows = await stepRowsForCard(db, cardId);
  var others = rows.filter(function (row) { return row.id !== stepRow.id; });
  var wanted = Math.floor(Number(index) || 0);
  var at = Math.max(0, Math.min(wanted, others.length));
  others.splice(at, 0, stepRow);
  await renumberSteps(db, others);
}

// Puts a card at one place in its column, counting from the top
// starting at 0. The column's other active cards shift around it
// and every position is written back as one clean run. When the
// card changed columns to get here, the column it left is written
// back as a clean run too, so neither column keeps a gap.
async function placeCardAtIndex(db, cardBefore, cardAfter, index) {
  if (cardBefore.column_id !== cardAfter.column_id) {
    await renumberCards(db, await columnCards(db, cardBefore.column_id));
  }
  var target = await columnCards(db, cardAfter.column_id);
  var others = target.filter(function (row) { return row.id !== cardAfter.id; });
  var wanted = Math.floor(Number(index) || 0);
  var at = Math.max(0, Math.min(wanted, others.length));
  others.splice(at, 0, cardAfter);
  await renumberCards(db, others);
}

// Cleans a labels value from a caller: the label ids it names,
// each one a label on the board, in the order named, with repeats
// dropped. An empty list means the card wears no labels. Returns
// undefined when the value is not a list or any id does not belong
// to the board, so the caller can refuse the whole write and
// change nothing.
async function labelIdsForBoard(db, boardId, labelsValue) {
  if (!Array.isArray(labelsValue)) return undefined;
  var wanted = [];
  for (var i = 0; i < labelsValue.length; i++) {
    var id = labelsValue[i];
    if (typeof id !== "string" || !id || id === "none") return undefined;
    if (wanted.indexOf(id) === -1) wanted.push(id);
  }
  if (!wanted.length) return [];
  var rows = (await db.prepare("SELECT id FROM labels WHERE board_id = ?")
    .bind(boardId).all()).results;
  var onBoard = {};
  rows.forEach(function (row) { onBoard[row.id] = true; });
  for (var w = 0; w < wanted.length; w++) {
    if (!onBoard[wanted[w]]) return undefined;
  }
  return wanted;
}

// Replaces a card's label rows with the given ids, as one batch:
// the card never stands wearing half its new set.
async function setCardLabels(db, cardId, labelIds) {
  var statements = [db.prepare("DELETE FROM card_labels WHERE card_id = ?").bind(cardId)];
  for (var i = 0; i < labelIds.length; i++) {
    statements.push(db.prepare("INSERT INTO card_labels (card_id, label_id) VALUES (?, ?)")
      .bind(cardId, labelIds[i]));
  }
  await batchRun(db, statements);
}

// A card's label ids in the board's label order: the order the
// state returns that board's labels in. Labels made in one seeding
// pass share a created_at stamp, so the rowid breaks the tie —
// insertion order is the board's label order.
async function labelsForCard(db, cardId) {
  var rows = (await db.prepare(
    "SELECT card_labels.label_id AS label_id FROM card_labels " +
    "JOIN labels ON labels.id = card_labels.label_id " +
    "WHERE card_labels.card_id = ? ORDER BY labels.created_at, labels.rowid"
  ).bind(cardId).all()).results;
  return rows.map(function (row) { return row.label_id; });
}

// The label ids a card wears after a move to another board
// (issue #163): labels cross by name. Each of the card's labels,
// in its board's label order, takes the id of the destination
// board's first label with the same name; a label with no match
// there is left behind. The mapping is worked out here, at write
// time, from the labels as they stand — a caller never names the
// destination's labels for a move.
async function labelIdsByNameForMove(db, cardId, targetBoardId) {
  var current = (await db.prepare(
    "SELECT labels.name AS name FROM card_labels " +
    "JOIN labels ON labels.id = card_labels.label_id " +
    "WHERE card_labels.card_id = ? ORDER BY labels.created_at, labels.rowid"
  ).bind(cardId).all()).results;
  var target = (await db.prepare(
    "SELECT id, name FROM labels WHERE board_id = ? ORDER BY created_at, rowid"
  ).bind(targetBoardId).all()).results;
  var byName = {};
  target.forEach(function (row) {
    if (!(row.name in byName)) byName[row.name] = row.id;
  });
  var ids = [];
  current.forEach(function (row) {
    var id = byName[row.name];
    if (id && ids.indexOf(id) === -1) ids.push(id);
  });
  return ids;
}

// The project a card takes on a move that names no project
// (issue #163): the destination board's project with the same
// name as the card's project, or none. Null when the card has
// no project or the destination has no match.
async function projectIdByNameForMove(db, projectId, targetBoardId) {
  if (!projectId) return null;
  var current = await db.prepare("SELECT name FROM projects WHERE id = ?")
    .bind(projectId).first();
  if (!current) return null;
  var match = await db.prepare(
    "SELECT id FROM projects WHERE board_id = ? AND name = ? ORDER BY created_at, rowid LIMIT 1"
  ).bind(targetBoardId, current.name).first();
  return match ? match.id : null;
}

// --- The change marker and live push ---
//
// One version number per owner, held in owners.state_version. Every
// accepted change raises it by exactly one (see the wrapper in the
// fetch handler below), and a refused change never touches it. The
// number means "the state as of the last accepted change": readers
// compare it with the version they hold to learn whether anything
// changed, and writers can name the version their change was based
// on so a change worked out against an old state is refused instead
// of landing on top of a newer one.
//
// Each rise also stamps who made that change, in
// owners.last_change_by and owners.last_change_at beside the
// counter: "owner" for a write that arrived through the person's
// sign-in, "agent" for one that arrived with a key. The stamp names
// only the latest change; it is not a history. A rise that is
// handed back (see releaseClaim) restores the stamp it replaced,
// so a refused or empty write leaves both exactly as they stood.

function currentVersion(owner) {
  var value = owner ? owner.state_version : null;
  var number = value == null ? 0 : Number(value);
  return isFinite(number) ? number : 0;
}

// The latest change's stamp in its read shape, or null when the
// owner carries no stamped change yet.
function lastChangeStamp(owner) {
  if (!owner) return null;
  var by = owner.last_change_by;
  if (by !== "owner" && by !== "agent") return null;
  if (!owner.last_change_at) return null;
  return { by: by, at: owner.last_change_at };
}

// Raises the owner's version by one, stamping the rise with who
// made the change and when, and returns the new number.
async function bumpVersion(db, ownerId, by, at) {
  await db.prepare(
    "UPDATE owners SET state_version = state_version + 1, last_change_by = ?, last_change_at = ? WHERE id = ?"
  ).bind(by, at, ownerId).run();
  var row = await db.prepare("SELECT state_version FROM owners WHERE id = ?")
    .bind(ownerId).first();
  return row ? currentVersion(row) : 0;
}

// Runs prepared statements as one database batch. A D1 batch is a
// transaction: every statement lands, or none of them does. The
// multi-step changes — a board copy above all, a new board with
// its columns, a card with its labels — gather their statements
// first and run them through here, so a failure partway can never
// leave half a change standing. The version rise itself stays in
// the request handler's wrapper, outside the batch: it is judged by
// comparing the state before and after, and a route that throws
// is answered as an error before any rise is considered, so a
// failed batch never raises the version either.
async function batchRun(db, statements) {
  if (!statements.length) return;
  await db.batch(statements);
}

// The one refusal every stale write gets, whichever door it came
// through: the state moved since the writer read it, so the write
// is refused whole and the writer reads the state again.
var STALE_WRITE_MESSAGE = "The boards changed since you read them. Read the state again, then send your change again.";

// Claims the next version for a write that named its base, in a
// single statement: the counter moves from the named version to
// the one after it, and only when it still stands at the named
// version. Two writers naming the same base cannot both claim —
// the database settles the claim at the moment of the write, so
// the check and the rise are one act with no gap between them.
// Returns the claimed version, or null when the claim was lost.
async function claimVersion(db, owner, baseVersion, by, at) {
  var result = await db.prepare(
    "UPDATE owners SET state_version = state_version + 1, last_change_by = ?, last_change_at = ? " +
    "WHERE id = ? AND state_version = ?"
  ).bind(by, at, owner.id, baseVersion).run();
  var changed = result && result.meta ? Number(result.meta.changes || 0) : 0;
  return changed === 1 ? baseVersion + 1 : null;
}

// Hands a claim back when the write it was taken for changed
// nothing or was refused. The counter returns to where it stood,
// and only when it still stands at the claimed value — a later
// claim by another write is never undone by this one. The stamp
// the claim wrote is handed back with it: the previous stamp (or
// no stamp, before the owner's first stamped change) is restored,
// so the pair never names a change that did not land.
async function releaseClaim(db, ownerId, claimedVersion, prevStamp) {
  var by = prevStamp ? prevStamp.by : null;
  var at = prevStamp ? prevStamp.at : null;
  await db.prepare(
    "UPDATE owners SET state_version = ?, last_change_by = ?, last_change_at = ? WHERE id = ? AND state_version = ?"
  ).bind(claimedVersion - 1, by, at, ownerId, claimedVersion).run();
}

// A digest of everything a state reader can see, with the
// version and its stamp left out. Two digests that read the same
// mean the state between them changed in no way a reader could
// see, so a write that produced the second one from the first
// changed nothing. The write gate compares digests around every
// write to learn whether the write changed anything — and it
// reads them from the stored rows directly, one concatenated
// string per table, instead of building the owner's whole state
// twice per write (issue #71: the double build charged every
// write two full readings of the boards, however small the
// write). Each table contributes its row count and a string of
// its reader-visible fields in row order; the fields mirror
// exactly what buildState puts in front of a reader, so a
// change no reader could see — a dormant column, an updated_at
// stamp — never moves the digest, and every change a reader
// could see does.
// The digest's hash: FNV-1a run twice over the text with
// 32-bit arithmetic — once forward from the offset basis, once
// backward from a different seed — and the two halves read
// together as the digest. Two states that collide on one pass
// do not collide on both. (A 64-bit BigInt pass measured eight
// times slower than this pair; the hash runs twice per write,
// so the difference is the write's whole cost.)
function fnv1a32(text, seed, backward) {
  var h = seed | 0;
  if (backward) {
    for (var i = text.length - 1; i >= 0; i--) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  } else {
    for (var j = 0; j < text.length; j++) {
      h ^= text.charCodeAt(j);
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function stateHash(text) {
  return fnv1a32(text, 0x811c9dc5, false) + fnv1a32(text, 0x1b873593, true);
}

async function stateDigest(db, owner, env) {
  var field = function (column) { return "COALESCE(CAST(" + column + " AS TEXT), '')"; };
  var row = function (columns) { return columns.map(field).join(" || char(31) || "); };
  var tables = [
    ["boards", "SELECT " + row(["id", "name", "icon", "position"]) +
      " AS t FROM boards WHERE owner_id = ? ORDER BY rowid"],
    ["columns", "SELECT " + row(["\"columns\".id", "\"columns\".board_id", "\"columns\".name", "\"columns\".icon", "\"columns\".position"]) +
      " AS t FROM \"columns\" JOIN boards ON boards.id = \"columns\".board_id WHERE boards.owner_id = ? ORDER BY \"columns\".rowid"],
    ["labels", "SELECT " + row(["labels.id", "labels.board_id", "labels.name", "labels.icon", "labels.colour"]) +
      " AS t FROM labels JOIN boards ON boards.id = labels.board_id WHERE boards.owner_id = ? ORDER BY labels.rowid"],
    ["projects", "SELECT " + row(["projects.id", "projects.board_id", "projects.name", "projects.icon"]) +
      " AS t FROM projects JOIN boards ON boards.id = projects.board_id WHERE boards.owner_id = ? ORDER BY projects.rowid"],
    ["cards", "SELECT " + row(["cards.id", "cards.board_id", "cards.column_id", "cards.project_id", "cards.title", "cards.notes", "cards.due_date", "cards.position", "cards.archived", "cards.important", "cards.creator_key_id", "cards.creator_key_name"]) +
      " AS t FROM cards JOIN boards ON boards.id = cards.board_id WHERE boards.owner_id = ? ORDER BY cards.rowid"],
    ["checklist_items", "SELECT " + row(["checklist_items.id", "checklist_items.card_id", "checklist_items.text", "checklist_items.done", "checklist_items.position"]) +
      " AS t FROM checklist_items JOIN cards ON cards.id = checklist_items.card_id JOIN boards ON boards.id = cards.board_id WHERE boards.owner_id = ? ORDER BY checklist_items.rowid"],
    ["card_links", "SELECT " + row(["card_links.id", "card_links.card_id", "card_links.url", "card_links.name", "card_links.position"]) +
      " AS t FROM card_links JOIN cards ON cards.id = card_links.card_id JOIN boards ON boards.id = cards.board_id WHERE boards.owner_id = ? ORDER BY card_links.rowid"],
    ["card_labels", "SELECT " + row(["card_labels.card_id", "card_labels.label_id"]) +
      " AS t FROM card_labels JOIN cards ON cards.id = card_labels.card_id JOIN boards ON boards.id = cards.board_id WHERE boards.owner_id = ? ORDER BY card_labels.rowid"],
    ["card_comments", "SELECT " + row(["card_comments.id", "card_comments.card_id", "card_comments.body", "card_comments.author_key_id", "card_comments.author_key_name", "card_comments.created_at"]) +
      " AS t FROM card_comments JOIN cards ON cards.id = card_comments.card_id JOIN boards ON boards.id = cards.board_id WHERE boards.owner_id = ? ORDER BY card_comments.rowid"]
  ];
  // The head of the state a reader sees: who the owner is, the
  // name they go by, their theme, the agents' host, and the
  // newest-key block the person's own state carries.
  var keyRow = await db.prepare(
    "SELECT last4, created_at FROM api_tokens WHERE owner_id = ? AND revoked_at IS NULL " +
    "ORDER BY created_at DESC LIMIT 1"
  ).bind(owner.id).first();
  var stream = [owner.id, effectiveName(owner), owner.email, owner.theme || "system",
    agentHost(env), keyRow ? (keyRow.last4 || "") + "@" + keyRow.created_at : "no-key"].join("\u001f");
  for (var i = 0; i < tables.length; i++) {
    var result = await db.prepare(
      "SELECT COUNT(*) AS n, COALESCE(group_concat(t, char(30)), '') AS body FROM (" + tables[i][1] + ")"
    ).bind(owner.id).first();
    stream += "\n" + tables[i][0] + ":" + result.n + ":" + (result.body ? result.body.length : 0) + ":";
    if (result.body) stream += result.body;
  }
  // A board's label colour mode rides the digest too, so a
  // mode-only change still raises the version. It is read off
  // the rows in JS rather than named in the SQL above: a data
  // file written before the column existed — a self-host file
  // the schema's CREATE TABLE IF NOT EXISTS leaves standing —
  // reads every board as chip here instead of failing the read.
  var modeRows = (await db.prepare(
    "SELECT * FROM boards WHERE owner_id = ? ORDER BY rowid"
  ).bind(owner.id).all()).results;
  stream += "\nboardModes:" + modeRows.map(function (r) { return boardLabelMode(r); }).join(",");
  // A card's next step rides the digest the same way, read off
  // the rows in JS (issue #119): the columns are newer than
  // some data files, and a step-only write — a hand-over that
  // changes nothing else on the card — must still count as a
  // change and raise the version. stepOf reads a row without
  // the columns as the owner's step, not waiting, so an old
  // file digests exactly as the state built from it reads.
  var stepRows = (await db.prepare(
    "SELECT cards.* FROM cards JOIN boards ON boards.id = cards.board_id " +
    "WHERE boards.owner_id = ? ORDER BY cards.rowid"
  ).bind(owner.id).all()).results;
  stream += "\ncardSteps:" + stepRows.map(function (r) {
    var s = stepOf(r);
    return [s.holder, s.keyId || "", s.keyName || "", s.handedAt || "",
      s.handedByKeyName || "", s.waiting ? "1" : "0"].join("\u001f");
  }).join("\u001e");
  // The owner's live keys ride the digest too: state carries
  // their ids and names, so a key made, renamed or revoked is
  // a change a reader can see, like the newest-key block in
  // the head above.
  var keyListRows = (await db.prepare(
    "SELECT id, label FROM api_tokens WHERE owner_id = ? AND revoked_at IS NULL ORDER BY created_at, rowid"
  ).bind(owner.id).all()).results;
  stream += "\nkeys:" + keyListRows.map(function (r) {
    return r.id + "=" + (r.label || "");
  }).join(",");
  return stateHash(stream);
}

// The fields each write route takes, by route shape. baseVersion
// is allowed on every write on top of these; it is the stale-write
// guard's field, handled by the gate in fetch. A route shape that
// is not listed here is not a write route at all, and the router
// answers it 404 without this check.
function writeFieldsFor(method, parts) {
  if (parts[0] !== "api") return null;
  var rest = parts.slice(1);
  // The sign-in routes (issue #109): each write carries exactly
  // its own fields.
  if (rest[0] === "auth") {
    if (rest.length === 3 && rest[1] === "proof" && rest[2] === "password") return ["password"];
    if (rest.length === 4 && rest[1] === "proof" && rest[3] === "verify") return ["response"];
    if (rest.length === 2 && rest[1] === "passkeys" && method === "POST") return ["response", "nickname"];
    if (rest.length === 2 && rest[1] === "password") return ["current_password", "new_password"];
    if (rest.length === 2 && rest[1] === "invites") return ["name"];
    if (rest.length === 2 && rest[1] === "admin") return ["account_key", "admin"];
    if (rest.length === 2 && rest[1] === "claim") return ["owner_id", "account_key"];
    return [];
  }
  if (rest[0] === "terms" && rest.length === 2 && rest[1] === "agree" && method === "POST") return ["agreed"];
  if (rest[0] === "me" && rest.length === 1 && method === "PATCH") return ["theme", "name"];
  if (rest[0] === "me" && rest.length === 2 && rest[1] === "token") {
    return method === "POST" ? ["name"] : [];
  }
  if (rest[0] === "me" && rest.length === 3 && rest[1] === "token") {
    return method === "PATCH" ? ["name"] : [];
  }
  if (rest[0] === "boards") {
    if (rest.length === 1 && method === "POST") return ["name", "icon"];
    if (rest.length === 3 && rest[2] === "copy" && method === "POST") {
      return ["name", "columns", "labels", "projects", "cards"];
    }
    if (rest.length === 2) return method === "PATCH" ? ["name", "position", "icon", "label_colour_mode"] : [];
  }
  if (rest[0] === "columns") {
    if (rest.length === 1 && method === "POST") return ["board_id", "name", "kind", "icon"];
    if (rest.length === 2) {
      if (method === "PATCH") return ["name", "position", "icon"];
      // A column delete names the column that receives its cards.
      if (method === "DELETE") return ["move_to_column_id"];
      return [];
    }
  }
  if (rest[0] === "labels") {
    if (rest.length === 1 && method === "POST") return ["board_id", "name", "colour", "icon"];
    if (rest.length === 2) return method === "PATCH" ? ["name", "colour", "icon"] : [];
  }
  if (rest[0] === "projects") {
    if (rest.length === 1 && method === "POST") return ["board_id", "name", "icon"];
    if (rest.length === 2) return method === "PATCH" ? ["name", "icon"] : [];
  }
  if (rest[0] === "cards") {
    if (rest.length === 1 && method === "POST") {
      return ["board_id", "column_id", "title", "notes", "labels", "project_id", "due_date", "important", "next_step"];
    }
    if (rest.length === 2) {
      // A card PATCH may also carry a comment: it posts as part
      // of the same write, so a hand-over and the comment that
      // explains it land together, under one version rise
      // (issue #119).
      return method === "PATCH"
        ? ["board_id", "column_id", "position", "title", "notes", "labels", "project_id", "due_date", "important", "archived", "next_step", "comment"]
        : [];
    }
    if (rest.length === 3 && rest[2] === "steps" && method === "POST") return ["text", "done"];
    if (rest.length === 3 && rest[2] === "links" && method === "POST") return ["url", "name"];
    if (rest.length === 3 && rest[2] === "comments" && method === "POST") return ["body"];
    if (rest.length === 4 && rest[2] === "steps") return method === "PATCH" ? ["text", "done", "position"] : [];
    if (rest.length === 4 && rest[2] === "links") return method === "PATCH" ? ["url", "name"] : [];
    if (rest.length === 4 && rest[2] === "comments") return [];
  }
  return null;
}

// A due date counts only when it is a real calendar date written
// as YYYY-MM-DD: the shape alone is not enough, so a date like
// 2026-02-30 is refused along with words and other shapes.
function isRealDateString(value) {
  if (typeof value !== "string") return false;
  var found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!found) return false;
  var year = Number(found[1]);
  var month = Number(found[2]);
  var day = Number(found[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  var leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  var daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

// --- Output shapes. The front end works in these shapes. ---

function columnOut(row) {
  return { id: row.id, kind: columnKind(row), name: row.name, icon: columnIcon(row), position: row.position };
}

function stepOut(row) {
  return { id: row.id, text: row.text || "", done: !!row.done };
}

function linkOut(row) {
  return { id: row.id, url: row.url || "", name: row.name || "" };
}

// A card's checklist steps in their order: position first, oldest
// first where positions tie.
async function stepsForCard(db, cardId) {
  var rows = (await db.prepare(
    "SELECT * FROM checklist_items WHERE card_id = ? ORDER BY position, created_at"
  ).bind(cardId).all()).results;
  return rows.map(stepOut);
}

// A card's links in their order: position first, oldest first
// where positions tie.
async function linksForCard(db, cardId) {
  var rows = (await db.prepare(
    "SELECT * FROM card_links WHERE card_id = ? ORDER BY position, created_at"
  ).bind(cardId).all()).results;
  return rows.map(linkOut);
}

// Every key an owner holds, standing or revoked, as an
// id-to-name map: the live source a comment's author name is
// resolved from (issue #120). Revoked keys stand in the map —
// deleting a key in the app revokes it and its row stands, so
// its comments keep resolving to its name.
async function keyNameMap(db, ownerId) {
  var rows = (await db.prepare(
    "SELECT id, label FROM api_tokens WHERE owner_id = ?"
  ).bind(ownerId).all()).results;
  var map = {};
  rows.forEach(function (row) { map[row.id] = row.label || "Agent"; });
  return map;
}

// The name-to-id side of the same book: a name maps to an id
// only when exactly one of the owner's keys carries it. A name
// two keys share maps to nothing — a stored name in that shape
// cannot be told apart, and is never guessed at (issue #121).
function keyIdsByName(keyNames) {
  var byName = {};
  var shared = {};
  Object.keys(keyNames || {}).forEach(function (id) {
    var name = keyNames[id];
    if (byName[name]) shared[name] = true;
    else byName[name] = id;
  });
  Object.keys(shared).forEach(function (name) { delete byName[name]; });
  return byName;
}

// The name a stored key reference reads with (issue #121 —
// Derick's rule: a name changed in the UI is reflected
// everywhere). A reference is an id and, on rows written while
// names were kept beside ids, the name text of that moment.
// The id resolves first, live from the key's row — standing or
// revoked, the row stands — so a rename renames it and a
// revoke changes nothing. A reference carrying only text
// resolves to the one key that carries that name, when exactly
// one does; otherwise the text stands as the fallback name.
function resolvedKeyName(keyId, storedName, keyNames, idsByName) {
  if (keyId) return (keyNames && keyNames[keyId]) || storedName || null;
  if (storedName && idsByName && idsByName[storedName]) {
    return (keyNames && keyNames[idsByName[storedName]]) || storedName;
  }
  return storedName || null;
}

// The id a name-only reference binds to, under the same
// unique-match rule: the one key carrying the name, or null
// when there is nothing to bind — no key carries it, or more
// than one does (issue #121).
function matchedKeyId(storedName, idsByName) {
  return storedName && idsByName ? (idsByName[storedName] || null) : null;
}

// A comment in its read shape. A comment records its author as
// an identity — the writing key's id, or the person's own id —
// and the names here are resolved from those records as the
// comment is read, never stored on the comment (issue #120):
// authorKeyName is the writing key's current name, or null
// when the person wrote it, and authorName names the author
// either way — the key's current name, or the person's current
// name (personName, the name the board's owner goes by now).
// So a rename, of the key or of the person, renames the author
// on every standing comment at once. A comment whose key row
// is somehow gone falls back to the name text old rows carry.
// A person comment written before identities were recorded
// carries no id either; because one on a board could only ever
// have been the owner's, it resolves as the owner's, the same
// live name.
function commentOut(row, personName, keyNames) {
  var keyName = row.author_key_id
    ? (keyNames && keyNames[row.author_key_id]) || row.author_key_name || null
    : null;
  return {
    id: row.id,
    body: row.body || "",
    createdAt: row.created_at,
    authorKeyName: keyName,
    authorName: keyName || personName || null
  };
}

// A card's comments in the order they were written: the time
// each was written first, and the row order where two share a
// stamp, so a later comment never reads before an earlier one.
async function commentsForCard(db, cardId, personName, keyNames) {
  var rows = (await db.prepare(
    "SELECT * FROM card_comments WHERE card_id = ? ORDER BY created_at, rowid"
  ).bind(cardId).all()).results;
  return rows.map(function (row) { return commentOut(row, personName, keyNames); });
}

// A card's next step, as it stands in the row (issue #119):
// whose turn the card's next step is. holder is "owner" (the
// person), "agent" (one of the owner's keys) or "none". When
// the holder is an agent, keyId names the key; keyName and
// handedByKeyName here are the name text the row carries —
// the legacy fallback, never the source the read shape serves
// (stepReadOf below resolves every name live, issue #121).
// handedAt records when the last hand-over happened. waiting
// stands from a hand-over until the holder's first write to
// the card. The read is defensive the way boardLabelMode's is:
// a row from a data file written before these columns existed
// reads as the owner's step, not waiting — the migration the
// schema's defaults also declare.
function stepOf(row) {
  var holder = row && (row.step_holder === "agent" || row.step_holder === "none")
    ? row.step_holder : "owner";
  return {
    holder: holder,
    keyId: holder === "agent" ? (row.step_key_id || null) : null,
    keyName: holder === "agent" ? (row.step_key_name || null) : null,
    handedAt: (row && row.step_handed_at) || null,
    handedByKeyName: (row && row.step_handed_by_key_name) || null,
    waiting: !!(row && row.step_waiting)
  };
}

// A card's next step in its read shape: stepOf's standing
// fields with every name resolved live (issue #121). keyName
// is the holding key's name as it stands now. handedByKeyName
// names the key that handed the step over the same way, or
// null when the person did; handedByName names the hander
// either way — the key's current name, or the person's
// current name (personName, the name the board's owner goes
// by now) — or null when the step has never been handed over.
// The name text a row may carry is read only as the fallback
// where an id cannot be resolved (resolvedKeyName above).
function stepReadOf(row, personName, keyNames, idsByName) {
  var s = stepOf(row);
  var handedByKeyName = null;
  var handedByName = null;
  if (s.handedAt) {
    var byId = row ? row.step_handed_by_key_id : null;
    var byText = row ? row.step_handed_by_key_name : null;
    if (byId || byText) {
      handedByKeyName = resolvedKeyName(byId, byText, keyNames, idsByName);
      handedByName = handedByKeyName;
    } else {
      handedByName = personName || null;
    }
  }
  return {
    holder: s.holder,
    keyId: s.keyId,
    keyName: s.holder === "agent"
      ? resolvedKeyName(row ? row.step_key_id : null, row ? row.step_key_name : null, keyNames, idsByName)
      : null,
    handedAt: s.handedAt,
    handedByKeyName: handedByKeyName,
    handedByName: handedByName,
    waiting: s.waiting
  };
}

// The step a write names, judged: the next_step field takes
// "owner", "none" or null (both spellings of no one beyond the
// owner read as their plain meaning — "owner" is the person,
// "none" and null are no holder), or the id of one of the
// owner's live keys. Anything else is refused by the caller
// with this function's undefined. The answer is the target as
// { holder, keyId, keyName }, the key's name read fresh from
// its row: the name describes the target for the caller's
// answer, but a card stores the id alone — the name it reads
// with resolves from the key's record (issue #121).
async function stepTargetFor(db, ownerId, value) {
  if (value === "owner") return { holder: "owner", keyId: null, keyName: null };
  if (value === "none" || value === null) return { holder: "none", keyId: null, keyName: null };
  if (typeof value !== "string" || !value) return undefined;
  var keyRow = await db.prepare(
    "SELECT id, label FROM api_tokens WHERE id = ? AND owner_id = ? AND revoked_at IS NULL"
  ).bind(value, ownerId).first();
  if (!keyRow) return undefined;
  return { holder: "agent", keyId: keyRow.id, keyName: keyRow.label || "" };
}

// Whether two step targets name the same holder: the owner,
// no one, or the same key by id.
function sameStepTarget(a, b) {
  if (!a || !b || a.holder !== b.holder) return false;
  return a.holder !== "agent" || a.keyId === b.keyId;
}

// The step columns a hand-over writes, from the step as it
// stands, the target it moves to and the caller moving it. A
// hand-over stamps when it happened and who made it — the
// calling key's id, or nothing when the person made it — and
// the card waits for its pickup unless the target is the
// caller themselves (they hold it and are acting on it in
// this very write) or no one (there is nobody to pick it up).
// The name columns are written empty: a card records the
// key's id, never its name, and every name the step reads
// with resolves from the key's record (issue #121).
function handoverColumns(current, target, callerKey, stamp) {
  return {
    step_holder: target.holder,
    step_key_id: target.keyId,
    step_key_name: null,
    step_handed_at: stamp,
    step_handed_by_key_id: callerKey ? callerKey.id : null,
    step_handed_by_key_name: null,
    step_waiting: target.holder === "none" ? 0
      : (callerKey
        ? (target.holder === "agent" && target.keyId === callerKey.id ? 0 : 1)
        : (target.holder === "owner" ? 0 : 1))
  };
}

// The step columns as they stand on a row, in write form, for
// a write that keeps the holder: the current values carried
// through, with the pickup applied — a write by the holder to
// a waiting card is the pickup, and waiting clears. A write
// by anyone else leaves waiting exactly as it stood. The name
// text a row carries rides through untouched: where the row
// also carries an id it is never read as a source (issue
// #121), and on a name-only row it is the fallback the read
// resolves from, so it is kept standing.
function stepColumnsKept(row, callerKey) {
  var step = stepOf(row);
  var isHolder = callerKey
    ? (step.holder === "agent" && step.keyId === callerKey.id)
    : step.holder === "owner";
  return {
    step_holder: row.step_holder === "agent" || row.step_holder === "none" ? row.step_holder : "owner",
    step_key_id: row.step_key_id || null,
    step_key_name: row.step_key_name || null,
    step_handed_at: row.step_handed_at || null,
    step_handed_by_key_id: row.step_handed_by_key_id || null,
    step_handed_by_key_name: row.step_handed_by_key_name || null,
    step_waiting: step.waiting && isHolder ? 0 : (step.waiting ? 1 : 0)
  };
}

// The pickup on its own, for the routes that write a card's
// parts (its steps, links and comments) rather than the card
// itself: when the writer is the card's holder and the card
// waits, waiting clears. Called after the part's own write.
async function noteCardPickup(db, cardRow, callerKey) {
  var step = stepOf(cardRow);
  if (!step.waiting) return;
  var isHolder = callerKey
    ? (step.holder === "agent" && step.keyId === callerKey.id)
    : step.holder === "owner";
  if (!isHolder) return;
  await db.prepare("UPDATE cards SET step_waiting = 0 WHERE id = ?")
    .bind(cardRow.id).run();
}

// A card in its read shape. The names it wears — its maker's
// and its step's — are resolved live from the records they
// name (issue #121): the card stores the creating key's id
// and the step's ids, never a name as a source, and the name
// text old rows carry is read only as the fallback where an
// id cannot be resolved (resolvedKeyName, stepReadOf). The
// maker's id rides beside its name as creatorKeyId (issue
// #123): the row already carries it, and readers match the
// maker against a step's keyId by id, never by name. On a
// state read the name-to-id binding above has already run,
// so the id served is the bound one where a binding was
// possible; a name no key carries binds nothing and the id
// reads null while the name falls back to its stored text.
function cardOut(row, kindByColumnId, steps, links, labels, comments, personName, keyNames, idsByName) {
  return {
    id: row.id,
    boardId: row.board_id,
    columnId: kindByColumnId[row.column_id] || "inbox",
    title: row.title,
    notes: row.notes || "",
    labels: labels || [],
    due: row.due_date || "",
    projectId: row.project_id || null,
    archived: !!row.archived,
    important: !!row.important,
    position: row.position,
    steps: steps || [],
    links: links || [],
    comments: comments || [],
    creatorKeyId: row.creator_key_id || null,
    creatorKeyName: resolvedKeyName(row.creator_key_id, row.creator_key_name, keyNames, idsByName),
    step: stepReadOf(row, personName, keyNames, idsByName)
  };
}

async function keyInfo(db, ownerId) {
  var row = await db.prepare(
    "SELECT last4, created_at FROM api_tokens WHERE owner_id = ? AND revoked_at IS NULL " +
    "ORDER BY created_at DESC LIMIT 1"
  ).bind(ownerId).first();
  if (!row) return { has_key: false };
  return { has_key: true, last4: row.last4 || "", created_at: row.created_at };
}

// The caller's whole state in the shape the front end renders.
// What rides at the head of the answer depends on the door the
// caller came through (issues #64 and #65): the person's own
// browser gets their email, the newest-key block and the change
// stamp, because its settings pages and its change marker read
// them; a key gets the boards and the owner's name — the work —
// and none of those three, so a state answer in an agent
// platform's logs holds no email, and no key learns when the
// person is at their boards from the stamp.
async function buildState(db, owner, env, via) {
  var forAgent = via === "agent-token";
  var boardRows = (await db.prepare(
    "SELECT * FROM boards WHERE owner_id = ? ORDER BY position, created_at"
  ).bind(owner.id).all()).results;

  var boards = [];
  var kindByColumnId = {};
  for (var b = 0; b < boardRows.length; b++) {
    var columnRows = (await db.prepare(
      'SELECT * FROM "columns" WHERE board_id = ? ORDER BY position, created_at'
    ).bind(boardRows[b].id).all()).results;
    var columns = columnRows.map(function (row) {
      var out = columnOut(row);
      kindByColumnId[row.id] = out.kind;
      return out;
    });
    boards.push({
      id: boardRows[b].id,
      name: boardRows[b].name,
      icon: boardIcon(boardRows[b]),
      position: boardRows[b].position,
      labelColourMode: boardLabelMode(boardRows[b]),
      columns: columns
    });
  }

  var labelRows = (await db.prepare(
    "SELECT labels.* FROM labels JOIN boards ON boards.id = labels.board_id " +
    "WHERE boards.owner_id = ? ORDER BY labels.created_at, labels.rowid"
  ).bind(owner.id).all()).results;
  var projectRows = (await db.prepare(
    "SELECT projects.* FROM projects JOIN boards ON boards.id = projects.board_id " +
    "WHERE boards.owner_id = ? ORDER BY projects.created_at"
  ).bind(owner.id).all()).results;
  var cardRows = (await db.prepare(
    "SELECT cards.* FROM cards JOIN boards ON boards.id = cards.board_id " +
    "WHERE boards.owner_id = ? ORDER BY cards.position, cards.created_at"
  ).bind(owner.id).all()).results;
  var stepRows = (await db.prepare(
    "SELECT checklist_items.* FROM checklist_items " +
    "JOIN cards ON cards.id = checklist_items.card_id " +
    "JOIN boards ON boards.id = cards.board_id " +
    "WHERE boards.owner_id = ? ORDER BY checklist_items.position, checklist_items.created_at"
  ).bind(owner.id).all()).results;
  var stepsByCardId = {};
  stepRows.forEach(function (row) {
    if (!stepsByCardId[row.card_id]) stepsByCardId[row.card_id] = [];
    stepsByCardId[row.card_id].push(stepOut(row));
  });
  var linkRows = (await db.prepare(
    "SELECT card_links.* FROM card_links " +
    "JOIN cards ON cards.id = card_links.card_id " +
    "JOIN boards ON boards.id = cards.board_id " +
    "WHERE boards.owner_id = ? ORDER BY card_links.position, card_links.created_at"
  ).bind(owner.id).all()).results;
  var linksByCardId = {};
  linkRows.forEach(function (row) {
    if (!linksByCardId[row.card_id]) linksByCardId[row.card_id] = [];
    linksByCardId[row.card_id].push(linkOut(row));
  });
  // One row per card-and-label pairing, in the board's label order,
  // so each card's list reads the way its chips are painted.
  var cardLabelRows = (await db.prepare(
    "SELECT card_labels.card_id AS card_id, card_labels.label_id AS label_id FROM card_labels " +
    "JOIN cards ON cards.id = card_labels.card_id " +
    "JOIN boards ON boards.id = cards.board_id " +
    "JOIN labels ON labels.id = card_labels.label_id " +
    "WHERE boards.owner_id = ? ORDER BY labels.created_at, labels.rowid"
  ).bind(owner.id).all()).results;
  var labelsByCardId = {};
  cardLabelRows.forEach(function (row) {
    if (!labelsByCardId[row.card_id]) labelsByCardId[row.card_id] = [];
    labelsByCardId[row.card_id].push(row.label_id);
  });
  var commentRows = (await db.prepare(
    "SELECT card_comments.* FROM card_comments " +
    "JOIN cards ON cards.id = card_comments.card_id " +
    "JOIN boards ON boards.id = cards.board_id " +
    "WHERE boards.owner_id = ? ORDER BY card_comments.created_at, card_comments.rowid"
  ).bind(owner.id).all()).results;
  var keyNamesForComments = await keyNameMap(db, owner.id);
  var commentsByCardId = {};
  commentRows.forEach(function (row) {
    if (!commentsByCardId[row.card_id]) commentsByCardId[row.card_id] = [];
    commentsByCardId[row.card_id].push(commentOut(row, effectiveName(owner), keyNamesForComments));
  });

  var keyIdsForNames = keyIdsByName(keyNamesForComments);
  // The name-to-id binding (issue #121): a card row carrying
  // a maker's, a holder's or a hander's name as text but no id
  // — written while the name was kept beside the id — takes
  // the id of the one key that carries that name, when exactly
  // one of the owner's keys does, and the binding is kept in
  // the row, so the name resolves live from then on and a
  // later rename reaches the card too. A name no key carries,
  // or more than one carries, binds nothing: the text stands
  // as that card's fallback name and the row is left as it
  // stands. This runs on a read and writes only the rows it
  // binds; a row already carrying its ids is never touched.
  for (var bfi = 0; bfi < cardRows.length; bfi++) {
    var bfRow = cardRows[bfi];
    var bfSets = [];
    var bfBinds = [];
    var bfCreator = !bfRow.creator_key_id
      ? matchedKeyId(bfRow.creator_key_name, keyIdsForNames) : null;
    if (bfCreator) { bfSets.push("creator_key_id = ?"); bfBinds.push(bfCreator); }
    var bfHolder = bfRow.step_holder === "agent" && !bfRow.step_key_id
      ? matchedKeyId(bfRow.step_key_name, keyIdsForNames) : null;
    if (bfHolder) { bfSets.push("step_key_id = ?"); bfBinds.push(bfHolder); }
    var bfHander = !bfRow.step_handed_by_key_id
      ? matchedKeyId(bfRow.step_handed_by_key_name, keyIdsForNames) : null;
    if (bfHander) { bfSets.push("step_handed_by_key_id = ?"); bfBinds.push(bfHander); }
    if (!bfSets.length) continue;
    bfBinds.push(bfRow.id);
    await db.prepare("UPDATE cards SET " + bfSets.join(", ") + " WHERE id = ?")
      .bind(...bfBinds).run();
    if (bfCreator) bfRow.creator_key_id = bfCreator;
    if (bfHolder) bfRow.step_key_id = bfHolder;
    if (bfHander) bfRow.step_handed_by_key_id = bfHander;
  }

  var state = {
    me: forAgent
      ? { id: owner.id, name: effectiveName(owner) }
      : { id: owner.id, name: effectiveName(owner), email: owner.email },
    agentHost: agentHost(env),
    version: currentVersion(owner),
    theme: THEME_MODES.indexOf(owner.theme) !== -1 ? owner.theme : "system",
    boards: boards,
    labels: labelRows.map(function (row) {
      return { id: row.id, boardId: row.board_id, name: row.name, icon: row.icon || "", colour: row.colour };
    }),
    projects: projectRows.map(function (row) {
      return { id: row.id, boardId: row.board_id, name: row.name, icon: row.icon || "" };
    }),
    cards: cardRows.map(function (row) { return cardOut(row, kindByColumnId, stepsByCardId[row.id] || [], linksByCardId[row.id] || [], labelsByCardId[row.id] || [], commentsByCardId[row.id] || [], effectiveName(owner), keyNamesForComments, keyIdsForNames); }),
    // The owner's live keys, by id and current name (issue
    // #119): the app's Next step chooser and filter name them,
    // and an agent reads them to hand a card to another key.
    // Ids and names only — the stamps on the work already carry
    // these names, and no key material ever rides here.
    keys: ((await db.prepare(
      "SELECT id, label FROM api_tokens WHERE owner_id = ? AND revoked_at IS NULL ORDER BY created_at, rowid"
    ).bind(owner.id).all()).results).map(function (row) {
      return { id: row.id, name: row.label || "" };
    })
  };
  if (!forAgent) {
    state.lastChange = lastChangeStamp(owner);
    state.key = await keyInfo(db, owner.id);
  }
  return state;
}

async function boardOut(db, boardRow) {
  var columnRows = (await db.prepare(
    'SELECT * FROM "columns" WHERE board_id = ? ORDER BY position, created_at'
  ).bind(boardRow.id).all()).results;
  return {
    id: boardRow.id,
    name: boardRow.name,
    icon: boardIcon(boardRow),
    position: boardRow.position,
    labelColourMode: boardLabelMode(boardRow),
    columns: columnRows.map(columnOut)
  };
}

async function readBody(request) {
  try {
    return await request.json();
  } catch (e) {
    return null;
  }
}

function match(parts, pattern) {
  if (parts.length !== pattern.length) return null;
  var params = {};
  for (var i = 0; i < pattern.length; i++) {
    if (pattern[i].charAt(0) === ":") {
      try {
        params[pattern[i].slice(1)] = decodeURIComponent(parts[i]);
      } catch (e) {
        // An undecodable segment names nothing: the address is
        // simply not found, never a crashed route.
        return null;
      }
    } else if (pattern[i] !== parts[i]) {
      return null;
    }
  }
  return params;
}

// --- The request handler ------------------------------------------------
//
// Builds the API's request handler from a deployment's adapters:
//
// - db: the database, in the D1 shape — prepare returns a
//   statement with bind, and a statement runs with run, first,
//   all or as part of batch.
// - authDb: the sign-in store, in the same shape. On a home
//   copy it is the same handle as db; on the hosted copy it is
//   the deployment's second D1 database when one is bound, so
//   the door's defence writes never spend the boards' quota.
//   Defaults to db.
// - env: the deployment's settings, read exactly as the routes
//   have always read them (the allowlist, the two doors' hosts,
//   the directions' scheme).
// - auth: the sign-in config the wrappers hand in:
//   accessIdentity(request) — the transition door's adapter,
//   answering { email, name } for a request whose Access token
//   verifies, or null (the self-host server passes none: its
//   transition is over); sourceOf(request) — the source address
//   the throttle keys on; sourceCapMs — this home's per-source
//   lockout ceiling; publicBase — the address invite links are
//   built from, with no trailing slash.
// - pushNotify(ownerId, version): tells the deployment's push
//   holder that a change landed. Best effort; it may do nothing.
// - acceptPush(request, owner): takes over a live-updates socket
//   for the owner and answers its response, or answers null when
//   this deployment cannot hold sockets — the route then answers
//   501, as an unconfigured deployment always has.
// - sessionCookieName: the name of the transition door's session
//   cookie, or null. Named so a refused sign-in can expire a
//   stale cookie on its 401 (see resolveCaller).
// - onOwnerDeleted(owner): optional. Runs after a person is
//   erased (DELETE /me, or an administrator's removal), for a
//   deployment that keeps state of its own about a person
//   outside the shared tables — the self-host server's live
//   sockets. For DELETE /me it answers the Set-Cookie value
//   that ends the person's session on that deployment, or
//   nothing.
// - passwordsAllowed: optional. A deployment whose sign-in
//   takes no passwords (a hosted service whose whole door is
//   the emailed link and passkeys) passes false: the account
//   read then says so, the app offers no password setting, and
//   the password route refuses. A copy that names no value
//   takes passwords as it always has — the self-host copy's
//   name-and-password door stands untouched.
//
// The handler takes and returns web-standard Request and Response
// objects and nothing else, which is what lets the same core
// serve from a Worker and from a plain Node server.
export function createApiHandler(deps) {
  return async function handleApiRequest(request) {
    var env = deps.env;
    var takePasswords = deps.passwordsAllowed !== false;

  var url = new URL(request.url);
  var host = url.hostname;
  var parts = url.pathname.split("/").filter(function (s) { return s.length > 0; });
  var method = request.method;

  // The Set Up Agent instructions name the API's address as
  // /api/v1, so that spelling is part of both doors: /api/v1/state
  // and /api/state are the same route. Dropping the version
  // segment here keeps every route below defined exactly once,
  // and the unversioned spelling keeps working for the callers
  // already using it.
  if (parts[0] === "api" && parts[1] === "v1") parts.splice(1, 1);

  if (parts.length === 0 || parts[0] !== "api") {
    return error("Use the /api routes. The Pages site serves the front end.", 404);
  }
  if (!deps.db) {
    return error("The database is not configured.", 501);
  }

  var callerResult = await resolveCaller(request, deps, host);
  if (callerResult.error) return callerResult.error;
  var owner = callerResult.owner;
  var callerVia = callerResult.via;
  // The key the caller arrived with, when they arrived with one:
  // { id, name }, or null for a signed-in person. Cards and
  // comments written on this call are stamped with it.
  var callerKey = callerResult.key || null;
  // The account and session the caller arrived with, when they
  // arrived through the account door: the sign-in routes work
  // on these, and an account with no owner linked yet reaches
  // those routes and nothing else.
  var callerAccount = callerResult.account || null;
  var callerSession = callerResult.session || null;
  var db = deps.db;
  var authDb = deps.authDb || deps.db;

  // The version answer is the one board-free read an unlinked
  // account also gets: the app asks for it before anything
  // else, and it carries nothing but the version and the
  // build stamp.
  var isVersionRead = method === "GET" &&
    ((parts.length === 2 && parts[1] === "version") ||
     (parts.length === 3 && parts[1] === "v1" && parts[2] === "version"));
  if (callerAccount && !owner && parts[1] !== "auth" && !isVersionRead &&
      !(method === "DELETE" && parts.length === 2 && parts[1] === "me")) {
    return error("This account is not linked to any boards yet.", 403);
  }

  var isWrite = method === "POST" || method === "PATCH" ||
    method === "PUT" || method === "DELETE";

  // The browser door's own half of the defence against a hostile
  // page writing in a signed-in person's name. A person's sign-in
  // cookie can ride along on a cross-site request, so a write
  // that arrives through the Access door must look like the
  // app's own: an Origin, when the browser sends one, naming
  // this very host, and a body, when there is one, declared as
  // JSON. The app always sends both that way. A "simple"
  // cross-site request can do neither — it cannot set a JSON
  // content type without a preflight the app never grants, and
  // its Origin names the hostile host — so it is refused here
  // whatever any cookie does. Agent keys are not cookies and
  // need no such check: a hostile page cannot make a browser
  // send a key it does not hold.
  if (isWrite && (callerVia === "access" || callerVia === "account")) {
    var origin = request.headers.get("Origin");
    if (origin) {
      var originHost = null;
      try { originHost = new URL(origin).hostname; } catch (e) { originHost = null; }
      if (originHost !== host) {
        return error("This write did not come from TaskSparkle itself.", 403);
      }
    }
    var declaredType = String(request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    var hasBody = Number(request.headers.get("Content-Length") || 0) > 0 ||
      request.headers.get("Transfer-Encoding") != null;
    if (hasBody && declaredType !== "application/json") {
      return error("Writes from the app must be sent as JSON.", 400);
    }
  }

  // Erasing the person (issue #57): DELETE /me deletes the
  // caller themselves — the owners row, and everything the
  // schema cascades from it. It stands apart from the write
  // pipeline below on purpose: that pipeline's bookkeeping (the
  // version claim, the before-and-after digest) is all about
  // the owner's own state, and this act removes the owner, so
  // there is no state left to stamp and no other owner's
  // version is touched. The gate's discipline is applied by
  // hand instead: the body may carry nothing but baseVersion,
  // any other field is refused by name, and a baseVersion that
  // does not name the version as it stands is refused as
  // stale. The app sends no body at all; the checks guard the
  // route's shape for every caller.
  //
  // A key can never call this route: a key holds its owner's
  // full powers over the boards, but erasing the owner is the
  // person's own act, and a leaked key must not be able to
  // destroy the account it serves.
  if (method === "DELETE" && parts.length === 2 && parts[1] === "me") {
    if (callerVia === "agent-token") {
      return error("A key cannot delete its owner. Deleting an account is the person's own act, in the app under Settings, then Account.", 403);
    }
    var eraseBody = null;
    var eraseRaw = "";
    try { eraseRaw = await request.clone().text(); } catch (e) { eraseRaw = ""; }
    if (eraseRaw && eraseRaw.trim()) {
      try { eraseBody = JSON.parse(eraseRaw); } catch (e) {
        return error("The request body was not JSON.", 400);
      }
      if (!eraseBody || typeof eraseBody !== "object" || Array.isArray(eraseBody)) eraseBody = null;
    }
    if (eraseBody) {
      var eraseKeys = Object.keys(eraseBody);
      for (var ei = 0; ei < eraseKeys.length; ei++) {
        if (eraseKeys[ei] !== "baseVersion") {
          return error("\"" + eraseKeys[ei] + "\" is not part of this call.", 400);
        }
      }
      if (eraseBody.baseVersion != null &&
          (typeof eraseBody.baseVersion !== "number" || !isFinite(eraseBody.baseVersion) ||
           eraseBody.baseVersion !== currentVersion(owner))) {
        return error(STALE_WRITE_MESSAGE, 409);
      }
    }
    // The only administrator may not erase themselves while
    // other accounts stand (the standing guard, now in the
    // shared code so both homes keep it): the copy would be
    // left with no one who can invite or remove anyone. The
    // refusal names the way out.
    if (callerAccount && (await onlyAdminBlocked(authDb, callerAccount))) {
      return error(ONLY_ADMIN_MESSAGE, 403);
    }
    // The audit row is written before anything goes: it names
    // the account by its opaque id, which is all that survives
    // the erasure, by design.
    if (callerAccount) {
      await writeAudit(authDb, callerAccount, "account-erased", callerAccount, "self-erasure");
    }
    // One act: the delete and its whole cascade — boards,
    // columns, labels, projects, cards, steps, links, comments,
    // card labels and every key the person holds — land
    // together, or not at all. The account's own credentials go
    // in the same act: its password, passkeys, sessions and
    // invites (worker/auth.js), so no door the person held
    // survives them.
    if (owner) {
      await batchRun(db, [db.prepare("DELETE FROM owners WHERE id = ?").bind(owner.id)]);
    }
    if (callerAccount) {
      await eraseAccountCredentials(authDb, callerAccount.key);
    }
    var erased = json({ ok: true });
    // The session ends with the account. For the account door
    // the answer expires the ts_session cookie; for the
    // transition door it expires that door's cookie in the
    // shape issue #49 set. Either way the browser that just
    // deleted its owner holds no session for a person who no
    // longer exists.
    if (callerVia === "account") {
      erased.headers.set("Set-Cookie",
        expiredSessionCookieValue(url.protocol === "https:"));
    } else if (deps.sessionCookieName && presentedCookie(request, deps.sessionCookieName)) {
      erased.headers.set("Set-Cookie",
        deps.sessionCookieName + "=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
    }
    // The deployment's own wrap-up, when it keeps state of its
    // own about the person (see createApiHandler): the self-host
    // server erases its password and invite rows and drops the
    // person's live sockets, and answers the cookie value that
    // ends the local session — set here when the door's own
    // expiry above did not already set one.
    if (typeof deps.onOwnerDeleted === "function") {
      var wrapCookie = await deps.onOwnerDeleted(owner);
      if (wrapCookie && !erased.headers.get("Set-Cookie")) {
        erased.headers.set("Set-Cookie", wrapCookie);
      }
    }
    return erased;
  }

  // Every write passes one gate before its route runs, and the
  // gate is the same on both doors. A body that carries anything
  // and is not JSON is refused as not JSON. A field the route
  // does not take is refused by name, so a misspelled field can
  // never pass silently while the write answers success. The
  // body is read from a clone: the route below reads the original
  // request's body for itself.
  //
  // The stale-write guard lives here too. A write may name the
  // version it was based on, as baseVersion in its body. A
  // baseVersion that is not a number is refused with the stale
  // words, the same as one that names a version left behind. A
  // numbered baseVersion is claimed at once (see claimVersion):
  // the claim is the version rise, taken before the route runs,
  // so two writers who read the same state cannot both land —
  // the second claim finds the counter already moved and is
  // refused whole, having applied nothing. A write without a
  // baseVersion behaves as it always has.
  var writeBody = null;
  var claimedVersion = null;
  var claimedPrevStamp = null;
  // Who an accepted write will be stamped as, from the door it
  // arrived by: a signed-in person is the owner, a key is an
  // agent. resolveCaller has already settled which it is.
  var stampBy = callerVia === "agent-token" ? "agent" : "owner";
  if (isWrite) {
    var rawBody = "";
    try { rawBody = await request.clone().text(); } catch (e) { rawBody = ""; }
    if (rawBody && rawBody.trim()) {
      try { writeBody = JSON.parse(rawBody); } catch (e) {
        return error("The request body was not JSON.", 400);
      }
      if (!writeBody || typeof writeBody !== "object" || Array.isArray(writeBody)) {
        writeBody = null;
      }
    }
    if (writeBody) {
      var allowedFields = writeFieldsFor(method, parts);
      if (allowedFields) {
        var bodyKeys = Object.keys(writeBody);
        for (var ki = 0; ki < bodyKeys.length; ki++) {
          if (bodyKeys[ki] !== "baseVersion" && allowedFields.indexOf(bodyKeys[ki]) === -1) {
            return error("\"" + bodyKeys[ki] + "\" is not part of this call.", 400);
          }
        }
      }
      if (writeBody.baseVersion != null && owner) {
        if (typeof writeBody.baseVersion !== "number" || !isFinite(writeBody.baseVersion)) {
          return error(STALE_WRITE_MESSAGE, 409);
        }
        claimedPrevStamp = {
          by: owner.last_change_by || null,
          at: owner.last_change_at || null
        };
        var stampAt = nowIso();
        claimedVersion = await claimVersion(db, owner, writeBody.baseVersion, stampBy, stampAt);
        if (claimedVersion == null) {
          return error(STALE_WRITE_MESSAGE, 409);
        }
        owner.state_version = claimedVersion;
        owner.last_change_by = stampBy;
        owner.last_change_at = stampAt;
      }
    }
  }

  // A digest of the owner's state as it stands before the route
  // runs. A write whose digest afterwards reads exactly the same
  // changed nothing, and a write that changed nothing never
  // raises the version — its response carries the version as it
  // stands. An account not yet linked to a board set has no
  // state to digest: its writes are the sign-in routes' own,
  // and the version machinery below is skipped for them whole.
  var beforeDigest = null;
  if (isWrite && owner) {
    beforeDigest = await stateDigest(db, owner, env);
  }

  var response = null;
  try {
    response = await routeApi(request, deps, owner, parts, callerVia, callerKey,
      { account: callerAccount, session: callerSession });
  } catch (routeError) {
    // A route that fails mid-change answers in the app's own
    // error shape rather than as an unhandled exception. A claim
    // held for the write is handed back first, so the version
    // never rises for a change that did not land.
    if (claimedVersion != null) {
      await releaseClaim(db, owner.id, claimedVersion, claimedPrevStamp);
      owner.state_version = claimedVersion - 1;
      owner.last_change_by = claimedPrevStamp.by;
      owner.last_change_at = claimedPrevStamp.at;
    }
    return error("Something went wrong on the server. Nothing was saved.", 500);
  }

  if (!owner) return response;

  if (!isWrite) return response;

  if (response.status >= 200 && response.status < 300) {
    var version = currentVersion(owner);
    if ((await stateDigest(db, owner, env)) === beforeDigest) {
      // Nothing changed. A claim held for this write is handed
      // back, and the version stays where it stood.
      if (claimedVersion != null) {
        await releaseClaim(db, owner.id, claimedVersion, claimedPrevStamp);
        owner.state_version = claimedVersion - 1;
        owner.last_change_by = claimedPrevStamp.by;
        owner.last_change_at = claimedPrevStamp.at;
        version = claimedVersion - 1;
      }
    } else if (claimedVersion == null) {
      var bumpAt = nowIso();
      version = await bumpVersion(db, owner.id, stampBy, bumpAt);
      owner.state_version = version;
      owner.last_change_by = stampBy;
      owner.last_change_at = bumpAt;
      deps.pushNotify(owner.id, version);
    } else {
      // The claim already raised the version; the push carries
      // the same number.
      deps.pushNotify(owner.id, version);
    }
    try {
      var data = await response.json();
      if (data && typeof data === "object" && !Array.isArray(data)) {
        data.version = version;
        var merged = json(data, response.status);
        // A route that set a cookie keeps it through the merge:
        // the sign-in routes rotate the session cookie on a
        // proof or a privilege change, and that rotation is the
        // point of the call.
        var setCookies = typeof response.headers.getSetCookie === "function"
          ? response.headers.getSetCookie() : null;
        if (setCookies && setCookies.length) {
          // json() builds a fresh Response; append each cookie
          // the route set, in order.
          setCookies.forEach(function (value) {
            merged.headers.append("Set-Cookie", value);
          });
        } else if (response.headers.get("Set-Cookie")) {
          merged.headers.set("Set-Cookie", response.headers.get("Set-Cookie"));
        }
        return merged;
      }
    } catch (e) { /* an accepted change with no JSON body keeps its shape */ }
    return response;
  }

  // A refused write applies nothing, and a claim held for it is
  // handed back, so the version never rises for a change that
  // did not land.
  if (claimedVersion != null) {
    await releaseClaim(db, owner.id, claimedVersion, claimedPrevStamp);
    owner.state_version = claimedVersion - 1;
    owner.last_change_by = claimedPrevStamp.by;
    owner.last_change_at = claimedPrevStamp.at;
  }
  return response;
  }
}

// The routes themselves. The caller is resolved before this runs,
// so every handler below works for that one owner only. `via` says
// how the caller arrived — "access" for a signed-in person, or
// "agent-token" for a key — for the one route that cares: the key
// route answers people, never keys. `callerKey` is the key the
// caller arrived with ({ id, name }) or null for a person; the
// card and comment writes stamp it as their creator or author.
async function routeApi(request, deps, owner, parts, via, callerKey, caller) {
    var db = deps.db;
    var env = deps.env;
    var method = request.method;
    var p = null;

    // The caller: who they are, their whole state, their preferences.
    if ((p = match(parts, ["api", "me"]))) {
      if (method === "GET") {
        // Through a key, /me names the person the key speaks
        // for — id and the name they go by — and carries no
        // email (issue #65's trim covers this answer too: a key
        // needs boards, not the owner's email). The person's
        // own session gets the email as well.
        return via === "agent-token"
          ? json({ id: owner.id, name: effectiveName(owner) })
          : json({ name: effectiveName(owner), email: owner.email });
      }
      if (method === "PATCH") {
        var meBody = await readBody(request);
        if (!meBody) return error("JSON body is required.");
        // The display name is the person's own to set (issue
        // #66): it is judged before anything is written, like
        // every field of a write, and a key may not set it — a
        // key speaks for the person on their boards, but what
        // the person is called is not a board.
        if (meBody.name != null) {
          if (via === "agent-token") {
            return error("Only the person can change their name.", 403);
          }
          if (typeof meBody.name !== "string" || !meBody.name.trim()) {
            return error("A name is required.");
          }
          if (meBody.name.trim().length > 120) {
            return error("A name is at most 120 characters.");
          }
        }
        if (meBody.theme != null) {
          if (THEME_MODES.indexOf(String(meBody.theme)) === -1) {
            return error("theme must be system, light or dark.");
          }
        }
        // The rename renames the account too (issue #131):
        // the sign-in name, the Admin roster's name and the
        // boards' name are one name, so a person signed in
        // through an account renames that account in the
        // same act. A name another account holds is refused
        // here, before anything is written, like every field
        // of a write. A transition-door caller holds no
        // account; their stored name is the claim's to keep.
        var renameTarget = null;
        if (meBody.name != null && via === "account" && caller && caller.account) {
          var wantedKey = nameKey(meBody.name.trim());
          if (wantedKey !== caller.account.key &&
              (await getAccount(deps.authDb || deps.db, wantedKey))) {
            return error("That name is not available. Pick another name and try again.");
          }
          renameTarget = caller.account;
        }
        if (meBody.name != null) {
          var newDisplayName = meBody.name.trim();
          if (renameTarget) {
            await renameAccount(deps.authDb || deps.db, renameTarget, newDisplayName);
          }
          await db.prepare("UPDATE owners SET display_name = ? WHERE id = ?")
            .bind(newDisplayName, owner.id).run();
          owner.display_name = newDisplayName;
        }
        if (meBody.theme != null) {
          await db.prepare("UPDATE owners SET theme = ? WHERE id = ?")
            .bind(String(meBody.theme), owner.id).run();
          owner.theme = String(meBody.theme);
        }
        return via === "agent-token"
          ? json({ name: effectiveName(owner), theme: owner.theme || "system" })
          : json({ name: effectiveName(owner), email: owner.email, theme: owner.theme || "system" });
      }
    }

    if ((p = match(parts, ["api", "state"]))) {
      if (method === "GET") {
        var stateAnswer = await buildState(db, owner, env, via);
        // The terms standing (issue #43): where the deployment
        // names a Terms version, a person whose newest recorded
        // agreement is older than it reads the standing here —
        // the new version, which the app speaks as the date the
        // terms changed — and the app stands its note before
        // the boards. A person with no row reads nothing: the
        // record began with a tick they never gave, and a key
        // reads nothing either — the standing is a person's,
        // carried only on the answer their own sign-in reads.
        if (deps.termsVersion && caller && caller.account) {
          var latestTerms = await latestAgreement(deps.authDb || deps.db, caller.account.key);
          if (latestTerms && latestTerms.terms_version < deps.termsVersion) {
            stateAnswer.termsUpdate = { changedOn: deps.termsVersion };
          }
        }
        return json(stateAnswer);
      }
    }

    // The re-tick (issue #43): the person's answer to the
    // standing the state carried. It writes only to the auth
    // store — no board changes, so it stands outside the
    // boards' version machinery like the key routes beside
    // it — and it is a person's own act: a key can neither
    // see the standing nor answer it. The tick itself is
    // enforced here, not trusted to the page: a press without
    // it is refused and writes nothing. Where the deployment
    // names no Terms version the route does not stand at all.
    if ((p = match(parts, ["api", "terms", "agree"]))) {
      if (method === "POST") {
        if (!deps.termsVersion) {
          return error("This copy keeps no terms record.", 404);
        }
        if (via === "agent-token" || !caller || !caller.account) {
          return error("The terms agreement is the person's own act, in the app.", 403);
        }
        var termsBody = await readBody(request);
        if (!termsBody || termsBody.agreed !== true) {
          return error("Tick the box to agree to the Terms first.", 400);
        }
        var termsAuthDb = deps.authDb || deps.db;
        var standingTerms = await latestAgreement(termsAuthDb, caller.account.key);
        if (!standingTerms) {
          return error("No agreement stands for this account to renew.", 400);
        }
        if (standingTerms.terms_version < deps.termsVersion) {
          await recordAgreement(termsAuthDb, caller.account.key, deps.termsVersion, "retick");
        }
        return json({ ok: true });
      }
    }

    // The caller's queue (issue #119): the cards whose next
    // step is the caller's, across all of the owner's boards,
    // each in the full card shape state carries, in the order
    // state itself reads cards. For a key caller these are the
    // cards handed to that key — the work waiting on it. For
    // the person they are the cards whose step is theirs.
    // Archived cards stand in the list while they stand
    // anywhere: archiving clears the step to no one, so an
    // archived card never names a holder and never appears.
    if ((p = match(parts, ["api", "queue"]))) {
      if (method === "GET") {
        var queueState = await buildState(db, owner, env, via);
        var queueCards = queueState.cards.filter(function (card) {
          if (card.archived) return false;
          if (callerKey) {
            return card.step.holder === "agent" && card.step.keyId === callerKey.id;
          }
          return card.step.holder === "owner";
        });
        return json({ cards: queueCards });
      }
    }

    // The change marker on its own: the owner's version number,
    // for a reader that only wants to know whether anything
    // changed since the state it holds — plus the build stamp,
    // which the app checks against its own on every open. The
    // person's own answer also carries the stamp of the latest
    // change (who made it, and when); a key's answer carries the
    // number and the build only, so the stamp never tells a key
    // when the person is at their boards (issue #64). The
    // answer is never cached: a stored copy would defeat both
    // readers.
    if ((p = match(parts, ["api", "version"]))) {
      if (method === "GET") {
        var versionAnswer = { version: currentVersion(owner), build: BUILD_ID };
        if (via !== "agent-token") versionAnswer.lastChange = lastChangeStamp(owner);
        return json(versionAnswer, 200, { "cache-control": "no-store" });
      }
    }

    // The directions an agent works from (issue #17). Authorized
    // exactly like every other route — the caller is resolved
    // before this runs, so no key and no sign-in means a 401 from
    // caller resolution, never the text. The signed-in panel reads
    // the same handler through the people's door for its "What
    // your agent will read" view, so the person sees the very
    // text their agent will be told. Plain text, read fresh: the
    // answer carries no-store like every other API answer.
    if ((p = match(parts, ["api", "directions"]))) {
      if (method === "GET") {
        return plainText(agentDirections(env));
      }
    }

    // The live socket. Authorized exactly like every other route —
    // the caller is resolved before this runs, so a socket exists
    // only for a signed-in owner or an owner's key — then handed to
    // the owner's push object, which holds it from there.
    if ((p = match(parts, ["api", "push"]))) {
      if (method === "GET") {
        if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
          return error("This address carries live updates to an open board. Connect with a WebSocket.", 400);
        }
        if (!deps.acceptPush) return error("Live updates are not configured.", 501);
        var acceptedPush = await deps.acceptPush(request, owner);
        if (!acceptedPush) return error("Live updates are not configured.", 501);
        return acceptedPush;
      }
    }

    // The caller's agent keys (issue #45). An owner holds a list
    // of named keys, all live at once: each key is a row of its
    // own, and making, renaming or revoking one touches no other.
    // Only the hash and the last four characters are stored. A
    // key's full value is in its creation response and nowhere
    // else, ever.
    //
    // These routes answer signed-in people only, never a key: a
    // key holds its owner's full powers over the boards, but it
    // cannot mint, rename or revoke a key. A leaked key therefore
    // cannot lock the owner's other agents out; the person
    // manages keys from the signed-in app, which is the only
    // place it can happen.
    if ((p = match(parts, ["api", "me", "token"]))) {
      if (via !== "access" && via !== "account") {
        return error("Keys are made and removed in the signed-in app, under Settings, then Set Up Agent.", 403);
      }
      if (method === "GET") {
        var keyRows = (await db.prepare(
          "SELECT id, label, last4, created_at FROM api_tokens " +
          "WHERE owner_id = ? AND revoked_at IS NULL ORDER BY created_at, rowid"
        ).bind(owner.id).all()).results;
        return json({ keys: keyRows.map(function (row) {
          return { id: row.id, name: row.label, last4: row.last4 || "", created_at: row.created_at };
        }) });
      }
      if (method === "POST") {
        var keyBody = await readBody(request);
        var keyName = keyBody && keyBody.name != null ? String(keyBody.name).trim() : "";
        if (overLimit(keyName, LIMITS.nameChars)) return error("name is too long.");
        if (!keyName) keyName = "Agent";
        var liveKeys = await db.prepare(
          "SELECT COUNT(*) AS count FROM api_tokens WHERE owner_id = ? AND revoked_at IS NULL"
        ).bind(owner.id).first();
        if (countOf(liveKeys) >= LIMITS.keysPerOwner) {
          return error("That is as many keys as one person holds. Delete a key before making another.", 400);
        }
        var fullKey = makeAgentKey();
        var keyStamp = nowIso();
        var keyId = newId("token");
        await db.prepare("INSERT INTO api_tokens (id, owner_id, label, token_hash, last4, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)")
          .bind(keyId, owner.id, keyName, await sha256Hex(fullKey), fullKey.slice(-4), keyStamp).run();
        return json({ key: fullKey, id: keyId, name: keyName, last4: fullKey.slice(-4), created_at: keyStamp }, 201);
      }
      if (method === "DELETE") {
        return error("Name the key to delete: a delete names one key, by its id.", 400);
      }
    }

    // One of the caller's keys, named in the address: rename it or
    // revoke it. The row is read through the caller, so an id from
    // another owner reads as not found, the way every id here does.
    if ((p = match(parts, ["api", "me", "token", ":tokenId"]))) {
      if (via !== "access" && via !== "account") {
        return error("Keys are made and removed in the signed-in app, under Settings, then Set Up Agent.", 403);
      }
      var theToken = await db.prepare(
        "SELECT * FROM api_tokens WHERE id = ? AND owner_id = ? AND revoked_at IS NULL"
      ).bind(p.tokenId, owner.id).first();
      if (!theToken) return error("Key not found.", 404);
      if (method === "PATCH") {
        var renameBody = await readBody(request);
        if (!renameBody || renameBody.name == null || !String(renameBody.name).trim()) {
          return error("name is required.");
        }
        var cleanKeyName = String(renameBody.name).trim();
        if (overLimit(cleanKeyName, LIMITS.nameChars)) return error("name is too long.");
        // The name is all a rename touches: the row's hash, and
        // with it the key itself, stands exactly as it was.
        await db.prepare("UPDATE api_tokens SET label = ? WHERE id = ? AND owner_id = ?")
          .bind(cleanKeyName, theToken.id, owner.id).run();
        return json({ key: { id: theToken.id, name: cleanKeyName, last4: theToken.last4 || "", created_at: theToken.created_at } });
      }
      if (method === "DELETE") {
        // Revoking is a stamp, not a row delete: the row stays as
        // the record of the key. The hash lookup that resolves a
        // caller already passes over revoked rows, so this key
        // stops working at once and no other key is touched.
        await db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND owner_id = ?")
          .bind(nowIso(), theToken.id, owner.id).run();
        // The cards whose next step was this key's come back to
        // the owner (issue #119): a deleted key holds nothing,
        // and a card it was handed waits for nobody — it stands
        // as the owner's step, not waiting. The hand-over record
        // on each card stays as it was written.
        await db.prepare(
          "UPDATE cards SET step_holder = 'owner', step_key_id = NULL, step_key_name = NULL, step_waiting = 0 " +
          "WHERE step_key_id = ? AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)"
        ).bind(theToken.id, owner.id).run();
        return json({ ok: true });
      }
    }

    // Boards.
    if ((p = match(parts, ["api", "boards"]))) {
      if (method === "POST") {
        var boardBody = await readBody(request);
        if (!boardBody || !boardBody.name || !String(boardBody.name).trim()) {
          return error("name is required.");
        }
        if (overLimit(String(boardBody.name).trim(), LIMITS.nameChars)) {
          return error("name is too long.");
        }
        var boardIconIn = bodyIcon(boardBody);
        if (boardIconIn === null) return error("icon must be a single emoji.");
        var boardCount = await db.prepare("SELECT COUNT(*) AS count FROM boards WHERE owner_id = ?")
          .bind(owner.id).first();
        if (countOf(boardCount) >= LIMITS.boardsPerOwner) {
          return error("That is as many boards as TaskSparkle holds for one person.", 400);
        }
        var lastBoard = await db.prepare(
          "SELECT MAX(position) AS maxp FROM boards WHERE owner_id = ?"
        ).bind(owner.id).first();
        var boardRow = {
          id: newId("board"),
          owner_id: owner.id,
          name: String(boardBody.name).trim(),
          icon: boardIconIn || null,
          label_colour_mode: "chip",
          position: lastBoard && lastBoard.maxp != null ? Number(lastBoard.maxp) + 1 : 0,
          created_at: nowIso(),
          updated_at: nowIso()
        };
        // The board and its five columns land as one batch.
        var boardStatements = [
          db.prepare("INSERT INTO boards (id, owner_id, name, icon, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(boardRow.id, boardRow.owner_id, boardRow.name, boardRow.icon, boardRow.position, boardRow.created_at, boardRow.updated_at)
        ];
        for (var nc = 0; nc < DEFAULT_COLUMNS.length; nc++) {
          var columnDef = DEFAULT_COLUMNS[nc];
          boardStatements.push(db.prepare('INSERT INTO "columns" (id, board_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(boardRow.id + "-" + columnDef.kind, boardRow.id, columnDef.name, columnDef.position, boardRow.created_at, boardRow.updated_at));
        }
        await batchRun(db, boardStatements);
        return json({ board: await boardOut(db, boardRow) }, 201);
      }
    }

    if ((p = match(parts, ["api", "boards", ":boardId"]))) {
      var theBoard = await ownerBoard(db, owner.id, p.boardId);
      if (!theBoard) return error("Board not found.", 404);
      if (method === "PATCH") {
        var boardPatch = await readBody(request);
        if (!boardPatch) return error("JSON body is required.");
        // Every field is judged before any write: a refused PATCH
        // changes nothing at all.
        var boardPatchIcon = bodyIcon(boardPatch);
        if (boardPatchIcon === null) return error("icon must be a single emoji.");
        if (boardPatch.name != null) {
          if (!String(boardPatch.name).trim()) return error("name is required.");
          if (overLimit(String(boardPatch.name).trim(), LIMITS.nameChars)) return error("name is too long.");
        }
        if (boardPatch.label_colour_mode != null &&
            LABEL_COLOUR_MODES.indexOf(boardPatch.label_colour_mode) === -1) {
          return error("label_colour_mode must be one of: " + LABEL_COLOUR_MODES.join(", ") + ".");
        }
        await db.prepare("UPDATE boards SET name = COALESCE(?, name), position = COALESCE(?, position), updated_at = ? WHERE id = ? AND owner_id = ?")
          .bind(
            boardPatch.name != null ? String(boardPatch.name) : null,
            boardPatch.position != null ? Number(boardPatch.position) : null,
            nowIso(), p.boardId, owner.id
          ).run();
        if (boardPatch.label_colour_mode != null) {
          await db.prepare("UPDATE boards SET label_colour_mode = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
            .bind(boardPatch.label_colour_mode, nowIso(), p.boardId, owner.id).run();
        }
        if (boardPatchIcon !== undefined) {
          await db.prepare("UPDATE boards SET icon = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
            .bind(boardPatchIcon || null, nowIso(), p.boardId, owner.id).run();
        }
        return json({ board: await boardOut(db, await ownerBoard(db, owner.id, p.boardId)) });
      }
      if (method === "DELETE") {
        // A board deletes whole (issue #134): its cards —
        // active and archived alike — and its columns, labels
        // and projects go with it, by the schema's cascades.
        // The Settings dialog names the count before the act;
        // the one guard left is the keep-one rule below.
        // A person always keeps at least one board.
        var ownerBoardCount = await db.prepare("SELECT COUNT(*) AS count FROM boards WHERE owner_id = ?")
          .bind(owner.id).first();
        if (ownerBoardCount && Number(ownerBoardCount.count) <= 1) {
          return error("You must keep at least one board.", 400);
        }
        await db.prepare("DELETE FROM boards WHERE id = ? AND owner_id = ?").bind(p.boardId, owner.id).run();
        return json({ ok: true });
      }
    }

    // Copy a board. One call makes the whole copy — the new board,
    // the chosen structure and the chosen cards — so the write
    // gate's single version bump covers the whole act. The four
    // flags say what rides along: the source's columns, labels
    // (names, colours and icons), projects (names and icons)
    // and its cards. The board's label colour mode always
    // rides along: it is part of what the board is.
    // Without the columns flag the new board starts with the five
    // standard columns. Copied cards map into the new board's
    // columns by column position index, clamped to the last
    // column, the same rule a card moving boards follows; their
    // labels and project point at the copies, and land empty when
    // those flags are off. Archived cards never copy.
    if ((p = match(parts, ["api", "boards", ":boardId", "copy"]))) {
      var copySource = await ownerBoard(db, owner.id, p.boardId);
      if (!copySource) return error("Board not found.", 404);
      if (method === "POST") {
        var copyBody = await readBody(request);
        if (!copyBody || !copyBody.name || !String(copyBody.name).trim()) {
          return error("name is required.");
        }
        var copyFlags = ["columns", "labels", "projects", "cards"];
        for (var fi = 0; fi < copyFlags.length; fi++) {
          var flagValue = copyBody[copyFlags[fi]];
          if (flagValue !== undefined && typeof flagValue !== "boolean") {
            return error(copyFlags[fi] + " must be true or false.");
          }
        }
        var wantColumns = copyBody.columns === true;
        var wantLabels = copyBody.labels === true;
        var wantProjects = copyBody.projects === true;
        var wantCards = copyBody.cards === true;
        var copyStamp = nowIso();
        if (overLimit(String(copyBody.name).trim(), LIMITS.nameChars)) {
          return error("name is too long.");
        }
        var copyBoardCount = await db.prepare("SELECT COUNT(*) AS count FROM boards WHERE owner_id = ?")
          .bind(owner.id).first();
        if (countOf(copyBoardCount) >= LIMITS.boardsPerOwner) {
          return error("That is as many boards as TaskSparkle holds for one person.", 400);
        }

        // The whole copy is gathered as statements first and run
        // as one batch at the end (see batchRun): a failure
        // partway leaves no half-copied board behind. Every read
        // below reads the source, which the pending statements do
        // not touch, so gathering and reading can interleave.
        var copyStatements = [];

        var lastCopyBoard = await db.prepare(
          "SELECT MAX(position) AS maxp FROM boards WHERE owner_id = ?"
        ).bind(owner.id).first();
        var newBoardRow = {
          id: newId("board"),
          owner_id: owner.id,
          name: String(copyBody.name).trim(),
          icon: copySource.icon || null,
          label_colour_mode: boardLabelMode(copySource),
          position: lastCopyBoard && lastCopyBoard.maxp != null ? Number(lastCopyBoard.maxp) + 1 : 0,
          created_at: copyStamp,
          updated_at: copyStamp
        };
        copyStatements.push(db.prepare("INSERT INTO boards (id, owner_id, name, icon, label_colour_mode, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(newBoardRow.id, newBoardRow.owner_id, newBoardRow.name, newBoardRow.icon, newBoardRow.label_colour_mode, newBoardRow.position, newBoardRow.created_at, newBoardRow.updated_at));

        var sourceColumns = await boardColumns(db, copySource.id);
        var targetColumns = [];
        if (wantColumns) {
          for (var sci = 0; sci < sourceColumns.length; sci++) {
            var sourceColumn = sourceColumns[sci];
            var targetColumnId = newBoardRow.id + "-" + columnKind(sourceColumn);
            copyStatements.push(db.prepare('INSERT INTO "columns" (id, board_id, name, icon, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .bind(targetColumnId, newBoardRow.id, sourceColumn.name, sourceColumn.icon || null, sci, copyStamp, copyStamp));
            targetColumns.push({ id: targetColumnId });
          }
        } else {
          for (var dci = 0; dci < DEFAULT_COLUMNS.length; dci++) {
            var defaultColumnId = newBoardRow.id + "-" + DEFAULT_COLUMNS[dci].kind;
            copyStatements.push(db.prepare('INSERT INTO "columns" (id, board_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
              .bind(defaultColumnId, newBoardRow.id, DEFAULT_COLUMNS[dci].name, DEFAULT_COLUMNS[dci].position, copyStamp, copyStamp));
            targetColumns.push({ id: defaultColumnId });
          }
        }

        var labelIdMap = {};
        if (wantLabels) {
          var sourceLabels = (await db.prepare(
            "SELECT * FROM labels WHERE board_id = ? ORDER BY created_at"
          ).bind(copySource.id).all()).results;
          for (var sli = 0; sli < sourceLabels.length; sli++) {
            var sourceLabel = sourceLabels[sli];
            var newLabelId = newId("label");
            labelIdMap[sourceLabel.id] = newLabelId;
            copyStatements.push(db.prepare("INSERT INTO labels (id, board_id, name, icon, colour, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
              .bind(newLabelId, newBoardRow.id, sourceLabel.name, sourceLabel.icon || null, sourceLabel.colour, copyStamp, copyStamp));
          }
        }

        var projectIdMap = {};
        if (wantProjects) {
          var sourceProjects = (await db.prepare(
            "SELECT * FROM projects WHERE board_id = ? ORDER BY created_at"
          ).bind(copySource.id).all()).results;
          for (var spi = 0; spi < sourceProjects.length; spi++) {
            var sourceProject = sourceProjects[spi];
            var newProjectId = newId("project");
            projectIdMap[sourceProject.id] = newProjectId;
            copyStatements.push(db.prepare("INSERT INTO projects (id, board_id, name, icon, created_at) VALUES (?, ?, ?, ?, ?)")
              .bind(newProjectId, newBoardRow.id, sourceProject.name, sourceProject.icon || null, copyStamp));
          }
        }

        if (wantCards) {
          var sourceColumnIndex = {};
          sourceColumns.forEach(function (row, i) { sourceColumnIndex[row.id] = i; });
          var sourceCards = (await db.prepare(
            "SELECT * FROM cards WHERE board_id = ? AND archived = 0 ORDER BY position, created_at"
          ).bind(copySource.id).all()).results;
          sourceCards.sort(function (a, b) {
            var byColumn = (sourceColumnIndex[a.column_id] || 0) - (sourceColumnIndex[b.column_id] || 0);
            return byColumn !== 0 ? byColumn : Number(a.position) - Number(b.position);
          });
          var targetRun = {};
          for (var cai = 0; cai < sourceCards.length; cai++) {
            var sourceCard = sourceCards[cai];
            var fromIndex = sourceColumnIndex[sourceCard.column_id] || 0;
            var toIndex = Math.min(fromIndex, targetColumns.length - 1);
            var targetColumn = targetColumns[toIndex];
            var targetPosition = targetRun[targetColumn.id] || 0;
            targetRun[targetColumn.id] = targetPosition + 1;
            var newCardId = newId("card");
            // A copied card takes the copier as its creator — the
            // copy is a new first version of the card — and starts
            // with no comments: the source's comments are its own
            // board's conversation and never copy (issues #50, #51).
            // Its next step starts with the copier too, the way a
            // created card's does (issue #119). Both stamps record
            // the copier's id alone: the names resolve from the
            // key's record as the card is read (issue #121).
            copyStatements.push(db.prepare("INSERT INTO cards (id, board_id, column_id, project_id, title, notes, due_date, position, archived, important, creator_key_id, creator_key_name, step_holder, step_key_id, step_key_name, step_handed_at, step_handed_by_key_id, step_handed_by_key_name, step_waiting, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
              .bind(newCardId, newBoardRow.id, targetColumn.id,
                wantProjects && sourceCard.project_id ? (projectIdMap[sourceCard.project_id] || null) : null,
                sourceCard.title, sourceCard.notes, sourceCard.due_date, targetPosition, 0,
                sourceCard.important,
                callerKey ? callerKey.id : null, null,
                callerKey ? "agent" : "owner", callerKey ? callerKey.id : null, null,
                null, null, null, 0,
                copyStamp, copyStamp));
            if (wantLabels) {
              var cardLabelRows = (await db.prepare(
                "SELECT label_id FROM card_labels WHERE card_id = ?"
              ).bind(sourceCard.id).all()).results;
              for (var cli = 0; cli < cardLabelRows.length; cli++) {
                var mappedLabel = labelIdMap[cardLabelRows[cli].label_id];
                if (mappedLabel) {
                  copyStatements.push(db.prepare("INSERT INTO card_labels (card_id, label_id) VALUES (?, ?)")
                    .bind(newCardId, mappedLabel));
                }
              }
            }
            var stepRows = (await db.prepare(
              "SELECT * FROM checklist_items WHERE card_id = ? ORDER BY position, created_at"
            ).bind(sourceCard.id).all()).results;
            for (var sti = 0; sti < stepRows.length; sti++) {
              copyStatements.push(db.prepare("INSERT INTO checklist_items (id, card_id, text, done, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
                .bind(newId("step"), newCardId, stepRows[sti].text, stepRows[sti].done, stepRows[sti].position, copyStamp, copyStamp));
            }
            var linkRows = (await db.prepare(
              "SELECT * FROM card_links WHERE card_id = ? ORDER BY position, created_at"
            ).bind(sourceCard.id).all()).results;
            for (var lki = 0; lki < linkRows.length; lki++) {
              copyStatements.push(db.prepare("INSERT INTO card_links (id, card_id, url, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
                .bind(newId("link"), newCardId, linkRows[lki].url, linkRows[lki].name, linkRows[lki].position, copyStamp, copyStamp));
            }
          }
        }

        await batchRun(db, copyStatements);
        return json({ board: await boardOut(db, newBoardRow) }, 201);
      }
    }

    // Columns. A board's columns are the owner's own: they can be
    // renamed, added, removed and reordered. A removal is refused
    // while the column holds active cards, and the last column on a
    // board can never be removed. A column that holds only archived
    // cards gives those cards to the board's first column as part of
    // the removal, still archived.
    if ((p = match(parts, ["api", "columns"]))) {
      if (method === "POST") {
        var columnBody = await readBody(request);
        if (!columnBody || !columnBody.board_id || !columnBody.name || !String(columnBody.name).trim()) {
          return error("board_id and name are required.");
        }
        if (overLimit(String(columnBody.name).trim(), LIMITS.nameChars)) {
          return error("name is too long.");
        }
        var columnBoard = await ownerBoard(db, owner.id, String(columnBody.board_id));
        if (!columnBoard) return error("Board not found.", 404);
        var columnIconIn = bodyIcon(columnBody);
        if (columnIconIn === null) return error("icon must be a single emoji.");
        var columnCount = await db.prepare('SELECT COUNT(*) AS count FROM "columns" WHERE board_id = ?')
          .bind(columnBoard.id).first();
        if (countOf(columnCount) >= LIMITS.columnsPerBoard) {
          return error("That is as many columns as one board holds.", 400);
        }
        var kind = await newColumnKind(db, columnBoard.id, columnBody.kind ? String(columnBody.kind) : null);
        var lastColumn = await db.prepare(
          'SELECT MAX(position) AS maxp FROM "columns" WHERE board_id = ?'
        ).bind(columnBoard.id).first();
        var columnRow = {
          id: columnBoard.id + "-" + kind,
          board_id: columnBoard.id,
          name: String(columnBody.name).trim(),
          icon: columnIconIn || null,
          position: lastColumn && lastColumn.maxp != null ? Number(lastColumn.maxp) + 1 : 0,
          created_at: nowIso(),
          updated_at: nowIso()
        };
        await db.prepare('INSERT INTO "columns" (id, board_id, name, icon, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(columnRow.id, columnRow.board_id, columnRow.name, columnRow.icon, columnRow.position, columnRow.created_at, columnRow.updated_at).run();
        return json({ column: columnOut(columnRow) }, 201);
      }
    }

    if ((p = match(parts, ["api", "columns", ":columnId"]))) {
      var theColumn = await ownerColumn(db, owner.id, p.columnId);
      if (!theColumn) return error("Column not found.", 404);
      if (method === "PATCH") {
        var columnPatch = await readBody(request);
        if (!columnPatch) return error("JSON body is required.");
        // Every field is judged before any write. This handler
        // once wrote a valid icon before it judged the name, so a
        // refused PATCH still changed the icon, with no version
        // rise to announce it; the sweep that fixed it covers
        // every PATCH handler in this file.
        var columnPatchIcon = bodyIcon(columnPatch);
        if (columnPatchIcon === null) return error("icon must be a single emoji.");
        var cleanColumnName = null;
        if (columnPatch.name != null) {
          cleanColumnName = String(columnPatch.name).trim();
          if (!cleanColumnName) return error("name is required.");
          if (overLimit(cleanColumnName, LIMITS.nameChars)) return error("name is too long.");
        }
        if (columnPatchIcon !== undefined) {
          await db.prepare('UPDATE "columns" SET icon = ?, updated_at = ? WHERE id = ?')
            .bind(columnPatchIcon || null, nowIso(), p.columnId).run();
          theColumn.icon = columnPatchIcon || null;
        }
        if (cleanColumnName != null) {
          await db.prepare('UPDATE "columns" SET name = ?, updated_at = ? WHERE id = ?')
            .bind(cleanColumnName, nowIso(), p.columnId).run();
          theColumn.name = cleanColumnName;
        }
        if (columnPatch.position != null) {
          // A reorder names the place the column moves to, counting
          // from the left. The board's other columns shift around it
          // and every position is written back as one clean run.
          var siblings = await boardColumns(db, theColumn.board_id);
          var fromIndex = -1;
          for (var si = 0; si < siblings.length; si++) {
            if (siblings[si].id === theColumn.id) fromIndex = si;
          }
          if (fromIndex !== -1) {
            var toIndex = Math.max(0, Math.min(Number(columnPatch.position) || 0, siblings.length - 1));
            if (toIndex !== fromIndex) {
              var moved = siblings.splice(fromIndex, 1)[0];
              siblings.splice(toIndex, 0, moved);
              await renumberColumns(db, siblings);
            }
          }
        }
        var updatedColumn = await ownerColumn(db, owner.id, p.columnId);
        return json({ column: columnOut(updatedColumn) });
      }
      if (method === "DELETE") {
        var boardColumnRows = await boardColumns(db, theColumn.board_id);
        if (boardColumnRows.length <= 1) {
          return error("You must keep at least one column.", 400);
        }
        // A column that holds cards names the column that
        // receives them, as move_to_column_id in the body (issue
        // #42): every card moves to the end of that column, the
        // active ones in their order, archived ones after them
        // and still archived, and the column is removed in the
        // same act. Without cards the delete takes no destination.
        // The old refusal — move or delete the cards first — is
        // gone; holding cards is a question with an answer, not a
        // dead end.
        var deleteBody = await readBody(request);
        var cardsInColumn = (await db.prepare(
          "SELECT * FROM cards WHERE column_id = ? ORDER BY position, created_at"
        ).bind(p.columnId).all()).results;
        var deleteStatements = [];
        var moveStamp = nowIso();
        if (cardsInColumn.length > 0) {
          if (!deleteBody || deleteBody.move_to_column_id == null || !String(deleteBody.move_to_column_id).trim()) {
            return error("That column holds " + cardsInColumn.length +
              (cardsInColumn.length === 1 ? " card" : " cards") +
              ". Name the column that receives them as move_to_column_id.", 400);
          }
          var destColumn = await columnForBoard(db, theColumn.board_id, String(deleteBody.move_to_column_id).trim());
          if (!destColumn || destColumn.id === theColumn.id) {
            return error("Name another column on this board to receive the cards.", 400);
          }
          // The destination's active run stands as it is; the
          // incoming active cards take the places after it, in
          // their own order, and the archived ones follow, still
          // archived. Each card's move names the column it leaves
          // as well as the card itself, so the batch carries its
          // own scoping.
          var destActiveCount = (await columnCards(db, destColumn.id)).length;
          var incomingActive = cardsInColumn.filter(function (row) { return !row.archived; });
          var incomingArchived = cardsInColumn.filter(function (row) { return !!row.archived; });
          incomingActive.forEach(function (row, i) {
            deleteStatements.push(db.prepare("UPDATE cards SET column_id = ?, position = ?, updated_at = ? WHERE id = ? AND column_id = ?")
              .bind(destColumn.id, destActiveCount + i, moveStamp, row.id, p.columnId));
          });
          incomingArchived.forEach(function (row, i) {
            deleteStatements.push(db.prepare("UPDATE cards SET column_id = ?, position = ?, updated_at = ? WHERE id = ? AND column_id = ?")
              .bind(destColumn.id, destActiveCount + incomingActive.length + i, moveStamp, row.id, p.columnId));
          });
          // A move is a write to each card it moves (issue
          // #119): a waiting card this caller holds is picked
          // up by being moved, like any other write of theirs.
          cardsInColumn.forEach(function (row) {
            var movedStep = stepOf(row);
            if (!movedStep.waiting) return;
            var moverIsHolder = callerKey
              ? (movedStep.holder === "agent" && movedStep.keyId === callerKey.id)
              : movedStep.holder === "owner";
            if (moverIsHolder) {
              deleteStatements.push(db.prepare("UPDATE cards SET step_waiting = 0 WHERE id = ?")
                .bind(row.id));
            }
          });
        }
        // The delete and the renumber land in the same batch as
        // the move, so the whole removal is one act. The delete
        // names the column's board — itself a row this caller
        // owns — so the statement carries its own scoping, not
        // just the lookup above it.
        deleteStatements.push(db.prepare('DELETE FROM "columns" WHERE id = ? AND board_id = ?')
          .bind(p.columnId, theColumn.board_id));
        var remainingColumns = boardColumnRows.filter(function (row) { return row.id !== p.columnId; });
        for (var rni = 0; rni < remainingColumns.length; rni++) {
          if (Number(remainingColumns[rni].position) !== rni) {
            deleteStatements.push(db.prepare('UPDATE "columns" SET position = ?, updated_at = ? WHERE id = ?')
              .bind(rni, moveStamp, remainingColumns[rni].id));
          }
        }
        await batchRun(db, deleteStatements);
        return json({ ok: true });
      }
    }

    // Labels. Deleting a label lifts it off its cards through the
    // schema's cascade on card_labels; a card's other labels stay.
    if ((p = match(parts, ["api", "labels"]))) {
      if (method === "POST") {
        var labelBody = await readBody(request);
        if (!labelBody || !labelBody.board_id || !labelBody.name || !String(labelBody.name).trim()) {
          return error("board_id and name are required.");
        }
        if (overLimit(String(labelBody.name).trim(), LIMITS.nameChars)) {
          return error("name is too long.");
        }
        if (labelBody.colour != null && overLimit(labelBody.colour, LIMITS.colourChars)) {
          return error("colour is too long.");
        }
        if (!(await ownerBoard(db, owner.id, String(labelBody.board_id)))) {
          return error("Board not found.", 404);
        }
        var labelIconIn = bodyIcon(labelBody);
        if (labelIconIn === null) return error("icon must be a single emoji.");
        var labelCount = await db.prepare("SELECT COUNT(*) AS count FROM labels WHERE board_id = ?")
          .bind(String(labelBody.board_id)).first();
        if (countOf(labelCount) >= LIMITS.labelsPerBoard) {
          return error("That is as many labels as one board holds.", 400);
        }
        var labelRow = {
          id: newId("label"),
          board_id: String(labelBody.board_id),
          name: String(labelBody.name).trim(),
          icon: labelIconIn || null,
          colour: labelBody.colour ? String(labelBody.colour) : "grey",
          created_at: nowIso(),
          updated_at: nowIso()
        };
        await db.prepare("INSERT INTO labels (id, board_id, name, icon, colour, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(labelRow.id, labelRow.board_id, labelRow.name, labelRow.icon, labelRow.colour, labelRow.created_at, labelRow.updated_at).run();
        return json({ label: { id: labelRow.id, boardId: labelRow.board_id, name: labelRow.name, icon: labelRow.icon || "", colour: labelRow.colour } }, 201);
      }
    }

    if ((p = match(parts, ["api", "labels", ":labelId"]))) {
      var theLabel = await ownerLabel(db, owner.id, p.labelId);
      if (!theLabel) return error("Label not found.", 404);
      if (method === "PATCH") {
        var labelPatch = await readBody(request);
        if (!labelPatch) return error("JSON body is required.");
        // Every field is judged before any write, here as in
        // every PATCH handler.
        var labelPatchIcon = bodyIcon(labelPatch);
        if (labelPatchIcon === null) return error("icon must be a single emoji.");
        if (labelPatch.name != null) {
          if (!String(labelPatch.name).trim()) return error("name is required.");
          if (overLimit(String(labelPatch.name).trim(), LIMITS.nameChars)) return error("name is too long.");
        }
        if (labelPatch.colour != null && overLimit(labelPatch.colour, LIMITS.colourChars)) {
          return error("colour is too long.");
        }
        await db.prepare("UPDATE labels SET name = COALESCE(?, name), colour = COALESCE(?, colour), updated_at = ? WHERE id = ?")
          .bind(
            labelPatch.name != null ? String(labelPatch.name) : null,
            labelPatch.colour != null ? String(labelPatch.colour) : null,
            nowIso(), p.labelId
          ).run();
        if (labelPatchIcon !== undefined) {
          await db.prepare("UPDATE labels SET icon = ?, updated_at = ? WHERE id = ?")
            .bind(labelPatchIcon || null, nowIso(), p.labelId).run();
        }
        var updatedLabel = await ownerLabel(db, owner.id, p.labelId);
        return json({ label: { id: updatedLabel.id, boardId: updatedLabel.board_id, name: updatedLabel.name, icon: updatedLabel.icon || "", colour: updatedLabel.colour } });
      }
      if (method === "DELETE") {
        await db.prepare("DELETE FROM labels WHERE id = ? AND board_id = ?")
          .bind(p.labelId, theLabel.board_id).run();
        return json({ ok: true });
      }
    }

    // Projects. Deleting a project drops its cards back to no project
    // through the schema's ON DELETE SET NULL.
    if ((p = match(parts, ["api", "projects"]))) {
      if (method === "POST") {
        var projectBody = await readBody(request);
        if (!projectBody || !projectBody.board_id || !projectBody.name || !String(projectBody.name).trim()) {
          return error("board_id and name are required.");
        }
        if (overLimit(String(projectBody.name).trim(), LIMITS.nameChars)) {
          return error("name is too long.");
        }
        if (!(await ownerBoard(db, owner.id, String(projectBody.board_id)))) {
          return error("Board not found.", 404);
        }
        var projectIconIn = bodyIcon(projectBody);
        if (projectIconIn === null) return error("icon must be a single emoji.");
        var projectCount = await db.prepare("SELECT COUNT(*) AS count FROM projects WHERE board_id = ?")
          .bind(String(projectBody.board_id)).first();
        if (countOf(projectCount) >= LIMITS.projectsPerBoard) {
          return error("That is as many projects as one board holds.", 400);
        }
        // A project carries a name and an icon, nothing more:
        // the colour it once carried is gone from the contract
        // (issue #94). The column rests in the schema, unread.
        var projectRow = {
          id: newId("proj"),
          board_id: String(projectBody.board_id),
          name: String(projectBody.name).trim(),
          icon: projectIconIn || null,
          created_at: nowIso()
        };
        await db.prepare("INSERT INTO projects (id, board_id, name, icon, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(projectRow.id, projectRow.board_id, projectRow.name, projectRow.icon, projectRow.created_at).run();
        return json({ project: { id: projectRow.id, boardId: projectRow.board_id, name: projectRow.name, icon: projectRow.icon || "" } }, 201);
      }
    }

    if ((p = match(parts, ["api", "projects", ":projectId"]))) {
      var theProject = await ownerProject(db, owner.id, p.projectId);
      if (!theProject) return error("Project not found.", 404);
      if (method === "PATCH") {
        var projectPatch = await readBody(request);
        if (!projectPatch) return error("JSON body is required.");
        // Every field is judged before any write, here as in
        // every PATCH handler.
        var projectPatchIcon = bodyIcon(projectPatch);
        if (projectPatchIcon === null) return error("icon must be a single emoji.");
        if (projectPatch.name != null) {
          if (!String(projectPatch.name).trim()) return error("name is required.");
          if (overLimit(String(projectPatch.name).trim(), LIMITS.nameChars)) return error("name is too long.");
        }
        await db.prepare("UPDATE projects SET name = COALESCE(?, name) WHERE id = ?")
          .bind(
            projectPatch.name != null ? String(projectPatch.name) : null,
            p.projectId
          ).run();
        if (projectPatchIcon !== undefined) {
          await db.prepare("UPDATE projects SET icon = ? WHERE id = ?")
            .bind(projectPatchIcon || null, p.projectId).run();
        }
        var updatedProject = await ownerProject(db, owner.id, p.projectId);
        return json({ project: { id: updatedProject.id, boardId: updatedProject.board_id, name: updatedProject.name, icon: updatedProject.icon || "" } });
      }
      if (method === "DELETE") {
        await db.prepare("DELETE FROM projects WHERE id = ? AND board_id = ?")
          .bind(p.projectId, theProject.board_id).run();
        return json({ ok: true });
      }
    }

    // Cards.
    if ((p = match(parts, ["api", "cards"]))) {
      if (method === "POST") {
        var cardBody = await readBody(request);
        if (!cardBody || !cardBody.board_id || !cardBody.column_id || !cardBody.title || !String(cardBody.title).trim()) {
          return error("board_id, column_id and title are required.");
        }
        var cardBoard = await ownerBoard(db, owner.id, String(cardBody.board_id));
        if (!cardBoard) return error("Board not found.", 404);
        var cardColumn = await columnForBoard(db, cardBoard.id, String(cardBody.column_id));
        if (!cardColumn) return error("column_id does not belong to this board.");
        var cardLabelIds = [];
        if (Object.prototype.hasOwnProperty.call(cardBody, "labels")) {
          cardLabelIds = await labelIdsForBoard(db, cardBoard.id, cardBody.labels);
          if (cardLabelIds === undefined) return error("labels must be labels on this board.");
        }
        // The Important flag is a single boolean, nothing more:
        // a card is flagged or it is not, and anything that is
        // not a boolean is refused rather than guessed at.
        if (Object.prototype.hasOwnProperty.call(cardBody, "important") && typeof cardBody.important !== "boolean") {
          return error("important must be true or false.");
        }
        // A due date is a real calendar date or no date at all.
        // Anything else is refused here rather than stored as
        // written, so no reader ever meets a date that is not one.
        if (cardBody.due_date != null && cardBody.due_date !== "" && !isRealDateString(cardBody.due_date)) {
          return error("due_date must be a real date written as YYYY-MM-DD.");
        }
        if (overLimit(String(cardBody.title).trim(), LIMITS.titleChars)) {
          return error("title is too long.");
        }
        if (cardBody.notes != null && overLimit(cardBody.notes, LIMITS.notesChars)) {
          return error("notes are too long.");
        }
        var cardCount = await db.prepare("SELECT COUNT(*) AS count FROM cards WHERE board_id = ?")
          .bind(cardBoard.id).first();
        if (countOf(cardCount) >= LIMITS.cardsPerBoard) {
          return error("That is as many cards as one board holds.", 400);
        }
        var cardProjectId = null;
        if (cardBody.project_id) {
          var cardProject = await ownerProject(db, owner.id, String(cardBody.project_id));
          if (!cardProject || cardProject.board_id !== cardBoard.id) {
            return error("project_id does not belong to this board.");
          }
          cardProjectId = cardProject.id;
        }
        // The card's next step (issue #119). Unnamed, it starts
        // with its maker: a person's card is the person's step,
        // a key's card is that key's step, and neither waits —
        // the maker holds it by making it. Named, next_step is
        // judged like any hand-over: "owner", "none" or one of
        // the owner's live keys by id, and a step handed to
        // someone other than the maker waits for its pickup.
        var createStep = callerKey
          ? { holder: "agent", keyId: callerKey.id, keyName: callerKey.name }
          : { holder: "owner", keyId: null, keyName: null };
        var createStepColumns = null;
        if (Object.prototype.hasOwnProperty.call(cardBody, "next_step")) {
          var createTarget = await stepTargetFor(db, owner.id, cardBody.next_step);
          if (createTarget === undefined) {
            return error("next_step must be \"owner\", \"none\" or the id of one of the owner's keys.");
          }
          if (!sameStepTarget(createTarget, createStep)) {
            createStepColumns = handoverColumns(null, createTarget, callerKey, nowIso());
          }
          createStep = createTarget;
        }
        if (!createStepColumns) {
          createStepColumns = {
            step_holder: createStep.holder,
            step_key_id: createStep.keyId,
            step_key_name: null,
            step_handed_at: null,
            step_handed_by_key_id: null,
            step_handed_by_key_name: null,
            step_waiting: 0
          };
        }
        var maxCard = await db.prepare(
          "SELECT MAX(position) AS maxp FROM cards WHERE board_id = ? AND column_id = ? AND archived = 0"
        ).bind(cardBoard.id, cardColumn.id).first();
        var cardRow = {
          id: newId("card"),
          board_id: cardBoard.id,
          column_id: cardColumn.id,
          project_id: cardProjectId,
          title: String(cardBody.title).trim(),
          notes: cardBody.notes ? String(cardBody.notes) : "",
          due_date: cardBody.due_date ? String(cardBody.due_date) : null,
          position: maxCard && maxCard.maxp != null ? Number(maxCard.maxp) + 1 : 0,
          archived: 0,
          important: cardBody.important ? 1 : 0,
          // The creator stamp: the id of the key that is making
          // this card, or nothing when a person is making it in
          // the app (issue #50). The name is never stored — it
          // resolves from the key's record as the card is read
          // (issue #121).
          creator_key_id: callerKey ? callerKey.id : null,
          creator_key_name: null,
          step_holder: createStepColumns.step_holder,
          step_key_id: createStepColumns.step_key_id,
          step_key_name: createStepColumns.step_key_name,
          step_handed_at: createStepColumns.step_handed_at,
          step_handed_by_key_id: createStepColumns.step_handed_by_key_id,
          step_handed_by_key_name: createStepColumns.step_handed_by_key_name,
          step_waiting: createStepColumns.step_waiting,
          created_at: nowIso(),
          updated_at: nowIso()
        };
        // The card and its label rows land as one batch.
        var cardStatements = [
          db.prepare("INSERT INTO cards (id, board_id, column_id, project_id, title, notes, due_date, position, archived, important, creator_key_id, creator_key_name, step_holder, step_key_id, step_key_name, step_handed_at, step_handed_by_key_id, step_handed_by_key_name, step_waiting, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(cardRow.id, cardRow.board_id, cardRow.column_id, cardRow.project_id, cardRow.title, cardRow.notes, cardRow.due_date, cardRow.position, cardRow.archived, cardRow.important, cardRow.creator_key_id, cardRow.creator_key_name, cardRow.step_holder, cardRow.step_key_id, cardRow.step_key_name, cardRow.step_handed_at, cardRow.step_handed_by_key_id, cardRow.step_handed_by_key_name, cardRow.step_waiting, cardRow.created_at, cardRow.updated_at)
        ];
        for (var csi = 0; csi < cardLabelIds.length; csi++) {
          cardStatements.push(db.prepare("INSERT INTO card_labels (card_id, label_id) VALUES (?, ?)")
            .bind(cardRow.id, cardLabelIds[csi]));
        }
        await batchRun(db, cardStatements);
        var kindMap = {};
        kindMap[cardColumn.id] = columnKind(cardColumn);
        var createKeyNames = await keyNameMap(db, owner.id);
        return json({ card: cardOut(cardRow, kindMap, [], [], await labelsForCard(db, cardRow.id), [], effectiveName(owner), createKeyNames, keyIdsByName(createKeyNames)) }, 201);
      }
    }

    if ((p = match(parts, ["api", "cards", ":cardId"]))) {
      var cardBefore = await ownerCardRow(db, owner.id, p.cardId);
      if (!cardBefore) return error("Card not found.", 404);
      if (method === "PATCH") {
        var cardPatch = await readBody(request);
        if (!cardPatch) return error("JSON body is required.");
        var has = function (key) { return Object.prototype.hasOwnProperty.call(cardPatch, key); };
        if (has("important") && typeof cardPatch.important !== "boolean") {
          return error("important must be true or false.");
        }
        if (has("due_date") && cardPatch.due_date != null && cardPatch.due_date !== "" && !isRealDateString(cardPatch.due_date)) {
          return error("due_date must be a real date written as YYYY-MM-DD.");
        }
        // Field lengths are judged up front with the rest, before
        // any write below.
        if (has("title")) {
          if (!String(cardPatch.title == null ? "" : cardPatch.title).trim()) {
            return error("title is required.");
          }
          if (overLimit(String(cardPatch.title).trim(), LIMITS.titleChars)) {
            return error("title is too long.");
          }
        }
        if (has("notes") && overLimit(cardPatch.notes, LIMITS.notesChars)) {
          return error("notes are too long.");
        }

        // The card's next step (issue #119), judged with the
        // rest before any write. The columns the update below
        // writes start from the step as it stands, with this
        // caller's pickup applied — a write by the holder to a
        // waiting card is the pickup, whatever else the write
        // carries. A next_step naming a different holder is a
        // hand-over and replaces them: it stamps the moment and
        // the hander, and the card waits again — unless the
        // hand-over is to the caller themselves or to no one.
        // A next_step naming the holder the card already has
        // changes nothing. Archiving the card clears the step
        // whole: no holder, no waiting, no hand-over record.
        var patchStepColumns = stepColumnsKept(cardBefore, callerKey);
        if (has("next_step")) {
          var patchTarget = await stepTargetFor(db, owner.id, cardPatch.next_step);
          if (patchTarget === undefined) {
            return error("next_step must be \"owner\", \"none\" or the id of one of the owner's keys.");
          }
          var beforeStep = stepOf(cardBefore);
          var beforeTarget = { holder: beforeStep.holder, keyId: beforeStep.keyId, keyName: beforeStep.keyName };
          if (!sameStepTarget(patchTarget, beforeTarget)) {
            patchStepColumns = handoverColumns(beforeStep, patchTarget, callerKey, nowIso());
          }
        }
        if (has("archived") && cardPatch.archived) {
          patchStepColumns = {
            step_holder: "none", step_key_id: null, step_key_name: null,
            step_handed_at: null, step_handed_by_key_id: null,
            step_handed_by_key_name: null, step_waiting: 0
          };
        }
        // A comment riding this write (issue #119): it posts as
        // part of the same act, so a hand-over and the words
        // that explain it land together under one version rise.
        // Judged here like a comment on its own route: real
        // text, within the length cap and the card's count cap.
        var rideComment = null;
        if (has("comment")) {
          if (typeof cardPatch.comment !== "string" || !cardPatch.comment.trim()) {
            return error("comment must not be empty.");
          }
          rideComment = cardPatch.comment.trim();
          if (overLimit(rideComment, LIMITS.commentChars)) {
            return error("comment is too long.");
          }
          var rideCount = await db.prepare("SELECT COUNT(*) AS count FROM card_comments WHERE card_id = ?")
            .bind(cardBefore.id).first();
          if (countOf(rideCount) >= LIMITS.commentsPerCard) {
            return error("That is as many comments as one card holds.", 400);
          }
        }

        // A board move is resolved first (issue #163). The move
        // is judged whole, before anything is written: the board
        // must be the caller's, it must have room for one more
        // card, and the column and project the call names must
        // stand on it. Columns are each board's own, so with no
        // column named the card lands by position: in the target
        // board's column at the same place counting from the left
        // as the column it leaves, or in the target board's last
        // column when that board has fewer.
        var nextBoardId = cardBefore.board_id;
        var nextColumnId = cardBefore.column_id;
        var boardChanged = false;
        if (has("board_id") && cardPatch.board_id != null && String(cardPatch.board_id) !== cardBefore.board_id) {
          var targetBoard = await ownerBoard(db, owner.id, String(cardPatch.board_id));
          if (!targetBoard) return error("board_id does not belong to this caller.");
          var destCount = await db.prepare("SELECT COUNT(*) AS count FROM cards WHERE board_id = ?")
            .bind(targetBoard.id).first();
          if (countOf(destCount) >= LIMITS.cardsPerBoard) {
            return error("That is as many cards as one board holds.", 400);
          }
          var fromColumn = await ownerColumn(db, owner.id, cardBefore.column_id);
          var targetColumn = null;
          if (fromColumn) {
            var fromColumns = await boardColumns(db, cardBefore.board_id);
            var fromIndex = -1;
            for (var fi = 0; fi < fromColumns.length; fi++) {
              if (fromColumns[fi].id === fromColumn.id) fromIndex = fi;
            }
            var targetColumns = await boardColumns(db, targetBoard.id);
            if (targetColumns.length) {
              var landIndex = fromIndex < 0 ? 0 : Math.min(fromIndex, targetColumns.length - 1);
              targetColumn = targetColumns[landIndex];
            }
          }
          if (!targetColumn) return error("The new board has no column to land in.");
          nextBoardId = targetBoard.id;
          nextColumnId = targetColumn.id;
          boardChanged = true;
        }
        if (has("column_id") && cardPatch.column_id != null) {
          var movedColumn = await columnForBoard(db, nextBoardId, String(cardPatch.column_id));
          if (!movedColumn) return error("column_id does not belong to this card's board.");
          nextColumnId = movedColumn.id;
        }

        // On a board move the card's labels cross by name
        // (issue #163): the server works the mapping out from the
        // card's labels as they stand, and a labels list in the
        // same call is not read. Without a board move, a labels
        // list replaces the card's whole set, and every id in it
        // must belong to the card's board or the whole write is
        // refused.
        var labelsChange = boardChanged;
        var nextLabelIds = boardChanged
          ? await labelIdsByNameForMove(db, cardBefore.id, nextBoardId)
          : null;
        if (has("labels") && !boardChanged) {
          nextLabelIds = await labelIdsForBoard(db, nextBoardId, cardPatch.labels);
          if (nextLabelIds === undefined) return error("labels must be labels on this card's board.");
          labelsChange = true;
        }
        // The project follows the same shape (issue #163): a
        // project_id the call names must stand on the destination
        // board, and a move naming none takes the destination's
        // project with the same name as the card's, or none.
        var nextProjectId = cardBefore.project_id;
        if (boardChanged) {
          if (has("project_id")) {
            if (cardPatch.project_id == null) {
              nextProjectId = null;
            } else {
              var movedProject = await ownerProject(db, owner.id, String(cardPatch.project_id));
              if (!movedProject || movedProject.board_id !== nextBoardId) {
                return error("project_id does not belong to this card's board.");
              }
              nextProjectId = movedProject.id;
            }
          } else {
            nextProjectId = await projectIdByNameForMove(db, cardBefore.project_id, nextBoardId);
          }
        } else if (has("project_id")) {
          if (cardPatch.project_id == null) {
            nextProjectId = null;
          } else {
            var nextProject = await ownerProject(db, owner.id, String(cardPatch.project_id));
            if (!nextProject || nextProject.board_id !== nextBoardId) {
              return error("project_id does not belong to this card's board.");
            }
            nextProjectId = nextProject.id;
          }
        }

        // A position in the body is not a stored value: it is the
        // place the card takes in its column, counting from the
        // top starting at 0, the way a column's position names its
        // place on its board. The update below leaves the stored
        // position alone and placeCardAtIndex writes the column's
        // whole run once the card stands in its new column.
        var wantsPosition = has("position") && cardPatch.position != null;

        await db.prepare(
          "UPDATE cards SET board_id = ?, column_id = ?, project_id = ?, " +
          "title = COALESCE(?, title), notes = COALESCE(?, notes), due_date = ?, " +
          "position = COALESCE(?, position), archived = COALESCE(?, archived), important = COALESCE(?, important), " +
          "step_holder = ?, step_key_id = ?, step_key_name = ?, step_handed_at = ?, " +
          "step_handed_by_key_id = ?, step_handed_by_key_name = ?, step_waiting = ?, updated_at = ? WHERE id = ?"
        ).bind(
          nextBoardId,
          nextColumnId,
          nextProjectId,
          has("title") ? String(cardPatch.title) : null,
          has("notes") ? String(cardPatch.notes) : null,
          has("due_date") ? (cardPatch.due_date ? String(cardPatch.due_date) : null) : cardBefore.due_date,
          null,
          has("archived") ? (cardPatch.archived ? 1 : 0) : null,
          has("important") ? (cardPatch.important ? 1 : 0) : null,
          patchStepColumns.step_holder,
          patchStepColumns.step_key_id,
          patchStepColumns.step_key_name,
          patchStepColumns.step_handed_at,
          patchStepColumns.step_handed_by_key_id,
          patchStepColumns.step_handed_by_key_name,
          patchStepColumns.step_waiting,
          nowIso(),
          p.cardId
        ).run();
        if (labelsChange) await setCardLabels(db, p.cardId, nextLabelIds);
        // The riding comment posts inside the same write, after
        // the card itself stands updated, stamped with its
        // author the way a comment on its own route is.
        if (rideComment !== null) {
          await db.prepare("INSERT INTO card_comments (id, card_id, body, author_key_id, author_key_name, author_owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(newId("comment"), p.cardId, rideComment,
              callerKey ? callerKey.id : null, null,
              callerKey ? null : owner.id, nowIso()).run();
        }
        var cardAfter = await ownerCardRow(db, owner.id, p.cardId);
        // The placement runs last, against the card's final board
        // and column. An archived card stands outside its column's
        // run, so a card this call archives — or one already
        // archived — keeps the position it had.
        if (wantsPosition && !cardAfter.archived) {
          await placeCardAtIndex(db, cardBefore, cardAfter, cardPatch.position);
          cardAfter = await ownerCardRow(db, owner.id, p.cardId);
        }
        // A board move that names no place lands at the end of
        // its new column (issue #163), the way a new card does.
        if (boardChanged && !wantsPosition && !cardAfter.archived) {
          await placeCardAtIndex(db, cardBefore, cardAfter, Number.MAX_SAFE_INTEGER);
          cardAfter = await ownerCardRow(db, owner.id, p.cardId);
        }
        var afterColumns = (await db.prepare(
          'SELECT * FROM "columns" WHERE board_id = ?'
        ).bind(cardAfter.board_id).all()).results;
        var afterKinds = {};
        afterColumns.forEach(function (row) { afterKinds[row.id] = columnKind(row); });
        var answerKeyNames = await keyNameMap(db, owner.id);
        return json({ card: cardOut(cardAfter, afterKinds, await stepsForCard(db, cardAfter.id), await linksForCard(db, cardAfter.id), await labelsForCard(db, cardAfter.id), await commentsForCard(db, cardAfter.id, effectiveName(owner), answerKeyNames), effectiveName(owner), answerKeyNames, keyIdsByName(answerKeyNames)) });
      }
      if (method === "DELETE") {
        await db.prepare("DELETE FROM cards WHERE id = ? AND board_id = ?")
          .bind(p.cardId, cardBefore.board_id).run();
        return json({ ok: true });
      }
    }

    // Checklist steps. A step belongs to its card the way the card's
    // notes do: it survives column moves, board moves, archiving and
    // unarchiving, and deleting the card deletes its steps through
    // the schema's cascade. A step carries text and a done flag,
    // nothing else. Its place in the card's list is its position,
    // and a PATCH that sends a new position moves it there.
    if ((p = match(parts, ["api", "cards", ":cardId", "steps"]))) {
      var stepCard = await ownerCardRow(db, owner.id, p.cardId);
      if (!stepCard) return error("Card not found.", 404);
      if (method === "POST") {
        var stepBody = await readBody(request);
        if (!stepBody || !stepBody.text || !String(stepBody.text).trim()) {
          return error("text is required.");
        }
        if (overLimit(String(stepBody.text).trim(), LIMITS.stepChars)) {
          return error("text is too long.");
        }
        var stepCount = await db.prepare("SELECT COUNT(*) AS count FROM checklist_items WHERE card_id = ?")
          .bind(stepCard.id).first();
        if (countOf(stepCount) >= LIMITS.stepsPerCard) {
          return error("That is as many steps as one card holds.", 400);
        }
        var maxStep = await db.prepare(
          "SELECT MAX(position) AS maxp FROM checklist_items WHERE card_id = ?"
        ).bind(stepCard.id).first();
        var stepRow = {
          id: newId("step"),
          card_id: stepCard.id,
          text: String(stepBody.text).trim(),
          done: stepBody.done ? 1 : 0,
          position: maxStep && maxStep.maxp != null ? Number(maxStep.maxp) + 1 : 0,
          created_at: nowIso(),
          updated_at: nowIso()
        };
        await db.prepare("INSERT INTO checklist_items (id, card_id, text, done, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(stepRow.id, stepRow.card_id, stepRow.text, stepRow.done, stepRow.position, stepRow.created_at, stepRow.updated_at).run();
        await noteCardPickup(db, stepCard, callerKey);
        return json({ step: stepOut(stepRow) }, 201);
      }
    }

    if ((p = match(parts, ["api", "cards", ":cardId", "steps", ":stepId"]))) {
      var itemCard = await ownerCardRow(db, owner.id, p.cardId);
      if (!itemCard) return error("Card not found.", 404);
      var theStep = await ownerChecklistItem(db, owner.id, p.cardId, p.stepId);
      if (!theStep) return error("Step not found.", 404);
      if (method === "PATCH") {
        var stepPatch = await readBody(request);
        if (!stepPatch) return error("JSON body is required.");
        var stepHas = function (key) { return Object.prototype.hasOwnProperty.call(stepPatch, key); };
        var nextText = theStep.text;
        if (stepHas("text")) {
          nextText = String(stepPatch.text).trim();
          if (!nextText) return error("text is required.");
          if (overLimit(nextText, LIMITS.stepChars)) return error("text is too long.");
        }
        var nextDone = stepHas("done") ? (stepPatch.done ? 1 : 0) : theStep.done;
        // A position in the body is not a stored value: it is the
        // place the step takes in its card's list, counting from
        // the top starting at 0, the way a card's position names
        // its place in its column. The update below leaves the
        // stored position alone and placeStepAtIndex writes the
        // list's whole run once the step stands in its new place.
        var wantsStepPosition = stepHas("position") && stepPatch.position != null;
        await db.prepare("UPDATE checklist_items SET text = ?, done = ?, updated_at = ? WHERE id = ?")
          .bind(nextText, nextDone, nowIso(), p.stepId).run();
        var updatedStep = await ownerChecklistItem(db, owner.id, p.cardId, p.stepId);
        if (wantsStepPosition) {
          await placeStepAtIndex(db, p.cardId, updatedStep, stepPatch.position);
          updatedStep = await ownerChecklistItem(db, owner.id, p.cardId, p.stepId);
        }
        await noteCardPickup(db, itemCard, callerKey);
        return json({ step: stepOut(updatedStep) });
      }
      if (method === "DELETE") {
        await db.prepare("DELETE FROM checklist_items WHERE id = ? AND card_id = ?")
          .bind(p.stepId, p.cardId).run();
        await noteCardPickup(db, itemCard, callerKey);
        return json({ ok: true });
      }
    }

    // Links. A link belongs to its card the way a checklist step
    // does: it survives column moves, board moves, archiving and
    // unarchiving, and deleting the card deletes its links through
    // the schema's cascade. A link carries a web address and an
    // optional name, nothing else, and links stay in the order they
    // were added. Addresses are stored cleaned to an absolute http
    // or https address (see cleanLinkUrl); anything else is refused
    // here on the server, whichever door the call came through.
    if ((p = match(parts, ["api", "cards", ":cardId", "links"]))) {
      var linkCard = await ownerCardRow(db, owner.id, p.cardId);
      if (!linkCard) return error("Card not found.", 404);
      if (method === "POST") {
        var linkBody = await readBody(request);
        if (!linkBody) return error("JSON body is required.");
        var newLinkUrl = cleanLinkUrl(linkBody.url);
        if (!newLinkUrl) return error("url must be an http or https address.");
        if (overLimit(newLinkUrl, LIMITS.linkUrlChars)) return error("url is too long.");
        if (linkBody.name != null && overLimit(String(linkBody.name).trim(), LIMITS.linkNameChars)) {
          return error("name is too long.");
        }
        var linkCount = await db.prepare("SELECT COUNT(*) AS count FROM card_links WHERE card_id = ?")
          .bind(linkCard.id).first();
        if (countOf(linkCount) >= LIMITS.linksPerCard) {
          return error("That is as many links as one card holds.", 400);
        }
        var maxLink = await db.prepare(
          "SELECT MAX(position) AS maxp FROM card_links WHERE card_id = ?"
        ).bind(linkCard.id).first();
        var linkRow = {
          id: newId("link"),
          card_id: linkCard.id,
          url: newLinkUrl,
          name: linkBody.name ? String(linkBody.name).trim() : "",
          position: maxLink && maxLink.maxp != null ? Number(maxLink.maxp) + 1 : 0,
          created_at: nowIso(),
          updated_at: nowIso()
        };
        await db.prepare("INSERT INTO card_links (id, card_id, url, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(linkRow.id, linkRow.card_id, linkRow.url, linkRow.name, linkRow.position, linkRow.created_at, linkRow.updated_at).run();
        await noteCardPickup(db, linkCard, callerKey);
        return json({ link: linkOut(linkRow) }, 201);
      }
    }

    if ((p = match(parts, ["api", "cards", ":cardId", "links", ":linkId"]))) {
      var linkItemCard = await ownerCardRow(db, owner.id, p.cardId);
      if (!linkItemCard) return error("Card not found.", 404);
      var theLink = await ownerCardLink(db, owner.id, p.cardId, p.linkId);
      if (!theLink) return error("Link not found.", 404);
      if (method === "PATCH") {
        var linkPatch = await readBody(request);
        if (!linkPatch) return error("JSON body is required.");
        var linkHas = function (key) { return Object.prototype.hasOwnProperty.call(linkPatch, key); };
        var nextLinkUrl = theLink.url;
        if (linkHas("url")) {
          nextLinkUrl = cleanLinkUrl(linkPatch.url);
          if (!nextLinkUrl) return error("url must be an http or https address.");
          if (overLimit(nextLinkUrl, LIMITS.linkUrlChars)) return error("url is too long.");
        }
        var nextLinkName = linkHas("name")
          ? String(linkPatch.name == null ? "" : linkPatch.name).trim()
          : theLink.name;
        if (overLimit(nextLinkName, LIMITS.linkNameChars)) return error("name is too long.");
        await db.prepare("UPDATE card_links SET url = ?, name = ?, updated_at = ? WHERE id = ?")
          .bind(nextLinkUrl, nextLinkName, nowIso(), p.linkId).run();
        var updatedLink = await ownerCardLink(db, owner.id, p.cardId, p.linkId);
        await noteCardPickup(db, linkItemCard, callerKey);
        return json({ link: linkOut(updatedLink) });
      }
      if (method === "DELETE") {
        await db.prepare("DELETE FROM card_links WHERE id = ? AND card_id = ?")
          .bind(p.linkId, p.cardId).run();
        await noteCardPickup(db, linkItemCard, callerKey);
        return json({ ok: true });
      }
    }

    // Comments. A comment belongs to its card the way a checklist
    // step does: it survives column moves, board moves, archiving
    // and unarchiving, and deleting the card deletes its comments
    // through the schema's cascade. A comment carries its body and
    // its author as an identity: the key that wrote it, or the
    // person (issue #51) — never a stored name, so the name a
    // comment reads with is its author's current one and every
    // comment says who made it (issue #120).
    // Comments read back in the order they were written, as part
    // of the card; there is no edit — a comment is removed whole
    // or stands as it was written.
    if ((p = match(parts, ["api", "cards", ":cardId", "comments"]))) {
      var commentCard = await ownerCardRow(db, owner.id, p.cardId);
      if (!commentCard) return error("Card not found.", 404);
      if (method === "POST") {
        var commentBody = await readBody(request);
        if (!commentBody || commentBody.body == null || !String(commentBody.body).trim()) {
          return error("body is required.");
        }
        var cleanCommentBody = String(commentBody.body).trim();
        if (overLimit(cleanCommentBody, LIMITS.commentChars)) {
          return error("body is too long.");
        }
        var commentCount = await db.prepare("SELECT COUNT(*) AS count FROM card_comments WHERE card_id = ?")
          .bind(commentCard.id).first();
        if (countOf(commentCount) >= LIMITS.commentsPerCard) {
          return error("That is as many comments as one card holds.", 400);
        }
        var commentRow = {
          id: newId("comment"),
          card_id: commentCard.id,
          body: cleanCommentBody,
          author_key_id: callerKey ? callerKey.id : null,
          author_key_name: null,
          author_owner_id: callerKey ? null : owner.id,
          created_at: nowIso()
        };
        await db.prepare("INSERT INTO card_comments (id, card_id, body, author_key_id, author_key_name, author_owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(commentRow.id, commentRow.card_id, commentRow.body, commentRow.author_key_id, commentRow.author_key_name, commentRow.author_owner_id, commentRow.created_at).run();
        await noteCardPickup(db, commentCard, callerKey);
        var commentKeyNames = {};
        if (callerKey) commentKeyNames[callerKey.id] = callerKey.name;
        return json({ comment: commentOut(commentRow, effectiveName(owner), commentKeyNames) }, 201);
      }
    }

    if ((p = match(parts, ["api", "cards", ":cardId", "comments", ":commentId"]))) {
      var commentItemCard = await ownerCardRow(db, owner.id, p.cardId);
      if (!commentItemCard) return error("Card not found.", 404);
      var theComment = await ownerCardComment(db, owner.id, p.cardId, p.commentId);
      if (!theComment) return error("Comment not found.", 404);
      if (method === "DELETE") {
        await db.prepare("DELETE FROM card_comments WHERE id = ? AND card_id = ?")
          .bind(p.commentId, p.cardId).run();
        await noteCardPickup(db, commentItemCard, callerKey);
        return json({ ok: true });
      }
    }

    // --- The sign-in routes (issue #109) -------------------------------------
    // The account system's own surface: the person's passkeys,
    // password and sessions, and the administrator's People
    // surface with the claim flow. These routes answer only a
    // person's account session — never a key (the design's
    // section 10 rule: a key gets a 403 on every auth-management
    // route and can never be exchanged for a session), and never
    // the transition door's token, which speaks for boards, not
    // for the doors themselves.
    if (parts[1] === "auth") {
      var authDb2 = deps.authDb || deps.db;
      var authCfg = deps.auth || {};
      var source = typeof authCfg.sourceOf === "function"
        ? authCfg.sourceOf(request) : "unknown";
      var sourceCapMs = Number(authCfg.sourceCapMs) || 15 * 60 * 1000;
      var reqUrl = new URL(request.url);
      var secureCookie = reqUrl.protocol === "https:";

      if (via !== "account" || !caller || !caller.account) {
        return error("The sign-in routes are the person's own, in the signed-in app under Settings.", 403);
      }
      var account = caller.account;
      var session = caller.session;

      var withCookie = function (response, token) {
        response.headers.set("Set-Cookie", sessionCookieValue(token, secureCookie));
        return response;
      };
      // Verifies a password against the caller's account,
      // rehashing on a successful legacy or out-of-date proof,
      // the way the sign-in page's check does.
      var checkOwnPassword = async function (password) {
        var result = await verifyPassword(account.password_hash, password);
        if (result.ok && (result.legacy || !isCurrentHash(account.password_hash))) {
          var upgraded = await hashPassword(password);
          await authDb2.prepare("UPDATE accounts SET password_hash = ? WHERE key = ?")
            .bind(upgraded, account.key).run();
          account.password_hash = upgraded;
        }
        return result.ok;
      };
      // The step-up state for the guarded acts: a full proof
      // within the last ten minutes, and — once the account
      // holds a passkey — that proof must be a passkey for
      // enrolment (determination 2: passkey guards passkey).
      // Enrolment alone also takes a fresh emailed link's
      // proof: where a deployment's door signs people in by
      // an emailed link, the link is the full proof — the
      // spend that began the session is the sign-in itself —
      // and a passkey enrolled at one of the deployment's
      // addresses can never answer a proof tap at another,
      // so demanding one would close the very offer the link
      // lands on. A copy whose door mints no link proofs has
      // no session that can carry one, and its rule stands
      // exactly as it was.
      var stepUpState = async function (forEnrolment) {
        var held = await countPasskeys(authDb2, account.key);
        var fresh = !!session &&
          (Date.now() - Number(session.proof_at || 0) <= PROOF_FRESH_MS);
        var needs = held.count > 0 ? "passkey" : "any";
        var ok = fresh && (needs === "any" || session.proof_via === "passkey" ||
          (forEnrolment && session.proof_via === "email"));
        return { ok: ok, needs: needs, held: held.count };
      };
      var stepUpRefusal = function (needs) {
        return json({
          error: needs === "passkey"
            ? "This account holds a passkey, so adding another takes a passkey tap first."
            : "That needs a fresh proof first: type your password, or tap a passkey.",
          stepUp: needs
        }, 403);
      };

      // Who the caller is, on the door itself: the Account
      // page's passkey list and the app's linked-or-waiting
      // decision both read this.
      if ((p = match(parts, ["api", "auth", "me"]))) {
        if (method === "GET") {
          var myPasskeys = await listPasskeys(authDb2, account.key);
          return json({
            key: account.key,
            name: account.name,
            admin: !!account.admin,
            linked: !!owner,
            hasPassword: !!account.password_hash,
            passwordsAllowed: takePasswords,
            proofAt: session ? Number(session.proof_at || 0) : null,
            proofVia: session ? session.proof_via : null,
            passkeys: myPasskeys.map(function (row) {
              return {
                id: row.credential_id, nickname: row.nickname || "",
                createdAt: Number(row.created_at), rpHome: row.rp_home || "",
                lastUsedAt: row.last_used_at ? Number(row.last_used_at) : null
              };
            })
          });
        }
      }

      // A fresh proof by password: the step-up the guarded
      // acts ask for. A miss counts on the throttle like a
      // sign-in miss; a hit stamps the session (rotating its
      // token) and clears the pair's record.
      if ((p = match(parts, ["api", "auth", "proof", "password"]))) {
        if (method === "POST") {
          if (await throttleLocked(authDb2, source, account.key)) {
            return error("Too many tries. Wait a little, then try again.", 429);
          }
          var proofBody = await readBody(request);
          var proofOk = proofBody && await checkOwnPassword(proofBody.password || "");
          if (!proofOk) {
            await noteThrottleFailure(authDb2, source, account.key, sourceCapMs);
            return error("That password did not match.", 401);
          }
          await clearThrottle(authDb2, source, account.key);
          var stamped = await stampProof(authDb2, session, "password");
          return withCookie(json({ ok: true }), stamped.token);
        }
      }

      // A fresh proof by passkey: the challenge, then the tap.
      if ((p = match(parts, ["api", "auth", "proof", "passkey", "options"]))) {
        if (method === "POST") {
          if (await throttleLocked(authDb2, source, account.key)) {
            return error("Too many tries. Wait a little, then try again.", 429);
          }
          var myCreds = await listPasskeys(authDb2, account.key);
          if (!myCreds.length) return error("This account holds no passkey.", 400);
          var proofChallenge = await issueChallenge(authDb2, "assert", account.key);
          return json({
            challenge: proofChallenge.challengeB64u,
            rpId: reqUrl.hostname,
            timeout: CHALLENGE_MS,
            userVerification: "required",
            allowCredentials: myCreds.map(function (row) {
              return { id: row.credential_id, type: "public-key" };
            })
          });
        }
      }
      if ((p = match(parts, ["api", "auth", "proof", "passkey", "verify"]))) {
        if (method === "POST") {
          var proofVerifyBody = await readBody(request);
          var proofRefused = error("That passkey tap did not prove you.", 401);
          if (!proofVerifyBody || !proofVerifyBody.response || !proofVerifyBody.response.id) {
            return proofRefused;
          }
          var proofPasskey = await getPasskey(authDb2, proofVerifyBody.response.id);
          if (!proofPasskey || proofPasskey.account_key !== account.key) {
            await noteThrottleFailure(authDb2, source, account.key, sourceCapMs);
            return proofRefused;
          }
          var proofClientChallenge = null;
          try {
            var proofClientData = JSON.parse(new TextDecoder().decode(
              b64uDecode(proofVerifyBody.response.response.clientDataJSON || "")));
            proofClientChallenge = proofClientData.challenge;
          } catch (e) { proofClientChallenge = null; }
          if (!proofClientChallenge ||
              !(await spendChallenge(authDb2, proofClientChallenge, "assert", account.key))) {
            await noteThrottleFailure(authDb2, source, account.key, sourceCapMs);
            return proofRefused;
          }
          try {
            var proofVerified = await verifyAssertion(proofVerifyBody.response, proofPasskey, {
              challengeB64u: proofClientChallenge,
              origin: reqUrl.origin,
              rpId: reqUrl.hostname,
              userHandle: account.user_handle
            });
          } catch (e) {
            await noteThrottleFailure(authDb2, source, account.key, sourceCapMs);
            return proofRefused;
          }
          await notePasskeyUse(authDb2, proofPasskey.credential_id, proofVerified.signCount);
          await clearThrottle(authDb2, source, account.key);
          var proofStamped = await stampProof(authDb2, session, "passkey");
          return withCookie(json({ ok: true }), proofStamped.token);
        }
      }

      // Enrolling a passkey: the options, then the ceremony's
      // answer. Guarded by the step-up rule above.
      if ((p = match(parts, ["api", "auth", "passkeys", "options"]))) {
        if (method === "POST") {
          var enrolState = await stepUpState(true);
          if (!enrolState.ok) return stepUpRefusal(enrolState.needs);
          var enrolChallenge = await issueChallenge(authDb2, "enrol", account.key);
          // No exclusion list (issue #132): naming the
          // standing passkeys here makes the authenticator
          // refuse the ceremony outright when the person
          // enrols from the device that already holds one —
          // so a second enrolment from that device could
          // never complete, silently. A second credential on
          // one device is harmless: either passkey can sign
          // in, and either can be removed.
          return json({
            challenge: enrolChallenge.challengeB64u,
            rp: { id: reqUrl.hostname, name: "TaskSparkle" },
            user: {
              id: account.user_handle,
              name: account.name,
              displayName: account.name
            },
            pubKeyCredParams: [
              { type: "public-key", alg: -7 },
              { type: "public-key", alg: -8 },
              { type: "public-key", alg: -257 }
            ],
            authenticatorSelection: {
              residentKey: "required",
              requireResidentKey: true,
              userVerification: "required"
            },
            attestation: "none",
            timeout: CHALLENGE_MS
          });
        }
      }
      if ((p = match(parts, ["api", "auth", "passkeys"]))) {
        if (method === "POST") {
          var addState = await stepUpState(true);
          if (!addState.ok) return stepUpRefusal(addState.needs);
          var addBody = await readBody(request);
          if (!addBody || !addBody.response) return error("The enrolment answer is incomplete.");
          var addNickname = addBody.nickname != null ? String(addBody.nickname).trim() : "";
          if (addNickname.length > 120) return error("A passkey's name is at most 120 characters.");
          var addClientChallenge = null;
          try {
            var addClientData = JSON.parse(new TextDecoder().decode(
              b64uDecode(addBody.response.response.clientDataJSON || "")));
            addClientChallenge = addClientData.challenge;
          } catch (e) { addClientChallenge = null; }
          if (!addClientChallenge ||
              !(await spendChallenge(authDb2, addClientChallenge, "enrol", account.key))) {
            return error("That enrolment's challenge has expired or was already used. Try again.", 400);
          }
          var registered;
          try {
            registered = await verifyRegistration(addBody.response, {
              challengeB64u: addClientChallenge,
              origin: reqUrl.origin,
              rpId: reqUrl.hostname
            });
          } catch (e) {
            return error("That passkey could not be enrolled: " + e.message, 400);
          }
          if (await getPasskey(authDb2, registered.credentialId)) {
            return error("That passkey already stands on an account.", 400);
          }
          await addPasskey(authDb2, {
            credentialId: registered.credentialId,
            accountKey: account.key,
            coseBytes: registered.coseBytes,
            signCount: registered.signCount,
            transports: registered.transports,
            backedUp: registered.backedUp,
            nickname: addNickname,
            rpHome: reqUrl.hostname
          });
          await writeAudit(authDb2, account, "passkey-added", account,
            addNickname || "");
          // A passkey enrolment is a privilege change: the
          // session's token rotates with it.
          var enrolRotated = await rotateSession(authDb2, session, session.proof_via);
          var enrolResponse = withCookie(json({
            passkey: {
              id: registered.credentialId, nickname: addNickname,
              createdAt: Date.now(), rpHome: reqUrl.hostname, lastUsedAt: null
            }
          }, 201), enrolRotated.token);
          // Enrolling a passkey makes it this device's
          // sign-in view (issue #141): the answer also stands
          // the remembered-view cookie up as "passkey", the
          // way the spend enrolments' sessions do. The memory
          // still follows the person's own switches after.
          enrolResponse.headers.append("Set-Cookie",
            viewCookieValue("passkey", secureCookie));
          return enrolResponse;
        }
      }
      if ((p = match(parts, ["api", "auth", "passkeys", ":credId"]))) {
        if (method === "DELETE") {
          var ownRow = await getPasskey(authDb2, p.credId);
          if (!ownRow || ownRow.account_key !== account.key) {
            return error("Passkey not found.", 404);
          }
          // The last passkey on a passwordless account cannot
          // come off (amendment A.9, edge 1): a passwordless
          // account must always hold a passkey — that is what
          // makes its state a state and not a trapdoor. The
          // refusal names the way out in the words the person
          // can act on: their own add comes first.
          if (!account.password_hash) {
            var ownHeld = await countPasskeys(authDb2, account.key);
            if (ownHeld.count <= 1) {
              return error("That is your only passkey, and this account has no password. " +
                "Add a password first — then this removal is ordinary.", 400);
            }
          }
          var removedOwn = await removePasskey(authDb2, ownRow.credential_id, account.key);
          if (!removedOwn) return error("Passkey not found.", 404);
          await writeAudit(authDb2, account, "passkey-removed", account,
            ownRow.nickname || "");
          return json({ ok: true });
        }
      }

      // Changing the password — and, on a passwordless
      // account, adding one back (amendment A.4): a current
      // proof — the current password in the call, or a fresh
      // proof on the session — then the new password. Every
      // other session is revoked; this one is rotated and
      // stays. Passkeys are untouched by a change, deliberately:
      // the changer proved who they are, and a passkey comes
      // off an account only by a named act.
      if ((p = match(parts, ["api", "auth", "password"]))) {
        if (method === "POST") {
          if (!takePasswords) {
            return error("This copy takes no passwords. Sign in with the emailed link or a passkey.");
          }
          var pwBody = await readBody(request);
          if (!pwBody || pwBody.new_password == null) {
            return error("new_password is required.");
          }
          var pwProofVia = null;
          if (pwBody.current_password != null) {
            if (await throttleLocked(authDb2, source, account.key)) {
              return error("Too many tries. Wait a little, then try again.", 429);
            }
            if (!(await checkOwnPassword(pwBody.current_password))) {
              await noteThrottleFailure(authDb2, source, account.key, sourceCapMs);
              return error("That password did not match.", 401);
            }
            await clearThrottle(authDb2, source, account.key);
            pwProofVia = "password";
          } else if (!account.password_hash) {
            // The add (amendment A.4): on a passwordless
            // account the fresh proof this branch accepts must
            // have been a passkey proof — a fresh passkey tap
            // at the act, or the session's standing fresh proof
            // where that proof was a passkey, a passkey-first
            // spend's own stamped proof included. stepUpState
            // carries exactly that predicate: a passwordless
            // account always holds a passkey, so its need reads
            // "passkey" and nothing else satisfies it.
            var addState = await stepUpState();
            if (!addState.ok) return stepUpRefusal(addState.needs);
            pwProofVia = session ? session.proof_via : "passkey";
          } else {
            var pwState = await stepUpState();
            if (!pwState.ok && !(session &&
                Date.now() - Number(session.proof_at || 0) <= PROOF_FRESH_MS)) {
              return stepUpRefusal("any");
            }
            pwProofVia = session ? session.proof_via : "password";
          }
          var hadPassword = !!account.password_hash;
          var pwProblem = passwordProblem(pwBody.new_password, account.name);
          if (pwProblem) return error(pwProblem, 400);
          var newHash = await hashPassword(pwBody.new_password);
          await authDb2.prepare("UPDATE accounts SET password_hash = ? WHERE key = ?")
            .bind(newHash, account.key).run();
          account.password_hash = newHash;
          await revokeAccountSessions(authDb2, account.key, session.token_hash);
          var pwRotated = await rotateSession(authDb2, session, pwProofVia);
          await writeAudit(authDb2, account,
            hadPassword ? "password-changed" : "password-added", account, "");
          return withCookie(json({ ok: true }), pwRotated.token);
        }
      }

      // Removing the password (amendment A.3): the drop.
      // Offered only while a password and at least one passkey
      // stand, and proven by a fresh passkey tap — the act's
      // own claim is "my passkeys carry me now", so the proof
      // is the replacement itself, never the thing being
      // discarded: a password proof inside the window does not
      // open it. The hash goes to NULL, every other session is
      // revoked and this one rotates, the weight a password
      // change carries. Passkeys are untouched.
      if ((p = match(parts, ["api", "auth", "password", "remove"]))) {
        if (method === "POST") {
          if (!account.password_hash) {
            return error("This account holds no password to remove.", 400);
          }
          var dropState = await stepUpState();
          if (dropState.held === 0) {
            return error("Enrol a passkey first — an account must always hold a way in.", 400);
          }
          if (!dropState.ok) {
            return json({
              error: "Removing your password takes a fresh passkey tap first.",
              stepUp: "passkey"
            }, 403);
          }
          await authDb2.prepare("UPDATE accounts SET password_hash = NULL WHERE key = ?")
            .bind(account.key).run();
          account.password_hash = null;
          await revokeAccountSessions(authDb2, account.key, session.token_hash);
          var dropRotated = await rotateSession(authDb2, session, session.proof_via);
          await writeAudit(authDb2, account, "password-removed", account, "");
          return withCookie(json({ ok: true }), dropRotated.token);
        }
      }

      // Sign out everywhere: every other session of the
      // caller's ends; this one stays. The lost-phone act, for
      // one's own account.
      if ((p = match(parts, ["api", "auth", "signout-everywhere"]))) {
        if (method === "POST") {
          await revokeAccountSessions(authDb2, account.key, session.token_hash);
          await writeAudit(authDb2, account, "sign-out-everywhere", account, "own");
          return json({ ok: true });
        }
      }

      // --- The administrator's surface: People, and claims ---
      var adminRefusal = function () {
        return error("Only an administrator can do this. Ask the person who runs this copy.", 403);
      };

      if ((p = match(parts, ["api", "auth", "people"]))) {
        if (method === "GET") {
          if (!account.admin) return adminRefusal();
          var allAccounts = await listAccounts(authDb2);
          var peopleOut = [];
          for (var pai = 0; pai < allAccounts.length; pai++) {
            var personRow = allAccounts[pai];
            var heldKeys = await listPasskeys(authDb2, personRow.key);
            peopleOut.push({
              key: personRow.key,
              name: personRow.name,
              admin: !!personRow.admin,
              you: personRow.key === account.key,
              hasPassword: !!personRow.password_hash,
              linked: !!personRow.owner_id,
              passkeys: heldKeys.map(function (row) {
                return {
                  id: row.credential_id, nickname: row.nickname || "",
                  createdAt: Number(row.created_at), rpHome: row.rp_home || ""
                };
              })
            });
          }
          // The unclaimed board sets: owner rows no account
          // points at, identified by shape, never contents —
          // their board names, their card counts, when they
          // last changed. Never the address they stand under:
          // no page shows an email address (issue #114).
          var linkedOwnerIds = {};
          allAccounts.forEach(function (row) {
            if (row.owner_id) linkedOwnerIds[row.owner_id] = true;
          });
          var allOwners = (await db.prepare("SELECT * FROM owners ORDER BY created_at").all()).results;
          var unclaimedOut = [];
          for (var uo = 0; uo < allOwners.length; uo++) {
            var unclaimedOwner = allOwners[uo];
            if (linkedOwnerIds[unclaimedOwner.id]) continue;
            var setBoards = (await db.prepare(
              "SELECT name FROM boards WHERE owner_id = ? ORDER BY position, created_at"
            ).bind(unclaimedOwner.id).all()).results;
            var setCards = await db.prepare(
              "SELECT COUNT(*) AS n FROM cards JOIN boards ON boards.id = cards.board_id " +
              "WHERE boards.owner_id = ?"
            ).bind(unclaimedOwner.id).first();
            unclaimedOut.push({
              ownerId: unclaimedOwner.id,
              boards: setBoards.map(function (row) { return row.name; }),
              cardCount: Number((setCards && setCards.n) || 0),
              lastChangeAt: unclaimedOwner.last_change_at || null
            });
          }
          var auditRows = await recentAudit(authDb2, 50);
          var nameById = {};
          allAccounts.forEach(function (row) { nameById[row.id] = row.name; });
          return json({
            me: { name: account.name, admin: true },
            people: peopleOut,
            unclaimed: unclaimedOut,
            audit: auditRows.map(function (row) {
              return {
                at: Number(row.at),
                actor: row.actor_id ? (nameById[row.actor_id] || "a removed account") : null,
                act: row.act,
                target: row.target_id ? (nameById[row.target_id] || "a removed account") : null,
                detail: row.detail || ""
              };
            })
          });
        }
      }

      if ((p = match(parts, ["api", "auth", "invites"]))) {
        if (method === "POST") {
          if (!account.admin) return adminRefusal();
          var inviteBody = await readBody(request);
          var inviteProblem = nameProblem(inviteBody && inviteBody.name);
          if (inviteProblem) return error(inviteProblem, 400);
          var minted = await mintInvite(authDb2, inviteBody.name);
          var inviteReset = !!(await getAccount(authDb2, minted.key));
          await writeAudit(authDb2, account, "invite-minted",
            await getAccount(authDb2, minted.key), inviteReset ? "reset" : "new account");
          return json({
            name: minted.name,
            reset: inviteReset,
            code: minted.code,
            link: (authCfg.publicBase || "") + "/invite/" + minted.code,
            expires: minted.expires
          });
        }
      }

      if ((p = match(parts, ["api", "auth", "admin"]))) {
        if (method === "POST") {
          if (!account.admin) return adminRefusal();
          var adminBody = await readBody(request);
          var adminTarget = await getAccount(authDb2,
            nameKey(adminBody && adminBody.account_key));
          if (!adminTarget) return error("No account stands under that name.", 404);
          var flag = !!(adminBody && adminBody.admin);
          if (!flag && (await onlyAdminBlocked(authDb2, adminTarget))) {
            return error(ONLY_ADMIN_MESSAGE, 403);
          }
          await authDb2.prepare("UPDATE accounts SET admin = ? WHERE key = ?")
            .bind(flag ? 1 : 0, adminTarget.key).run();
          // A privilege change ends the target's standing
          // sessions: they sign in again under the new flag.
          await revokeAccountSessions(authDb2, adminTarget.key, null);
          await writeAudit(authDb2, account,
            flag ? "admin-granted" : "admin-removed", adminTarget, "");
          return json({ ok: true });
        }
      }

      // The claim: an administrator links a board set to an
      // account. Nothing moves — the boards stay in their
      // owner row; the link only decides which account resolves
      // to them — and the act is audit-logged, first claim and
      // reassignment alike.
      if ((p = match(parts, ["api", "auth", "claim"]))) {
        if (method === "POST") {
          if (!account.admin) return adminRefusal();
          var claimBody = await readBody(request);
          var claimOwner = claimBody && claimBody.owner_id
            ? await db.prepare("SELECT * FROM owners WHERE id = ?")
                .bind(String(claimBody.owner_id)).first()
            : null;
          if (!claimOwner) return error("That board set does not stand.", 404);
          var claimTarget = await getAccount(authDb2,
            nameKey(claimBody && claimBody.account_key));
          if (!claimTarget) return error("No account stands under that name.", 404);
          var previousHolder = null;
          var holders = (await authDb2.prepare(
            "SELECT * FROM accounts WHERE owner_id = ?"
          ).bind(claimOwner.id).all()).results;
          for (var hi = 0; hi < holders.length; hi++) {
            if (holders[hi].key !== claimTarget.key) {
              previousHolder = holders[hi];
              await authDb2.prepare("UPDATE accounts SET owner_id = NULL WHERE key = ?")
                .bind(holders[hi].key).run();
            }
          }
          await authDb2.prepare("UPDATE accounts SET owner_id = ? WHERE key = ?")
            .bind(claimOwner.id, claimTarget.key).run();
          // The audit detail names the set by its boards, as
          // the claim list does — never the address it stands
          // under, which no page shows (issue #114).
          var claimBoards = (await db.prepare(
            "SELECT name FROM boards WHERE owner_id = ? ORDER BY position, created_at"
          ).bind(claimOwner.id).all()).results;
          await writeAudit(authDb2, account,
            previousHolder ? "claim-reassigned" : "claim", claimTarget,
            claimBoards.length
              ? claimBoards.map(function (row) { return row.name; }).join(", ")
              : "a set with no boards");
          return json({ ok: true });
        }
      }

      if ((p = match(parts, ["api", "auth", "people", ":personKey", "signout"]))) {
        if (method === "POST") {
          if (!account.admin) return adminRefusal();
          var signoutTarget = await getAccount(authDb2,
            nameKey(decodeURIComponent(p.personKey)));
          if (!signoutTarget) return error("No account stands under that name.", 404);
          await revokeAccountSessions(authDb2, signoutTarget.key, null);
          await writeAudit(authDb2, account, "sign-out-everywhere", signoutTarget, "by administrator");
          return json({ ok: true });
        }
      }

      if ((p = match(parts, ["api", "auth", "people", ":personKey", "passkeys", ":credId"]))) {
        if (method === "DELETE") {
          if (!account.admin) return adminRefusal();
          var passkeyTarget = await getAccount(authDb2,
            nameKey(decodeURIComponent(p.personKey)));
          if (!passkeyTarget) return error("No account stands under that name.", 404);
          // Removal only closes a door, and an administrator
          // can never enrol or use a passkey for someone else
          // (determination 7). It is refused when the passkey
          // is the account's only way in — the last passkey on
          // a passwordless account (amendment A.9, edge 1) —
          // in the words this side can act on: adding a
          // password is the person's own act, and until they
          // do, the passkey stands.
          var targetRow = await getPasskey(authDb2, p.credId);
          if (!targetRow || targetRow.account_key !== passkeyTarget.key) {
            return error("Passkey not found.", 404);
          }
          if (!passkeyTarget.password_hash) {
            var targetHeld = await countPasskeys(authDb2, passkeyTarget.key);
            if (targetHeld.count <= 1) {
              return error("That is their only passkey, and their account has no password. " +
                "The person adds a password first — until then, the passkey stands.", 400);
            }
          }
          var removedOther = await removePasskey(authDb2, targetRow.credential_id, passkeyTarget.key);
          if (!removedOther) return error("Passkey not found.", 404);
          await writeAudit(authDb2, account, "passkey-removed", passkeyTarget,
            targetRow.nickname || "");
          return json({ ok: true });
        }
      }

      if ((p = match(parts, ["api", "auth", "people", ":personKey"]))) {
        if (method === "DELETE") {
          if (!account.admin) return adminRefusal();
          var removeTarget = await getAccount(authDb2,
            nameKey(decodeURIComponent(p.personKey)));
          if (!removeTarget) return error("No account stands under that name.", 404);
          if (await onlyAdminBlocked(authDb2, removeTarget)) {
            return error(ONLY_ADMIN_MESSAGE, 403);
          }
          await writeAudit(authDb2, account, "person-removed", removeTarget, "");
          var removedOwnerId = removeTarget.owner_id;
          if (removedOwnerId) {
            await batchRun(db, [db.prepare("DELETE FROM owners WHERE id = ?")
              .bind(removedOwnerId)]);
          }
          await eraseAccountCredentials(authDb2, removeTarget.key);
          if (typeof deps.onOwnerDeleted === "function" && removedOwnerId) {
            await deps.onOwnerDeleted({ id: removedOwnerId, email: removeTarget.key });
          }
          return json({ ok: true });
        }
      }

      return error("Route not found.", 404);
    }

    return error("Route not found.", 404);
}

