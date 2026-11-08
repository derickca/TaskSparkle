# Product spec

**Sixty-second version**

TaskSparkle is a personal kanban product for one person and the agents that person chooses to help.

It is a website. Each person who uses a copy has private boards made from columns and cards. A card holds notes, checklist steps, links, comments, labels, a project and a due date. A card also names whose turn its next step is.

People sign in passkey-first. A password is optional. Agents never use a person's sign-in. Each agent uses a named key that belongs to one person and reaches only that person's boards.

TaskSparkle can be installed on Cloudflare or on a machine the person controls. Each installation is a deployment, and deployments are completely separate. A deployment is a separate copy with its own accounts and its own boards. Nothing is shared or synced between deployments. What matches from one deployment to another is the product itself: the board features, the account rules and the words on the pages. Every difference between the two ways of running it is named in this spec.

Five promises carry the design:

- One person's boards are private to that person.
- The work model stays small and plain.
- A change never lands silently on top of newer work.
- People stay in charge of sign-in and agent access.
- The product matches across deployments, and each deployment stands alone.

## What it is

TaskSparkle organises one person's work on boards.

A person opens it in a browser on a computer or a phone. The browser can install it as an app-like shortcut. It remains a live website and needs a network connection.

One copy can hold accounts for more than one person. Their boards do not merge. Each person signs in as themselves and sees only their own boards.

Agents are helpers, not account holders. An agent works on a person's boards through that person's key. An agent has no boards of its own.

## Look and mark

The product mark is a mint four-point sparkle with a white centre dot on a deep violet rounded tile.

The sparkle colour is `#00EEB9`. The tile colour is `#372F8F`. The wordmark uses Comfortaa Bold. It stands in the app header and at the top of the standalone sign-in pages.

## Core model

Boards hold columns. Columns hold cards. Cards hold the details of one piece of work.

### Boards and columns

A board belongs to one person. Its columns, labels and projects belong to that board.

A new person's space starts with a Personal board and a Professional board. Each starts with five columns and starter labels. Neither starts with projects or cards.

The five starter columns are Inbox, Ready, Doing, Waiting and Done. A board made later starts with the same five columns. It starts with no labels, no projects and no cards.

A person can add, rename, reorder and remove boards and columns. A board always keeps at least one column. When a removed column holds cards, the person picks another column for them. The cards move in the same act.

A board can be deleted unless it is the person's last board. Deleting a board removes its columns, labels, projects and cards with it.

### Cards and details

A card belongs to one board and stands in one column. It has a title and notes.

A card can hold checklist steps. Each step has text and a done mark. Steps keep their order.

A card can hold links. Each link has a web address and may have a name. TaskSparkle stores the address only. It does not store the linked file.

A card can hold comments. Comments stand in the order they were written. A comment can be removed, but it cannot be edited.

A card may have one due date. The date must be a real calendar date. A card may also carry an Important flag. The flag is only a marker. It has no levels and never changes a card's order.

Archiving a card takes it off the active board and keeps its details. Deleting a card removes its steps, links and comments with it.

### Labels and projects

Labels and projects are two separate ways to classify a card. Neither one is the card's place. The column is the card's place.

Labels belong to one board. A card can wear any number of that board's labels, or none. Deleting a label lifts it from its cards. The card's other labels stay.

Projects belong to one board. A card can carry one project or none. Deleting a project leaves its cards with no project.

A card that moves to another board takes the column and project chosen for it there. A label crosses when the new board has a label with the same name, wearing that board's label; a label with no match stays behind. Everything else on the card travels, including whose turn its next step is.

## How work moves

Work moves through direct edits, card moves and hand-over of the next step.

### Saving and moving

There is no Save button. Edits save themselves as the person or agent makes them.

A card can move by dragging or by the editor's Move controls. A move can change its column or its board: the editor's Move board picks the board, the column and the project in one act. A move never changes whose turn the next step is.

### Next step

Every card names whose turn its next step is. The holder is the person, one of the person's agent keys or no one.

A card the person makes starts as the person's step. A card an agent key makes starts as that key's step.

The holder can change in the card editor or through the API. A comment can ride in the same card edit as the hand-over. The comment and the change of holder land as one act.

Handing a card to another holder marks it as waiting. The new holder's first write to the card is the pickup. That write clears the waiting mark. A write by anyone else does not clear it.

Archiving a card clears its next step to no one. Revoking a key returns every step it held to the person.

### Names on work

Work records who did it by identity, not by a frozen name.

A card's maker, a comment's author, a step's holder and the person or key that handed a step over are read from the current account or key record. Renaming a person or a key changes the name shown on standing work at once.

A card made by a person carries no maker tag on its face. The card editor names the maker for a person's card and for a key's card alike.

A revoked key's record stands. Its name therefore keeps resolving on the cards and comments it made.

## People and sign-in

Each person has an account. The account links to that person's boards and to no one else's.

### Accounts and invites

The first account made on a copy becomes the administrator. The setup path closes as soon as that account stands.

