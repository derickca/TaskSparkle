# The TaskSparkle API

The API is how an agent reads and writes a person's boards. They are the same boards the person sees in the app, not a copy. An agent can read everything, add cards, tick steps and leave comments.

Every call carries proof of who is asking. Both ways of running TaskSparkle, on Cloudflare or on your own machine, use the same API and the same rules.

## Agent setup

A person does not call the API. Their agent does. So the setup starts with the agent, and the key comes second.

1. Open Settings, then Set Up Agent.
2. Copy the short instructions on that page into your agent.
3. Your agent reads them and asks you for a key.
4. Back on that page, type a name for the key and tap Add a key.
5. The key opens in a box with a Copy button. Copy it there: the app never shows the full key again.
6. Paste the key into the secret field your agent shows you.

Your agent then connects on its own. It reads the full directions from the API (`GET /api/v1/directions`) and works from those.

## The first call

With the key in hand, the agent's first call reads the state:

```
curl https://example.com/api/v1/state -H "Authorization: Bearer YOUR_KEY"
```

The address is the one the Set Up Agent page shows. The key rides in the header, as above.

What comes back is one JSON answer: the boards with their columns, every card with its steps, links and comments, the labels and the projects, plus a version number and a build stamp. Most work starts here: read the state, do the job, then read it again to check.

## Proving identity

### Agent keys

Each person keeps a list of named keys in Settings, under Set Up Agent, up to ten live at once. Give each agent its own key under its own name.

A key starts with `tsk_live_` and carries 32 random bytes, written as hex. The server stores only a hash of the key (SHA-256) and its last four characters. Nobody can read the full key back, ever.

Later visits to the page list each key's name, its ending and the date it was made. Keys work side by side. Renaming a key changes its name only, never the key. Deleting a key stops that one key at once; the rest are untouched.

A key reads and writes only its own person's boards.

### Signing in

Signing in is passkey-first: a person signs in with a passkey, or with their own name and password as the fallback. The door is the same on both ways of running. The password is at least 12 characters and is stored as a salted hash built to make testing a guess expensive; a passkey sign-in proves itself with a one-time challenge answered by the person's device.

A sign-in lasts 30 days. It is a server-side session, not a token the browser holds the truth of: signing out ends it at the server, the person's sign-out-everywhere ends all of them, an administrator can end a person's sessions from the Admin page, and spending a password reset link ends them too. Signing in again turns the session over, so a stolen older cookie dies at the next honest sign-in.

On a hosted copy the sign-in page takes a typed name — the site is public, so no list of names stands on it. On a home copy the page lists the names of the accounts that stand, and the person picks theirs. That is the door's one visible difference.

A caller the deployment does not know gets a 403 with a plain message: a session whose account no longer stands, or a key whose person's account no longer stands linked to their boards.

### Proof by address

On Cloudflare, there are two addresses: the app address a person opens in a browser, and a second address for agents. The agent address takes keys only. It serves no sign-in pages and accepts no sessions.

On your own machine, one address serves both doors.

One server serves both doors from the same routes. The server reads the addresses from the deployment's own settings at run time. A call that arrives at the agent address is an agent call. A call that arrives anywhere else may carry a person's sign-in.

## Rules for callers

### Your boards alone

Every route answers for the caller only. A person reaches their own boards; a key reaches its owner's boards. An id that belongs to another owner reads as not found, on reads and on writes alike.

### The version number

Each owner's boards carry one version number. Every change that lands raises it by exactly one, whoever made the change. The answer to a change carries the new number too. A refused change never raises it, and neither does a write that changes nothing.

If you only want to know whether anything changed, call `GET /api/v1/version` and compare its number with the one you hold.

On the person's own door, the state and the version answer also carry a stamp of the latest change, `lastChange`. It says who made it — `owner` for a change the person made in the app through their sign-in, `agent` for one made with a key — and when it landed. The stamp names the latest change only, never a history, and it reads `null` until an owner's first stamped change.

A key's answers carry no stamp: its version answer is the number and the build stamp, and its state carries the version and the build only. A key can learn that something changed, never when the person was last active.

### Writing with baseVersion

A write can name the version it was based on, as `baseVersion` in its body. Think of it as saying: this is the state I read.

If the owner's version has moved since, the server refuses the write with a 409 and applies nothing. You read the state again, and retry against what is really there.

A write with no `baseVersion` is applied the way it always was. The web app does not send one. The guard is for agents: a change worked out against an old state cannot land on top of a newer one.

### Size limits

Sizes are capped well past ordinary use:

- Names at 120 characters, a card title at 300, notes at 10,000, a step at 500, a link name at 200, a link address at 2,000 and a comment body at 2,000.
- 50 boards per person. On each board, 30 columns, 100 labels, 100 projects and 2,000 cards. On each card, 200 steps, 100 links and 500 comments.

