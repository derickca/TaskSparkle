-- D1 schema for TaskSparkle.
-- This file is the fresh-install truth for the database. Apply with:
--   wrangler d1 execute tasksparkle --file worker/schema.sql
-- Every statement is idempotent, so the deploy job can apply it on
-- every deploy. CREATE TABLE IF NOT EXISTS does not change a table
-- that already exists, so the deploy's column sync step
-- (scripts/sync-columns.mjs) reads the columns this file declares
-- and adds any an existing table lacks, with ALTER TABLE ADD
-- COLUMN. A declared column SQLite cannot add in place — one
-- carrying a primary key or a unique rule, or a default that is
-- not a constant — fails the deploy at that step, naming the
-- table and column; it needs a table rebuild by hand.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  display_name TEXT,
  name_guessed INTEGER NOT NULL DEFAULT 0,
  theme TEXT NOT NULL DEFAULT 'system',
  state_version INTEGER NOT NULL DEFAULT 0,
  last_change_by TEXT,
  last_change_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'Agent',
  token_hash TEXT NOT NULL UNIQUE,
  last4 TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT,
  -- How the app paints a card's first label colour on this
  -- board (issue #95): chip, background, trim or top. The mode
  -- is part of what tells one board from another for its
  -- owner, so it lives on the board and copies with it.
  label_colour_mode TEXT NOT NULL DEFAULT 'chip',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS "columns" (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT,
  colour TEXT NOT NULL DEFAULT 'grey',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT,
  colour TEXT NOT NULL DEFAULT '#4c524c',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  column_id TEXT NOT NULL REFERENCES "columns"(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  label_id TEXT REFERENCES labels(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  important INTEGER NOT NULL DEFAULT 0,
  creator_key_id TEXT,
  creator_key_name TEXT,
  -- Whose turn the card's next step is (issue #119): the owner,
  -- one of the owner's agent keys, or no one. step_holder is
  -- 'owner', 'agent' or 'none'; when it is 'agent', step_key_id
  -- names the holding key by id. step_handed_at and
  -- step_handed_by_key_id record the last hand-over: when it
  -- happened and which key made it, the handed-by id empty when
  -- the person made it. step_waiting stands from a hand-over
  -- until the new holder's first write to the card — the
  -- pickup. The defaults are the migration for every card
  -- written before this feature: the owner's step, not waiting.
  -- The two name columns (step_key_name, step_handed_by_key_name)
  -- are legacy text from the builds that kept a name beside the
  -- id: they are no longer written, and they are read only as
  -- the fallback name where an id cannot be resolved — every
  -- name the step reads with resolves live from the key's
  -- record (issue #121).
  step_holder TEXT NOT NULL DEFAULT 'owner',
  step_key_id TEXT,
  step_key_name TEXT,
  step_handed_at TEXT,
  step_handed_by_key_id TEXT,
  step_handed_by_key_name TEXT,
  step_waiting INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  text TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS card_links (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A card's comments: the running conversation on the card, in
-- the order the comments were written. A comment carries its
-- body and its author as an identity, never as a name: the
-- creating key's id when a key wrote it, the person's own id
-- (author_owner_id — the owner row their account links to)
-- when the person did. The name a comment shows is resolved
-- when it is read, from that key's or person's own record, so
-- a rename in the app renames the author on every standing
-- comment at once (issue #120). author_key_name is a leftover
-- from the snapshot years: rows written then carry the key's
-- name as it stood, and readers fall back to it only when the
-- key's own row is somehow gone; new writes leave it empty.
-- A comment written before author_owner_id existed records
-- no person identity either — and because a person comment
-- on a board could only ever have been that board's owner's,
-- it reads as the owner's, under their current name.
-- Deleting the card deletes its comments through the cascade;
-- archiving a card keeps them, like its steps and links.
CREATE TABLE IF NOT EXISTS card_comments (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  author_key_id TEXT,
  author_key_name TEXT,
  author_owner_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A card's labels. A card can wear any number of labels from its
-- own board, or none, so the pairing lives here rather than on the
-- card. Deleting a card or a label removes its rows through the
-- cascades, so a card never points at a label that is gone and a
-- deleted label lifts off its cards on its own.
CREATE TABLE IF NOT EXISTS card_labels (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, label_id)
);

-- The move from one label per card to many. Every card's single
-- label, held in cards.label_id until this table existed, is
-- carried across. The primary key and INSERT OR IGNORE make the
-- carry a no-op on every later apply, so a card's labels survive
-- each deploy untouched. The join keeps only labels that still
-- exist, so a stale label_id can never block the carry.
INSERT OR IGNORE INTO card_labels (card_id, label_id)
SELECT cards.id, cards.label_id FROM cards
JOIN labels ON labels.id = cards.label_id
WHERE cards.label_id IS NOT NULL;

-- The sign-in tables (issue #109): one account system on both
-- copies, worked by the shared code in worker/auth.js. On a
-- home copy these tables sit in the same file as the boards;
-- on the hosted copy they sit in the deployment's second D1
-- database when one is bound as AUTH_DB, so a flood of sign-in
-- defence writes can exhaust that database's daily write quota
-- without ever touching the boards' database. An account links
-- to its board set through accounts.owner_id — a plain value
-- the claim flow maintains, a foreign key only where both
-- tables share one store, so it is declared without one.
-- Timestamps in these tables are milliseconds since the epoch.
CREATE TABLE IF NOT EXISTS accounts (
  key TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  admin INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT,
  user_handle TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS passkeys (
  credential_id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL,
  public_key TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '',
  backed_up INTEGER NOT NULL DEFAULT 0,
  nickname TEXT NOT NULL DEFAULT '',
  rp_home TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  challenge_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  account_key TEXT,
  expires INTEGER NOT NULL,
  used_at INTEGER,
  payload TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  proof_at INTEGER NOT NULL,
  proof_via TEXT NOT NULL,
  via TEXT NOT NULL
);

-- The doors' audit trail. Rows name accounts only by their
-- opaque accounts.id, never by sign-in name, so an erased
-- person's name dies with their account row and the tombstones
-- that remain name nobody.
CREATE TABLE IF NOT EXISTS auth_audit (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_id TEXT,
  act TEXT NOT NULL,
  target_id TEXT,
  detail TEXT NOT NULL DEFAULT ''
);

-- The sign-in throttle's counts: one row per watched source
-- address, and one per source-and-account pair. Updated in
-- place; pruned by the sweep in worker/auth.js.
CREATE TABLE IF NOT EXISTS auth_throttle (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  lockouts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key)
);

-- One-row bookkeeping for the auth store (today: the cleanup
-- sweep's last-run stamp).
CREATE TABLE IF NOT EXISTS auth_meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_passkeys_account ON passkeys (account_key);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_key);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_hash ON auth_challenges (challenge_hash);
CREATE INDEX IF NOT EXISTS idx_invites_key ON invites (key);

CREATE INDEX IF NOT EXISTS idx_api_tokens_owner ON api_tokens (owner_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_boards_owner ON boards (owner_id, position);
CREATE INDEX IF NOT EXISTS idx_columns_board ON "columns" (board_id, position);
CREATE INDEX IF NOT EXISTS idx_labels_board ON labels (board_id, created_at);
CREATE INDEX IF NOT EXISTS idx_projects_board ON projects (board_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cards_board_column ON cards (board_id, column_id, position);
CREATE INDEX IF NOT EXISTS idx_cards_project ON cards (project_id);
CREATE INDEX IF NOT EXISTS idx_cards_label ON cards (label_id);
CREATE INDEX IF NOT EXISTS idx_cards_archived ON cards (archived);
CREATE INDEX IF NOT EXISTS idx_checklist_items_card ON checklist_items (card_id, position);
CREATE INDEX IF NOT EXISTS idx_card_links_card ON card_links (card_id, position);
CREATE INDEX IF NOT EXISTS idx_card_comments_card ON card_comments (card_id, created_at);
CREATE INDEX IF NOT EXISTS idx_card_labels_label ON card_labels (label_id);

-- Seed shape used by the Worker at an owner's first authenticated
-- request. An allowlisted owner with no boards gets two boards, with
-- ids formed from the owner id plus personal or professional. Each
-- board gets five columns with ids formed from the board id plus
-- inbox, ready, doing, waiting or done, and its default label rows.
-- Production seeding creates no projects and no cards.
-- Boards are user-managed data after that seed. An owner can rename a
-- board, add a board and delete a board through the API. A delete
-- takes the board whole and is refused only when it is the owner's
-- last board. Deleting a board cascades to its columns, labels,
-- projects and cards, the active and the archived alike.
-- Columns are user-managed per board after the seed: an owner can
-- rename a column, add one, remove one and reorder them through the
-- API. A column added later gets an id formed from the board id plus
-- a generated kind; a column's kind is the part of its id after the
-- board id and never changes when the column is renamed or reordered.
-- A column delete names the column that receives its cards when it
-- holds any: every card moves to the end of that column in its
-- order, archived cards after the active ones and still archived,
-- and the removal lands as one act, so no card is ever deleted by
-- a column removal. A delete holding cards but naming no
-- destination is refused, and so is a delete of the board's last
-- column.
-- Cards and projects scope to an owner through their board.
-- A card can carry one project_id or none. Its labels live in
-- card_labels: any number of labels from the card's own board, or
-- none. cards.label_id is where the single label lived before
-- labels became many; it stays in the table, dormant — the API no
-- longer reads or writes it — so this file keeps applying cleanly
-- to databases made before the change and the carry above stays a
-- no-op on them. A card's labels survive column moves and
-- archiving; a board move clears them on the server, because
-- labels belong to a board.
-- A card can carry a checklist: rows in checklist_items that belong
-- to the card the way its notes do. They keep their order from the
-- position column, they survive column moves, board moves, archiving
-- and unarchiving, and deleting the card deletes them through the
-- cascade above. A step carries text and a done flag, nothing else.
-- A card can carry links: rows in card_links that belong to the
-- card the way its checklist steps do. They keep their order from
-- the position column, they survive the same moves, and deleting
-- the card deletes them through the same cascade. A link carries a
-- web address and an optional name, nothing else. TaskSparkle
-- stores addresses only, never files.
-- A card can be flagged Important: one boolean in cards.important,
-- nothing more. There are no levels, and the flag never changes a
-- card's order anywhere — no sorting, no pinning, no filtering.
-- A card records who wrote its first version: when an agent key
-- created it, cards.creator_key_id holds that key's id, and the
-- tag the card wears is that key's name resolved from its record
-- as the card is read — so a rename renames the tag everywhere
-- at once, and deleting the key leaves its name standing on its
-- standing row (issue #121). cards.creator_key_name is legacy
-- text from the builds that kept the name beside the id: it is
-- no longer written, and it is read only as the fallback for a
-- card whose id cannot be resolved. A card the person made in
-- the app carries neither, and reads with no creator tag. A card
-- made by copying a board takes the copier as its creator: the
-- copy is a new first version. Cards made before the stamp
-- existed carry neither and are not guessed at. A card's comments live in card_comments (above): they keep
-- their order from the time each was written, they survive column
-- moves, board moves, archiving and unarchiving, and deleting the
-- card deletes them through the cascade. A board copy does NOT
-- copy comments — they are the source board's conversation, not
-- the card's content.
-- Boards, columns, labels and projects can each carry an icon: one
-- emoji, stored in the icon column, empty when none was picked.
-- The Worker fills an unset icon on read, never in the row: a board
-- reads an icon from its name (Personal a person, Professional a
-- building, any other board a card box) and a column reads the
-- keycap number of its position (0, 1, 2, 3, 4 and on). Projects
-- and labels have no default: unset reads as no icon, and they
-- render exactly as they did before icons existed.
-- The API returns a card's labels as a list of label ids, in the
-- board's label order.
-- An agent key is stored only as its SHA-256 hash plus its last four
-- characters in api_tokens.last4. The full key is shown once, at
-- creation, and never stored. An owner holds a list of keys at
-- once, up to ten live ones: each key is a row of its own, carrying
-- the name the owner gave it in api_tokens.label, and only the hash
-- carries a unique rule, so one owner carries many rows. Revoking
-- a key stamps its revoked_at; the row stays as the record, and
-- the other keys are untouched.
-- An owner carries a change marker in owners.state_version: one
-- number that every accepted change raises by exactly one, whoever
-- made the change, and a refused change never touches. Each rise
-- also stamps who made that change in owners.last_change_by
-- ("owner" for the person's own sign-in, "agent" for a key) and
-- owners.last_change_at; both read empty until the first stamped
-- change, and the stamp names the latest change only. The state
-- and every change's response carry it, so a reader knows which
-- version it is looking at. A write may name the version it was
-- based on as baseVersion; when the number has moved, the write is
-- refused with a 409 and nothing is applied. The moment a change
-- lands, the new number is also pushed to the owner's open browsers
-- through a Durable Object (OwnerPush in worker.js), so an open
-- board shows changes as they happen; the number is all a push
-- ever carries, never state or card data.