Every later person joins by invite. An administrator makes a one-use invite link in Settings, then Admin. Looking at an invite does not spend it. The invite lasts seven days. A fresh invite for the same name retires that name's earlier unused invites.

The administrator can invite people and make another person an administrator. The administrator can send reset and recovery links. The administrator can sign a person out everywhere, remove a named passkey and remove a person.

### Joining by email

A hosted copy can also take people by emailed link, when its operator opens joining. The setting stands in the copy's own store: invite-only (the default), open, or closed. Invites work in every state.

An account made this way carries one email address, proven by the link round-trip, and unique across the copy. Its name is only what the person is called: never unique, and never typed at sign-in.

Joining and signing in are one act. A person types their address on the sign-in page and the copy emails a one-use link that lasts 15 minutes. Spending it signs in an account that stands, and makes the account when none stands — the landing page asks for a name and the Terms agreement, and the account is made only when both stand. Joining can be gated to named countries, and a bot check can stand on the joining form; both are judged when the link is spent, never at sign-in. A joining spend offers a passkey for the device next.

The page answers an ask the same way whether or not the address holds an account, and a link is sent only when it would do something. Link asks are paced per source and per address, so no inbox can be flooded through the page.

The administrator cannot sign in as another person. The administrator cannot read, set or use another person's password or passkey.

One guard protects the copy. The only administrator cannot be removed or lose that role while other accounts stand. Another person must become an administrator first.

Settings stands in this order: Account, Theme, Boards, Columns, Labels, Projects and Set Up Agent. Admin stands last. Only an administrator sees the Admin entry.

The app never displays an email address.

### Passwords and passkeys

Signing in is passkey-first at a secure address. The sign-in page opens on the passkey view. A switch offers the password view. Another switch offers the way back.

The device remembers the view last used. Enrolling a passkey makes the passkey view that device's view. A later manual switch changes the memory again.

On a hosted copy the sign-in page is the emailed link's page: one field for the address, the button that sends the link, and the passkey button for a device that holds one. No name is typed and no password is asked for there. The passkey ceremony is the same discoverable one, and the address field carries its autofill offer.

An account can hold a password alone, a password and passkeys, or a passkey alone. A password needs at least 12 characters. The product refuses passwords people use most and refuses a password equal to the account name.

A new account chooses its first way in on the setup or invite page. The page stands the passkey way first at a secure address. A passkey account is created only when its ceremony verifies. It starts with no password.

Security changes ask for a fresh proof from the last ten minutes. The first passkey can be enrolled after a fresh password proof. Once a passkey stands, enrolling another passkey takes a passkey proof.

A session is a server-side record. It lasts 30 days and can be revoked. Sign-in rotates the session. A password change and other privilege changes rotate it too.

Passkeys need an address the browser trusts. At an ordinary HTTP address, the sign-in page offers the password way only. The page says that the site is not encrypted.

### Recovery and removal

A self-host copy sends no recovery message by itself. Recovery there is a link handed over by a person or by the operator.

On a hosted copy, recovery is the sign-in link again: a shut-out person asks for a link, and spending it is the way back in. There is no separate reset. Spending it revokes the account's other sessions, like a reset spend does.

An administrator can send a reset or recovery link from Settings, then Admin. On a home copy, the operator can mint the same kind of link with the server command. On a hosted copy, the operator can mint it with the deployment's own credential. Those routes serve the day no administrator can sign in.

Spending a reset link replaces the password and revokes every session. It does not remove a passkey.

A passkey comes off only by a named act. The person can remove their own passkey. An administrator can remove a named passkey for another person. A spender can choose Start fresh to remove the standing passkeys and enrol a new one in the same act.

The last passkey on an account with no password cannot be removed. The person must add a password first. A passkey-only account can add a password back behind a fresh passkey proof.

## Agents and keys

An agent reaches the boards through the API with a personal key. A key is not a sign-in and can never become one.

### Keys and access

A person makes keys in Settings, then Set Up Agent. Each kind of agent gets its own named key.

A person can hold up to ten live keys. The full key shows once when it is made. The server stores a SHA-256 hash and the last four characters. Nobody can read the full key back.

A key reaches only its owner's boards. An item from another person's boards reads as not found.

Renaming a key changes its name only. The key value does not change.

Deleting a key in the app revokes it. The key stops working at once. Its record stands, so its name keeps resolving on its work. Every next step it held returns to the person.

A key gets a refusal on the routes that belong to a signed-in person. It cannot manage keys, use the account and Admin routes, enrol or remove a passkey, change a password, mint an invite or erase the person. It cannot be exchanged for a session.

### Agent work

The API serves its own directions as plain text. The directions carry the current build stamp and change with the API they describe.

An agent reads the directions, reads the state and then works from that state. It reads the state again when the boards have moved.

The queue route returns the cards whose next step belongs to the caller. For a key, those are the cards handed to that key. For a person, those are the cards whose step is the person's.

The directions tell an agent to work its queue. Its first write to a waiting card is its pickup. When it needs the person, it hands the step back with a comment in the same edit. It must not leave a card it holds idle without a comment saying why.