A write past a cap is refused whole.

### The membership list

There is no separate allowlist. A person is on a deployment by having an account, and their key works while their account stands linked to their boards. Removing the account — by an administrator in the app, or with the recovery commands in the setup guides — ends their access at once, agent keys included; their boards go with the account, as those guides describe. One exception stands on a fresh copy: until the first account exists, the keys of the people named in the deployment's `OWNER_EMAILS` setting keep working, so an agent is never locked out before its person has signed in. The moment an account stands, that list governs nothing.

The sign-in account routes (`/api/auth/*`) belong to people alone: they need a session, and a call carrying a key gets a 403 on every one of them. A key can never be exchanged for a session.

## A new owner

An account linked to no boards yet gets its space at its first state read.

It makes the owner, a Personal board and a Professional board, with the five columns on each, plus the starter labels. Personal starts with Household, Family, Health and Errands. Professional starts with Admin, Writing, Building, Outreach and Money. Each label starts with an emoji that suits it: a house for Household, a stethoscope for Health, a banknote for Money, and so on.

It makes no projects and no cards. The seeding runs once, and it is safe to repeat.

## Served directions

An agent needs more than routes. It needs the rules in one place, and the API serves them itself, as plain text, at `GET /api/v1/directions`. A key can read them.

The short text a person copies from the Set Up Agent page is just a start. It ends by sending the agent to these directions. The directions live in the same code as the API, so they ship with it, build stamp at the top. When the API changes in a way that matters, the directions change in the same commit. No person ever has to paste fresh instructions again.

The Set Up Agent page also carries a "What your agent will read" view: the same directions, fetched live through the signed-in door, read-only. The person sees exactly what their agent will be told. It changes nothing.

The directions also tell an agent how to watch for changes. Poll the version number alone. When it rises, read the state and compare it with the last state seen. Who did the work is read off the work itself: a card's creator stamp and a comment's author stamp name the key that did it, and a comment's `authorName` names its author either way, the person included. A card the person made carries no creator stamp. Moves, edits and ticks carry no stamp, and they are never guessed at. A hand-over is the one change of shape that carries its author: when a card's `step` names a different holder than the last state read, that change is a handed-over entry, carrying the name the step left and the name it went to, and `step.handedByKeyName` names the key that handed it over, or stands null when the person did; `step.handedByName` names the hander either way. They also suggest the agent offer the person a regular check on that pattern.

## The routes

Every route answers under `/api/v1`, the base the Set Up Agent instructions name. The routes also answer without the `v1`: `/api/v1/state` and `/api/state` are the same call, on both doors. The routes below are written with the `v1`.

### State and account

- `GET /api/v1/directions` returns the agent directions as plain text: the routes, the fields and the rules an agent works from, with the current build stamp at the top. It takes a key on the agent door or the sign-in on the app door, and no proof means a 401.
- `GET /api/v1/me` returns who the caller is, in the shape that door may see. A signed-in person gets their name and the name they sign in with. A key gets the owner's id and the name they go by.
- `GET /api/v1/state` returns the owner's whole state: boards with their columns, cards with their steps, links and comments, labels, projects, the owner's live keys (each an id and a name), the theme mode and `agentHost`, the deployment's configured agent address, which the app prints in its Set Up Agent instructions. A person's state also carries their email, their newest key's last four characters and the date it was made (never a key value or a hash), and the latest-change stamp. A key's state carries none of those three.
- `GET /api/v1/version` returns the version number on its own, for a caller who only wants to know whether anything changed. Its answer follows the rules under "The version number" above.
- `GET /api/v1/queue` returns the caller's queue: `{cards}`, the cards whose next step is the caller's, across every board, each in the full card shape the state carries. For a key these are the cards handed to that key. For a signed-in person they are the cards whose step is theirs. Archived cards never appear: archiving clears the step to no one.
- `GET /api/v1/push` opens a WebSocket, guarded exactly like every other route: the browser sign-in, or an owner's key. Each time a change lands, the socket receives the new version number: the number and nothing else, never state or card data. The web app holds one open, and reads the state again when a number higher than the one it shows arrives. On Cloudflare, a Durable Object holds the sockets, one per owner. On your own machine, the server holds them itself.
- `PATCH /api/v1/me` saves the theme mode. A signed-in person can also send `name`, to set the name they go by. A key can set the theme, but gets a 403 when it tries to set the name.
- `DELETE /api/v1/me` is the person's own erasure call. It deletes the owner and everything under that owner in one act: boards, cards, steps, links, comments and keys. It ends the session. A call carrying a key gets a 403, because a key can never erase its owner. Copies inside backups age out under the backup rules for that way of running; see [Operations](operations.md).

