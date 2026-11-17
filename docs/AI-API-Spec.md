# AI API Spec

This spec reviews the agent API as it stands on 2026-11-16. Every claim in the first part traces to code. File names name the code that carries the claim.

The API has one shape in both repos. The hosted service adds one key road the open source copy does not have.

## Capabilities now

### Two key roads

A MemberSpark AI key starts with `msk_`. The hosted entry passes it to the MemberSpark kit (`worker/worker.js`, the `memberSparkKey` seam). `resolveCaller` in the deploy repo's `worker/core.js` branches on the prefix before any local lookup.

A local key starts with `tsk_live_`. The server stores a SHA-256 hash and the last four characters (`makeAgentKey` and the `api_tokens` lookup in `worker/core.js`). The full key shows once, when the person makes it.

The self-host entry passes no MemberSpark seam. A MemberSpark key never branches there. A downloaded copy judges local keys only.

### Reads

- `GET /state` returns the owner's whole state in one answer. Boards ride with their columns. Cards ride with steps, links and comments. Labels, projects, the theme and the live key list ride too.
- `GET /queue` returns the cards whose next step is the calling key's, across every board. Each card comes in the full card shape.
- `GET /version` returns the version number and the build stamp.
- `GET /me` returns the owner's id and the name they go by. A key never gets the owner's email.
- `GET /directions` returns the agent directions as plain text.
- `GET /push` opens a WebSocket. Each change sends the new version number and nothing else.

Reads speak camelCase. Writes speak snake_case. Each call takes only its own spelling.

### Writes

- Boards: create, rename, reorder, set the label colour mode, delete and copy. A copy takes four flags for what rides along. A board copy is one act with one version rise.
- Columns: add, rename, reorder and remove. Removing a column that holds cards names the column that receives them.
- Labels: add, rename, recolour and delete. A delete lifts the label off its cards.
- Projects: add, rename and delete. A delete leaves its cards with no project.
- Cards: create, edit and delete. One edit can change the title, notes, labels, project, due date, the important flag, the column, the place in the column, the board and the archived state.
- Steps: add, rename, tick, untick, reorder and remove.
- Links: add, change and remove. The address must clean to an http or https address.
- Comments: add and remove. There is no edit.
- `PATCH /me` with a key sets the theme only.

A card move to another board crosses in one edit. Labels cross by name. Steps, links, comments and the step holder travel with the card.

### Handing over

Every card's next step belongs to the person, to one key or to no one. The step rides on the card as `step`. It names the holder, the holding key, who handed it over and when.

`waiting` stands true until the holder's first write to the card. Any write by the holder clears it. A write by anyone else does not.

A card edit can carry `next_step` and `comment` together. The hand-over and the words that explain it land as one write.

A key creates a card as its own step. Naming another holder on the create is a hand-over.

Deleting a key hands its cards back to the person. The local key road does this in the token delete route. The MemberSpark road does it in the `ai_key.revoked` event handler in `worker/memberspark.js`.

Archiving a card clears its step to no one. A column move never changes the step.

### Writing rules

Every write passes one gate in `worker/core.js`.

- A field the call does not take is refused with a 400 that names the field.
- A body that is not JSON is refused with a 400.
- Every field is judged before anything is written. A refused write changes nothing.
- A write may carry `baseVersion`. The gate claims the version rise before the route runs. A stale claim gets a 409 and the stale message. Nothing is applied.
- A write with no `baseVersion` is applied unchecked.
- An id that belongs to another owner reads as not found, on reads and writes alike.

Caps stand in the `LIMITS` table in `worker/core.js`. A write past a cap is refused whole.

- Names: 120 characters. A colour: 40. A card title: 300. Notes: 10,000. A step: 500. A link name: 200. A link address: 2,000. A comment body: 2,000.
- Per owner: 50 boards and 10 keys. Per board: 30 columns, 100 labels, 100 projects and 2,000 cards. Per card: 200 steps, 100 links and 500 comments.

### Stamps

Work records who did it. The record holds an identity, never a name. Names resolve from the record as the work is read.