## Sync and freshness

One version number for each person's boards is the source of truth for change.

Every accepted change that changes something raises the number by exactly one. A refused change does not raise it. A write that changes nothing does not raise it. A change's answer carries the new number.

A writer can name the version its change was based on. If the boards have moved since that version, the server refuses the whole write and applies nothing. The writer reads the state again and tries from the real state.

Live push carries the new version number and nothing else. It never carries state or card data. An open app that receives a higher number reads the state again.

A watcher can poll the version route and read the full state only when the number rises. A key's version answer does not say when the person was last active.

The app also compares its build stamp with the build stamp the server serves. An open app that learns of a newer build reloads itself once onto that build. A guard stops the same build from causing another reload.

## Two homes

TaskSparkle has two homes: Cloudflare and a machine the person controls. Both are built from one codebase. Each installed deployment runs on its own. It shares no accounts, boards or other data with any other deployment.

### Shared core

One codebase holds the program core and the sign-in system. The core holds the API routes, the board rules and the seeding. The sign-in system holds accounts, passkeys, sessions, invites and the standalone sign-in pages. One schema states the data shape.

Each deployment installs that codebase on its own. A Cloudflare deployment and a self-hosted deployment do not connect to each other. Each one uses adapters for its own database and live push. The difference sits at the edge, not in the product rules.

The browser app matches across deployments. So do the API routes. The words for accounts, boards and agent work match too. Matching features and words do not move accounts or boards from one deployment to another.

### Cloudflare home

In the Cloudflare home, a Worker serves the API and the standalone sign-in pages. Pages serves the browser app. D1 holds that deployment's data. A Durable Object carries live push.

This home has two addresses. People use the browser address. Agents use the agent address. The agent address takes keys only. It serves no sign-in pages and accepts no sessions.

The hosted setup page asks for a setup code before it makes the first account. The hosted sign-in page takes a typed name. It shows no list of account names.

### Self-hosted home

In the self-hosted home, one Node program serves the app, the API and the sign-in pages. One SQLite file holds that deployment's data. A local socket hub carries live push.

This home has one address for people and agents. The credential on the request decides the door. A key is an agent call. A session is a person call.

The home setup page asks for no setup code. The home sign-in page lists account names for the person to pick from.

### Named differences

The homes differ only in the ways named here:

- The Cloudflare home has two addresses. The self-hosted home has one.
- The hosted sign-in takes a typed name. The home sign-in offers a pick list.
- The hosted setup page asks for a setup code. The home setup page does not.
- Page notes follow the door. A note names the typed name on a hosted copy and the sign-in list on a home copy.
- Passkey acts follow the address. The Cloudflare address is HTTPS. A home copy offers passkeys at a trusted secure address and offers passwords alone at an ordinary HTTP address.

No other difference belongs in the product. A new difference must be named here with its reason before it stands.

## Data and privacy

A person's data stays inside that person's owner record. Every read and write is judged against the caller.

A deployment's data stays in that deployment. A Cloudflare deployment and a self-hosted deployment hold separate accounts and boards. No accounts or boards move or sync between them.

### Isolation and erasure

A route answers only for the caller. A person reaches their own boards. A key reaches its owner's boards. An ID from another owner reads as not found on reads and writes alike.

Erasure removes the person's live data whole. It removes the owner record and cascades to boards, cards, steps, links and comments. It removes agent keys. It also removes the account's credentials, sessions, passkeys and invites.

A person can erase their own boards and account in Settings, then Account. An administrator can remove a person from Admin. A key cannot call erasure.

### Backups and exports

Data stays in open forms. It is never locked into a format only this app can read.

On Cloudflare, a nightly backup writes a plain SQL export. The export holds the whole database. Backup exports age out after 14 days. Erased data leaves the live database at once and leaves the hosted backups as those exports age out.

On a self-hosted copy, the data sits in an ordinary SQLite file. A backup is a copy of that file made while the server is stopped. The operator keeps or deletes those copies. Erasure does not reach into a separate backup copy the operator has kept.

## Designed limits

The limits are part of the design. A write past a limit is refused whole.

### Count limits

- 50 boards for each person
- 10 live agent keys for each person
- 30 columns on each board
- 100 labels on each board
- 100 projects on each board
- 2,000 cards on each board
- 200 checklist steps on each card
- 100 links on each card
- 500 comments on each card

### Text limits

- 120 characters for a board, column, label or project name
- 40 characters for a colour value
- 300 characters for a card title
- 10,000 characters for a card's notes
- 500 characters for a checklist step
- 200 characters for a link name
- 2,000 characters for a link address after cleaning
- 2,000 characters for a comment

## Not included

TaskSparkle does not offer these things:

- Shared boards or team boards
- Public boards
- Webhooks or a change feed
- An offline mode
- File attachments
- A native phone app
- Recurring tasks
- Gantt charts
- Calendar sync

More than one person can use a copy, but collaboration is not the product. Each person keeps a separate set of boards. Watching for change means polling the version number, not receiving a webhook.