### Keys

These routes answer a signed-in person only. A call carrying a key gets a 403 on every one of them, so a key can never make, rename or revoke a key; that stays with the person in the app.

- `GET /api/v1/me/token` lists the caller's keys: each key's id, name, last four characters and the date it was made, never a value.
- `POST /api/v1/me/token` makes one key under a name, and returns the full key once. Past ten live keys, it refuses.
- `PATCH /api/v1/me/token/:id` renames one key: the name only. The key itself does not change.
- `DELETE /api/v1/me/token/:id` revokes that one key. The rest keep working. Every card whose next step was that key's comes back to the person in the same act, no longer waiting.

### Boards and parts

- `POST /api/v1/boards` creates a board with the five starter columns. It takes a name, and an `icon` if you send one.
- `PATCH /api/v1/boards/:id` renames a board. It can also move the board among your boards (`position`), and set the board's label colour mode (`label_colour_mode`).
- `DELETE /api/v1/boards/:id` deletes a board. It refuses with a 400 only when it is the owner's last board. Every card on the board — active and archived — goes with it, and so do its columns, labels and projects.
- `POST /api/v1/boards/:id/copy` copies a board in one call. The body names the new board, and says what rides along with four true-or-false flags: `columns`, `labels`, `projects` and `cards`. Without `columns`, the copy starts with the five starter columns. Copied cards are the source's active cards, landed in the new board's columns by column position, counting from the left, clamped to the last column. Their labels and project point at the copies, and land empty when those flags are off. Steps and links ride with a copied card; comments never copy, and archived cards never copy. The copied card's creator stamp names whoever made the copy. The whole copy is one change: one version bump.
- `POST /api/v1/columns` adds a column to a board, at the end. The body names the board (`board_id`) and the column's name.
- `PATCH /api/v1/columns/:id` renames a column. Send a `position`, counting from the left, to move it in the order.
- `DELETE /api/v1/columns/:id` removes a column. When the column holds cards, the body names the column that takes them, as `move_to_column_id`. Every card moves to the end of that column in one act, and archived cards stay archived. It refuses with a 400 when the column holds cards but names no destination, and when it is the board's last column.
- `POST /api/v1/labels` creates a label on a board.
- `PATCH /api/v1/labels/:id` renames a label, or changes its colour.
- `DELETE /api/v1/labels/:id` deletes a label, and lifts it off its cards. A card's other labels stay.
- `POST /api/v1/projects` creates a project on a board.
- `PATCH /api/v1/projects/:id` renames a project.
- `DELETE /api/v1/projects/:id` deletes a project. Its cards fall back to no project.
- Boards, columns, labels and projects each carry an `icon` in the state: one emoji, or empty for a project or a label with none. A board with no icon stored reads its icon from its name. A column's icon reads as the keycap number of its position. Creates and patches accept an `icon` in the same call as the name. An empty icon clears back to the built-in one, for boards and columns, or to none, for projects and labels. A value that is not a single emoji is refused with a 400, and nothing is stored.

### Cards and parts