- A card carries `creatorKeyId` and `creatorKeyName`.
- A comment carries `authorKeyName` and `authorName`.
- A step carries `handedByKeyName` and `handedByName`.

Moves, edits and ticks carry no stamp. A watcher cannot attribute them and must not guess.

### Card times

A card read carries `createdAt` and `changedAt`. The created time is when the card was made; a board copy, a template start and a recurring round each make a new card at their own moment. The changed time is the card's last change a reader can see — a move, an edit, a hand-over, a step, a link, a comment, archiving — read off the change stamp the following build keeps, with the creation time standing for a card nothing has changed yet. A weekly tidy by age and a "what changed this week" answer both read straight off the cards.

### Key limits

A key can never call the key routes. `GET`, `POST`, `PATCH` and `DELETE` on `/me/token` answer a key with a 403.

A key can never call the sign-in routes under `/api/auth`. A key gets a 403 on every one.

A key can never delete the account. `DELETE /me` answers a key with a 403.

A key can never set the person's name. `PATCH /me` with a name answers a key with a 403.

A local key carries its owner's full powers over the boards. Local keys have no read-only level.

### MemberSpark keys

The kit judges a MemberSpark key in `worker/memberspark-kit/memberspark.js` (`aiKey`).

- A key for another product is refused before any call home. A key with a bad check segment is refused the same way.
- A read call needs read access. A write call needs write access. A read key that tries a write gets a 401.
- A vouched key acts as the account its sub is bound to (`accounts.memberspark_sub`). No account row gets a 401 with a plain sentence.
- Twenty failed checks from one source inside the window get a 429 with a retry time.
- A check answer is cached. A write key's answer stands for 60 seconds. A read key's answer stands for five minutes.

The first vouched call writes the key's standing record in `ms_api_keys`. The record holds the key id, the owner, the name and access the centre reported, and the first and last seen times. Three audit entries mark its life: `memberspark-key-recorded` at birth, `memberspark-key-updated` when a check reports a new name or access, and `memberspark-key-revoked` when a revocation lands.

Revocation works two ways. The centre's check stops vouching for the key. The centre's `ai_key.revoked` event also stamps the local record, and `resolveCaller` refuses a stamped key outright, even while a cached check would still vouch.

When the centre cannot be checked, the kit answers 503. A key with a standing record then works on its last good check for ten days. A key with no record is refused. The outage road writes nothing, so the window never extends itself.

A key bound to a test account reads freely. Every write gets a 403: "Test accounts are read-only, so this change is refused." The gate stands in the deploy repo's handler, beside the live-check and outage returns (deploy #134 and #353).

### Directions

The service serves its own directions at `GET /api/v1/directions`. The text lives in `agentDirections` in `worker/core.js`. The same text stands in both repos.

The Set Up Agent page gives the person a short bootstrap (`agentInstructions` in `public/app.js`). The bootstrap names the door, says how a key is made and kept, and sends the agent to the served directions. The page also shows the person the very directions text their agent will read.

### What no key can do

- Read one card alone. `/state` and `/queue` are the only card reads.
- Search or filter. No route takes a query.
- Work in bulk. There are no bulk calls. Clearing a column means one call per card.
- Edit a comment. A comment is removed whole or stands.
- Read history. The version is one counter. The latest-change stamp rides on the person's answers only, and it names the latest change alone.
- Hold a read-only local key. Every local key can write.

## Recommended capabilities

### Changes since a version

Add a read that returns the changes since a version the caller names. Jobs it unblocks: a watcher that now reads the whole state on every poll and diffs it by hand. Boards grow, and the whole-state read grows with them.

### Filtered reads

Let `/state` or a card read take a board, label, project or due range. Jobs it unblocks: "cards due this week" and "everything under the Money label" on a board near the 2,000 card cap, without moving the whole board each time.

### Read-only local keys

Give a local key the same read and write levels a MemberSpark key carries. Jobs it unblocks: a reporting helper on a self-host copy that can read the boards and never change them.

### Bulk create

