# Watching for changes

TaskSparkle has no webhook and no change feed. An agent follows a person's boards by polling one small version route and reading the full state only when that number rises. The pattern is small enough to run from cron or from any other scheduler.

This page describes the pattern. The runnable example is [`examples/change-digest/change-digest.mjs`](../examples/change-digest/change-digest.mjs).

## The pattern

Use one agent key for one person. Keep a snapshot of the last state that key read.

1. Send `GET /api/v1/version` to the agents door with the key.
2. Compare the answer's `version` with the version in the snapshot.
3. If the number has not moved, stop. Do not read the whole state.
4. If the number has moved, send `GET /api/v1/state` with the same key.
5. Compare the new state with the snapshot, field by field and item by item.
6. Print or send the digest.
7. Replace the snapshot with the new state only after the digest has been produced.

The first run has nothing to compare. It saves a snapshot and reports that later runs will show changes from that point.

A key's `/version` answer carries `{version, build}`. A key does not receive the change stamp that a person's own browser receives, so the version number tells a watcher **that** something changed and never **when the person was active**. The state diff supplies the rest.

## Who did it

Read attribution from the work itself.

- A new card carries `creatorKeyName`. A key name there names the agent key that created the card. `null` means the person made the card in the app.
- A new comment carries `authorKeyName`. A key name there names the agent key that wrote the comment, as the key is named now. `null` means the person wrote the comment in the app. A comment also carries `authorName`, which names its author either way — the key's current name, or the person's current name for their own comment.
- Moves, edits and ticks carry no stamp. A card in a new column, a renamed title, a changed note, a ticked step and a changed board structure show their new shape and name nobody. Report those as changes. Do not call them the person's work and do not call them an agent's work.
- A hand-over is the one change of shape that carries its author. Each card's `step` names whose turn its next step is. When `step` names a different holder than the snapshot's — the person, a key, or no one — that change is a handed-over entry: it carries the name the step left and the name it went to, and `step.handedByKeyName` names the key that handed it over, or stands `null` when the person did. `step.handedByName` names the hander either way — the key's name, or the person's when the person handed it over. A card whose `step.waiting` clears between two states was picked up by its holder.

That limit is deliberate. A state diff can prove that a card moved. It cannot prove which hand moved it.

## The digest example

The example is a Node script with no packages to install. It needs Node.js 22.5 or newer.

Copy the `examples/change-digest` folder to a place the scheduled job can write. The script keeps `snapshot.json` in that folder by default, and a snapshot belongs to one person's boards. Use a separate copy or a separate snapshot path for each key.

Set the agents door and the key in the environment:

```sh
export TASKSparkle_AGENT_URL="https://tasksparkle-api.example.com"
export TASKSparkle_AGENT_KEY="tsk_live_replace_with_the_real_key"
node change-digest.mjs
```

For a self-hosted copy, people and agents use the same address:

```sh
export TASKSparkle_AGENT_URL="http://your-machine.local:8080"
export TASKSparkle_AGENT_KEY="tsk_live_replace_with_the_real_key"
node change-digest.mjs
```

Keep the key in the scheduler's secret store or in a protected environment file. Do not write a real key into the script, into the snapshot or into a public crontab.

The first run prints a line like this:

```text
First run: saved a snapshot at version 12. Later runs will print changes from that point.
```

A later run with no rise in the version prints:

```text
No changes since version 12.
```

When the state has changed, the digest names added and removed items, changes to cards, checklist and link changes, board structure changes and new or removed comments. Comment bodies print in full. New cards and new comments carry their stamp-based attribution. Other changes are marked as carrying no stamp.

To use another snapshot file, set its full path:

```sh
export TASKSparkle_DIGEST_SNAPSHOT="/path/to/that-person-snapshot.json"
```

## On a schedule

Cron is one simple home for the pattern. This example runs every five minutes and appends the digest to a log the owner can read:

```cron
*/5 * * * * cd /path/to/change-digest && TASKSparkle_AGENT_URL="https://tasksparkle-api.example.com" TASKSparkle_AGENT_KEY="tsk_live_replace_with_the_real_key" /usr/bin/node change-digest.mjs >> digest.log 2>&1
```

That crontab line carries a real key in this example only to show the shape. In a real setup, put the key in a protected file or secret store and have a small wrapper script set the environment before it runs the example. The example itself has no routing, no chat client and no delivery rule. A reader can send its output wherever their own tools already send notes.

Poll gently. A check every few minutes is plenty for a task board, and `/version` is the only request on a quiet run.

## Key failures

A `401` means the key is wrong or revoked. A `403` means the key reached the API but the call is not allowed, or the key's person's account no longer stands linked to the boards. The example prints the failure and leaves the snapshot untouched, so the next successful run still compares against the last state it actually saw.