- `POST /api/v1/cards` creates a card. It takes `board_id`, `column_id` and a `title`. It can also take notes, labels, a project, a due date, the `important` flag and a `next_step` naming the step's first holder. A due date must be a real date, written as YYYY-MM-DD, or the write is refused.
- `PATCH /api/v1/cards/:id` changes part of a card. Send only the fields you are changing. It can also hand the card's next step over (`next_step`) and post a comment in the same write (`comment`). It moves the card to another column by column kind, or to another board by `board_id`. A board move takes the column and project the same write names: `column_id` (a column id or kind on the new board) chooses where it lands, and `project_id` chooses its project there, or null for none. With no `column_id` the card lands in the new board's column at the same place counting from the left as the column it leaves, or in the last column when the new board has fewer; with no `project_id` it takes the new board's project with the same name as the card's project, or none. The card lands at the end of its new column unless `position` rides along. Labels cross by name: a label the new board carries under the same name is worn there as that board's label, and a label with no match is left behind; a `labels` list sent with a board move is not read. Everything else travels, including the archived state and whose step is next. The move is refused when the new board already holds 2,000 cards. A `position` in the body is the place the card takes in its column, counting from the top, starting at 0. The column's other active cards shift around it, and every position is written back as one clean run. So a reorder, or a move to a set place in another column, is this one call. It also archives or unarchives the card (`archived`).
- `DELETE /api/v1/cards/:id` deletes a card for good, with its steps, links and comments.
- A card carries an `important` flag: one true-or-false value, in every card answer and in the state. Create and patch take it. A value that is not true or false is refused with a 400. There are no priority levels, and the flag never changes a card's order anywhere.
- A card's labels ride with the card. Every card answer carries a `labels` list of label ids, in the board's label order. Create and patch take a `labels` list that replaces the card's whole set. An empty list means the card wears none. Every id must be a label on the card's board. An unknown id, or one from another board, refuses the whole write with a 400, and nothing changes.
- A card's steps ride with the card. Every card answer carries a `steps` list of `{id, text, done}`, in the order the steps were added. `POST /api/v1/cards/:id/steps` adds a step: its text, and `done` when it should start ticked. `PATCH /api/v1/cards/:id/steps/:stepId` renames a step, ticks or unticks it, or moves it to a new `position`. `DELETE /api/v1/cards/:id/steps/:stepId` removes it. A step id from another owner's card reads as not found.
- A card's links ride with the card the same way. Every card answer carries a `links` list of `{id, url, name}`, in the order the links were added. `POST /api/v1/cards/:id/links` adds a link: its address, and a name if you want one. The address is stored cleaned to a full http or https address, with https:// added when it was typed without one. Anything that is not an http or https address is refused with a 400. `PATCH /api/v1/cards/:id/links/:linkId` renames a link, or changes its address, in place. `DELETE /api/v1/cards/:id/links/:linkId` removes it. A link id from another owner's card reads as not found.
- A card's comments ride with the card as well. Every card answer carries a `comments` list of `{id, body, createdAt, authorKeyName, authorName}`, in the order the comments were written, plus the card's own `creatorKeyId` and `creatorKeyName`. `POST /api/v1/cards/:id/comments` adds a comment, from its `body`. `DELETE /api/v1/cards/:id/comments/:commentId` removes one. There is no way to edit a comment. Every name on the work follows one rule: the work records only who did it — a key's id, or the person's — and the name is resolved from that record as the card is read, never stored on the work. `creatorKeyName` is the creating key's name as it stands now, or `null` when the person made it in the app. `creatorKeyId` is the creating key's id, or `null` the same way: it tells two keys of one name apart, and it is what a step's `keyId` is matched against to know the maker holds the step — by id, never by the name. (The app works the same way: when the maker holds a card's step, the card's face wears the step's chip alone instead of two pills naming the same key.) A comment's `authorKeyName` is the writing key's name as it stands now, or `null` when the person wrote the comment, and `authorName` names the author either way: the key's current name, or the person's current name. Rename the key or the person and every standing name on the work follows at once; deleting a key in the app revokes it and leaves its record standing, so its cards and comments keep their names. Work written before identities were recorded reads by the fallback its record allows: a comment from then carries the board owner's current name, since a person comment on a board could only ever have been the owner's, and a card carrying a maker's name as text but no id reads with that name bound to the one key of the owner's that carries it, when exactly one does — and keeps the text it carries when none does, or more than one does. A comment id from another owner's card reads as not found.
- A card's next step rides with the card as `step`: `{holder, keyId, keyName, handedAt, handedByKeyName, handedByName, waiting}`. `holder` is `owner` (the person), `agent` (one of the owner's keys) or `none`. When it is `agent`, `keyId` names the holding key and `keyName` is that key's name as it stands now, resolved from the key's record as the card is read. `handedAt` says when the step was last handed over, or is `null` when it never has been. `handedByKeyName` names the key that handed it over the same way, or is `null` when the person did; `handedByName` names whoever handed it over — the key's current name, or the person's name as it stands now — or is `null` when the step has never been handed over. `waiting` is true while the holder has not picked the card up: the holder's first write to the card, of any kind, clears it, and a write by anyone else does not.
- Writes name the step as `next_step`, on a card create and on a card patch: `"owner"`, `"none"` (or `null`), or the id of one of the owner's live keys, which the state's `keys` list carries. An id that is not one of the owner's keys refuses the whole write with a 400. A card a person creates starts as their step, and a card a key creates starts as that key's step. Naming a different holder on the create, or changing the holder on a patch, is a hand-over: it stamps the time and the hander, and the card waits — unless the new holder is the caller themselves or no one. Naming the holder the card already has changes nothing. Archiving a card clears its step to `none`, whole. No column move ever changes the step.
- A card patch can also carry a `comment`: its text posts as a comment on the card as part of the same write, under the one version rise, stamped with its author the way a comment on its own route is. That is how a hand-over and the words that explain it land together.

Columns are addressed by kind, never by row id. The five starter columns carry the kinds `inbox`, `ready`, `doing`, `waiting` and `done`. A column added later carries a generated kind of its own. A kind never changes when its column is renamed or reordered, so a card move can name its column by kind and keep working.