Let one call create many cards from a list. Jobs it unblocks: a spreadsheet of tasks, a meeting's action list, an import from another tool. Today each card is its own call, so a hundred rows is a hundred calls.

## User scenarios

### Scenario one

Mara opens her morning chat. She asks her AI: what waits on me, and what is due this week?

1. The AI reads `GET /state` with her key.
2. It picks out the cards with a due date in the week ahead. It reads the dates off the cards itself.
3. It reads `GET /queue` for the cards whose step is its own, and says which of those she is waiting on it for.
4. It answers in the chat. It changes nothing.

The API carries this today. The due filtering happens on the AI's side, because no route takes a due range.

### Scenario two

Tom hands his AI a card: fix the leaking tap. The card sits in his queue for the AI.

1. The AI reads `GET /queue` and finds the card.
2. It reads the card's comments first. Tom's note names the tap and the shut-off valve.
3. The AI adds two steps: turn off the water, then swap the washer. Its first write clears the waiting flag.
4. It ticks the first step and posts a comment: the valve is off.
5. It edits the card with `next_step` set to the owner and a comment in the same call: the washer size is not in the house, and Tom needs to buy one.

The API carries this today. The hand-over and its explanation land as one write.

### Scenario three

Priya pastes her club's meeting notes into her chat. She asks her AI to turn the actions into cards.

1. The AI reads `GET /state` and finds the club board and its labels.
2. It creates one card per action, each with its steps and the right label.
3. Two cards name the treasurer as their first holder, so the creates carry `next_step` for her key.
4. The AI reads `/state` again and checks every card landed.

The API carries this today. Twelve actions mean twelve create calls. A bulk create would make it one.

### Scenario four

Every Friday, Sam's AI tidies his work board. It archives the Done cards that finished more than a month ago.

1. The AI reads `GET /state` and finds the Done column's cards.
2. It reads each card's `changedAt`. For a card resting in Done, that stamp is when it landed there or was last touched.
3. It archives the ones whose stamp stands more than a month back, one card at a time.

The API carries this today. Archiving works one card at a time, and the changed time on the card says when it was finished or last changed, so the tidy picks its month by that stamp.

### Scenario five

Jo's AI watches her boards from a cron. Every five minutes it checks for changes and routes a short note to the right chat.

1. The cron reads `GET /version`. The number has not moved. It stops.
2. On the next run the number has moved. The AI reads `GET /state` and diffs it against its snapshot.
3. A new comment carries its author's name, so the note names who wrote it. A moved card carries no stamp, so the note reports a move and names nobody.

The API carries this today. The served directions describe this very pattern. The whole-state read on every change is the cost, and it grows with the board.

### Scenario six

Ana signs a venue contract. She asks her AI to file the signed PDF on the booking card.

1. The AI reads `GET /state` and finds the card.
2. It files the PDF with `POST /cards/{card id}/attachments`: the file's name, its kind and its bytes as base64.
3. The card now reads with the file's record — its name, its kind and its size — and the file itself comes back whole from `GET /cards/{card id}/attachments/{attachment id}`, as a download under its name.

The API carries this today. A card holds its files the way it holds its links: they travel with the card, a board copy carries them whole, and deleting the card takes them with it.

### Scenario seven

Rob gives a second AI a key so it can report on his boards each week. He wants it to change nothing.

1. On the hosted service, Rob makes a MemberSpark key with read access.
2. The second AI reads `/state` and writes its report.
3. It tries a card edit by mistake. The write gets a 401, because its key holds read access only.
4. On Rob's self-host copy at home, his local key carries full powers. The same mistake would land.

The API carries this on the MemberSpark road today. It does not carry it on the local key road. Read-only local keys close the gap.

## Verdict

Good enough for the day-to-day jobs. One person's AI can read the boards, work its queue, create and move cards, comment, hand work back and watch for changes, on either key road.

Not yet enough for three jobs people will ask for. An AI cannot file a file on a card. It cannot tidy by age, because a card carries no times. It reads the whole board for every small question, because no read takes a filter.
