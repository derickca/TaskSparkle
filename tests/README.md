# Tests

TaskSparkle's standing checks live here as runnable scripts. They run against a throwaway rig or a throwaway self-host instance. They use throwaway owners. They never run against a live deployment's data.

On both rigs the drill people are the accounts named Drill A and Drill B. On the Worker rig person A enters through the setup page (with the rig's setup code) and person B by invite; on a self-host instance both are made by invite. The Access tokens the Worker rig still mints are for the frozen transition door only — they seat nobody new, and the drill proves it. Everything they make is drill data.

Each drill prints one `PASS` or `FAIL` line per check. It ends with the count. A run with any failure exits with a nonzero status.

Read the first `FAIL` line first. It names the behaviour that broke. Later failures may follow from it.

A setup error before the checks start is not an app failure. A missing module or a server that is not running can cause one. The UI drill section below gives the missing-module route in full.

## Smoke checks

`npm run test:smoke` runs the smoke tier: a small change's quick verdict, before the full drills.

It runs four things, in this order:

- A syntax check: `node --check` over every `.js` and `.mjs` file in the tree.
- The build-stamp agreement: the stamp in `worker/core.js` against the stamp in `public/app.js`.
- The route check the full harness runs: every address the standalone sign-in pages call is covered by a route pattern in `wrangler.toml.example`.
- One live boot: the harness stands up a throwaway self-host instance, mints an invite with the server's command, redeems it, signs in, reads the seeded state, makes one card, reads it back, and reads the version and directions stamps.

It runs no browser, no Worker mode and none of the drill families. It proves the copy boots and its smallest honest walk works — nothing more. The drills below are the proof of behaviour.

The budget is under a minute end to end. The run prints its own elapsed time as its last line, and never fails on time alone — a slow machine is not a broken build. Measured on the desktop rig (Node 24, warm) on 2026-11-03: 1.3 to 1.5 seconds across three runs.

## Run all local checks

`npm test` runs the harness.

- The harness writes a throwaway self-host config into a scratch folder.
- It starts the server on port 8793 against that config.
- It runs the API drill in self-host mode.
- It then runs the server drill.
- It deletes the scratch folder after the run.

`npm run test:ui` adds the UI drill against the same instance. You can also pass `--ui` to the harness itself. The UI drill needs the Playwright setup in the UI drill section below.

The pull request checks in GitHub run this same harness. A green run here is what a green check there means.

The sections below describe each drill on its own. Use them when you want just one drill.

## API drill

The API drill is `api-drill.mjs`. It checks the API's scenario families.

### Sign-in, owners and cards

- Sign-in and the seeded state
- Isolation between owners
- The card lifecycle
- Checklists, links, labels and projects
- Columns, including the delete that moves cards
- Boards, including copy and the keep-one rule

### Keys, stamps and directions

- Keys: mint, list, rename and revoke
- The rule that a key cannot manage keys
- Card creators and comments: the key-name stamps from issues #50 and #51, with every name on the work — a comment's author (issue #120), a card's maker and its step's holder and hander (issue #121) — resolved live from the writer's record as the card is read
- The copy rules, the comment caps and the one-version-rise rule
- The write gate: unknown fields refused by name, and stale writes refused
- The version stamps a person write and a key write leave
- The directions
- The push route's refusals
- The stale-session cookie expiry from issue #49

### What each door may see

The doors section covers issues #61, #64, #65 and the frozen part of #66.

- A key's answers carry no change stamp.
- A key's answers carry no owner email.
- A key's answers carry no key block.
- The person's answers carry all three.
- The display name the person sets, which a key cannot set
- On the Worker rig, the frozen transition door still honours the sign-in name refresh for a board set that already stands — and refuses to seat or seed anybody new

### The sign-in itself

The sign-in family covers issue #109, in both modes.

- A passkey enrols against a fresh password proof; once a passkey stands, a second enrolment with only a password proof is refused, and a passkey proof unlocks it
- A passkey signs in; assertions without user presence, without user verification, for the wrong origin, the wrong ceremony or the wrong person are refused, and a replayed challenge is refused
- Sign-out-everywhere revokes the person's other sessions and keeps the caller's; sign-out revokes its own session at the server
- Changing the password in the app takes the current password or a fresh proof, and the old password stops working; the app's form carries no current-password field (issue #114) — behind a stale proof the change is refused and asked for proof, the UI walk proves through the proof panel, and the self-host drill ages a session's proof in the data file to prove the refusal
- A reset link's spend replaces the password and revokes every session, and removes no passkey (the ruled displacement, [B]); the form's start-fresh choice is the one reset act that removes them, and the drill asserts both shapes
- An administrator removes another person's passkey from the Admin page; the person's password still works; a non-administrator is refused
- A key gets a 403 on every sign-in account route and is never given a session; a session cookie is worth nothing at the agents' door
- The throttle: failures against one name from one address lock that pairing early, while another name from the same address still signs in; failures pile onto the address's own count until the address waits briefly; and no failure count ever locks an account — the account itself signs in as soon as the address's short wait passes
- On the Worker rig, the hosted setup refusals: no setup code and a wrong setup code are both refused and make no account; the hosted sign-in page takes a typed name and lists nobody

### Passkey-first

The passkey-first family covers issue #122, in both modes, with the setup family on its own fresh Worker rig (`--setup-family`).

- The drop: refused on a password-only fresh proof, lands on a fresh passkey tap; other sessions revoked, the caller's rotated; password sign-in afterwards refuses in the standing shape; the add-back refuses short, listed and name-equal candidates and lands on the standing fresh passkey proof
- A passkey-born account, made by an invite spent by ceremony: a look and an abandoned ceremony make no account; the account then holds no password and one passkey, its session's proof stamped passkey, and the spend's own proof carries the next guarded act; its posture reads Passkey only; the password proof route refuses it through the dummy; the same family on the setup page of a fresh rig and of a self-host instance, first-wins intact
- The recovery spend on a passwordless account: the invite opens a recovery page, not a password form; the spend revokes every session and removes no passkey; the start-fresh choice on the page removes the standing ones and enrols the new one alone
- The last passkey on a passwordless account: removal refused to the person and to the administrator alike, each in its own side's words, and the same removal lands once a password stands
- The sign-in views: a fresh device opens on the passkey view; a device that left the password view open opens there; at an ordinary HTTP address there is no switch, and the settled line and the HTTPS link stand under the form; no hint about the autofill passkey stands anywhere on the page, asserted by string absence

### Claims, the write budget and the stored hash

The second #109 family covers the rest of the design, split by mode the way the rigs allow.

- On the Worker rig: an account made by invite on a copy whose boards all stand claimed starts linked, and the claims list stands empty
- On a self-host instance: a board set inserted with no account stands unclaimed — its key is refused, the Admin page names it by shape only (board names, card count, last change, never a card's contents — and never the address the set stands under, which no page shows), and a waiting account sees the same shape and no contents
- The administrator links the set to a person; the cards stand byte for byte as they were; the set's key works from that moment
- Linking is reversible: the administrator moves the set to another person, the first person waits again, and the audit trail names both acts
- The defence budget, counted in the data file: a run of failed sign-ins adds at most two throttle rows and no challenge or session rows, and attempts made under a standing lock write nothing at all
- A stored password hash with zero rounds, with absurd rounds, or with the chain marker missing is refused at sign-in, never run

### Write cost and erasure

- The write-cost section times writes on a wide board. It covers issue #71.
- The last family is erasure. It covers issues #57 and #92.
- A key that calls `DELETE /me` gets a 403. Its owner stands whole.
- The person's own call erases them in one act.
- The answer expires the door's session cookie.
- Their key dies with them.
- The other owner's version does not move.
- A fresh sign-in starts from the seed.
- On the self-host instance, the drill reads the data file back. It proves that every table the schema cascades stands at zero rows for the erased person.
- The drill also reads the directions. It checks the erasure truth.
- It checks the watching passage too. That passage teaches stamp attribution off the work itself. It gives no instruction to read a change stamp off a key's answers.

### Feedback

The feedback family covers issue #22, in both modes. It is told which state the copy under it stands in with `--feedback on|off` (off when unspoken — the state the harness's instance and the standing rig stand in). Off: the site answer (`GET /api/site`) says no feedback target stands, and the submit route (`POST /api/feedback`) answers not found. On: the target is a stand-in the drill itself holds open on port 8795, and the copy's `FEEDBACK_URL` must point at `http://127.0.0.1:8795/api/submit` before the copy starts — on the Worker rig the var stands in the rig folder's `wrangler.toml`, copied from a prepared source. A post to the submit route then lands on the stand-in whole (the same JSON, the copy's own origin named) and the stand-in's answer is relayed. The self-host on-state is carried by the server drill, which writes its own configs; this family's on-state is for the Worker rig.

The drill runs in two modes, one per home.

### Run it against the Worker rig

Use mode `worker`.

The rig is the real Worker and core under `wrangler dev`. It has a fake Access door, so tokens can be minted locally. The harness lives in `tests/rig/`.

1. Start the rig with `node tests/rig/rig.mjs start --dir <a scratch folder> --source <this checkout>`. It copies the checkout into the folder, makes the rig's signing key pair, copies `tests/rig/wrangler.toml.example` into place as the rig's `wrangler.toml`, applies the schema to both of the rig's local databases (the rig binds the second one as `AUTH_DB`, the way a hosted deployment may, so the sign-in tables must stand in it too), and starts the certs server on port 8791 and the Worker on port 8792. Each server starts in its own process group, and rig.mjs writes the groups it started into the rig folder's `.rig-state.json` before it waits for them to answer. Start a rig only this way: a `wrangler dev` started by hand has no record, and nothing can stop it by name afterwards.
2. Run the drill:

   ```
   node tests/api-drill.mjs --base https://localhost:8792 \
     --agent-base https://127.0.0.1:8792 --mode worker --mint tests/rig/mint.mjs \
     --password-a <drill A's own password> --password-b <drill B's own password> \
     --setup-code rig-setup-code
   ```

The rig's two hosts are the two doors. `localhost` is the people's door. `127.0.0.1` is the agents' door. This matches the rig settings file.

The mint script signs a token for any name. The frozen transition door honours tokens only for board sets that already stand; the drill's accounts enter through the setup page and invites, like people.

On its own fresh rig (the drill makes the first account itself and flips the joining switch in the rig's auth database), the email drill walks the hosted copy's sign-in and joining by emailed link:

```
node tests/email-drill.mjs --base https://localhost:8792 \
  --setup-code rig-setup-code --rig-dir <the rig folder>
```

The rig's mail path points at the drill's own capture server (port 8795), so a sent link is read out of the captured message and spent. The walk covers the page's shape, the switch at invite-only and closed, the full joining journey with a passkey enrolment and a one-tap return, the link spent twice and expired, the country gate at the ask and at the spend, the link pace, the no-leak answer, and the invite machinery standing untouched.

3. Stop the rig with `node tests/rig/rig.mjs stop --dir <the same folder>`. It stops the recorded process groups, confirms every one is gone, and only then removes the folder. A rig folder is never removed while its server still runs, and stop refuses a folder that holds no state file rather than guess which processes are the rig's.

If a run is interrupted, or a rig folder was removed by hand, the stack can be left standing on a deleted folder (issue #157). `node tests/rig/rig.mjs reap --match <part of the folder's path>` stops every wrangler or workerd process whose working directory reads "(deleted)" and matches — and nothing else. `node tests/rig/rig-check.mjs`, run on the rig machine, proves the stop, the reap and the refusal.

### Run it against a self-host instance

Use mode `selfhost`.

1. Start a throwaway instance. Its config names nobody — a self-host config holds no people. See the [Self-hosting guide](../docs/self-hosting.md) for the config.
2. Point the server at that throwaway config. Use `--config <file>`, or set the `TASKSparkle_CONFIG` environment variable.
3. Keep the drill instance away from a real `server/config.json`.
4. Set a password for each drill owner the way a person does. The harness mints an invite for each name. It uses `node server/server.mjs --config <file> --invite "Drill A"`.
5. The harness redeems each invite over HTTP. It uses the drill password for that person.

```
node server/server.mjs --config /path/to/drill-config.json

node tests/api-drill.mjs --base http://localhost:8793 --mode selfhost \
  --password-a <drill A's own password> --password-b <drill B's own password> \
  --server-config /path/to/drill-config.json
```

Some families run in Worker mode only. Self-host mode skips them:

- The hosted setup refusals (issue #109), and the hosted sign-in page's shape — the emailed link's page, asserted in the API drill's place and walked whole in the email drill
- The agent door refusing a session cookie and a person token
- The #49 cookie expiry
- The push route's 501 on an unconfigured deployment

A self-host-only check takes their place. It reads the directions for the local http address.

One more self-host-only pair: the sign-in page fetched under a home-style Host name — an ordinary HTTP address, not localhost — leaves the passkey button out and prints the line in its place, because no passkey ceremony can run there (issue #113). Worker mode's rig is HTTPS, where passkeys can run.

Self-host mode ends with two more families:

- The hardening family covers issues #55, #62, #67, #68 and #69.
- The invite family covers issue #89.
- The claims, budget and stored-hash family (issue #109) runs its full half here, where the drill can read the data file and insert an unclaimed board set directly.

The hardening and invite checks cover:

- The sign-in page's name pick list, with no email anywhere on it
- The sign-in throttle
- The request-body cap
- The push hub's frame rules
- Per-person passwords set through single-use invite links
- A look never spends the link. The press does.
- A spent or expired link is dead.
- One person's password never signs in another.

Passing `--server-config` lets the drill mint invites against the instance. It also lets the drill read the config and data file back. No password rests in the config at all. Each password rests in the data file only as a chained salted hash, and the drill reads the accounts table to prove the stored form.

## Server drill

The server drill is `server-drill.mjs`. It drills the self-host server's own lifecycle. It starts throwaway instances with throwaway configs in a scratch folder.

The checks cover:

- A config that still carries the retired household password fields refuses to start. It names the change and the remedy.
- A config that still carries a `people` list refuses to start. It names the change. This covers issue #107.
- The fold-in (issue #109): a data file holding the older sign-in tables starts clean — the password rows land in the shared accounts table with their older hash carried over, the first sign-in under that password succeeds and the stored hash stands replaced by the chained form, the old invite spends, and the old tables are gone.
- `--invite "A Name"` mints a link and a bare code for any name. No roster limits it, and no server needs to run. It still mints on a config the server itself refuses — it is the recovery door.
- `--invite` also mints while the server runs, beside a write lock another process holds (issue #130): the opener waits the lock out instead of failing with "database is locked", and the minted invite stands to be spent.
- A nameless config starts. The startup log names no person.
- With no accounts, the sign-in page is the setup page. Making the first account there flags it administrator and signs its maker in. A second setup press is refused — first-wins.
- The invite flow runs end to end. The name stands in an editable field on the invite page, and spending under a name an account already holds is refused with the invite left unspent.
- A look never spends the link. The Set password press does.
- A spent, retired or expired link is dead.
- The pasted-code entry reaches the same redemption.
- The sign-in page lists the accounts' names as a pick list. Picking a name and typing its password signs in. One person's password never signs in another.
- An invite carrying an existing account's name is a reset: the name stands fixed on its page, spending replaces the password, and the boards stay.
- The administrator's routes work from inside the app: an admin mints an invite, a non-admin gets a refusal on every admin route, an admin makes a second admin, and an admin removes a person. The only administrator cannot erase their own account while other accounts stand.
- The config's `host` setting binds an instance to this machine only.
- Behind an HTTPS front door on the same machine (issue #115, the shape Tailscale Serve makes): the config names the public https address and the bare agent name with no port. The first account is made through that shape and its session speaks at the one address, the startup line and the directions name the https base, the passkey ceremonies verify against the public origin the front door's forwarded-proto stamp names — and the same ceremony without the stamp is refused.

The feedback family covers issue #22. A config with no `feedbackUrl` — the default — answers not found at the Feedback page's addresses and at the submit route, and its site answer says no target stands, while the rest of the copy stands as usual. A config naming a target (a stand-in the drill holds open) serves the page with its form, and a note posted to the copy's own API lands on the target whole, under the copy's own origin, with the target's answer relayed.

The last family is the recovery erasure command. It covers issue #57.

- `--delete-person "A Name"` erases the account under that name in the data file.
- It erases the account, boards, keys, password, passkeys and invites.
- The other person stands untouched.
- Run it again, and it answers that there is nothing to delete. It exits non-zero.
- Run it for a name that was never there, and it does the same.

The drill spawns its servers with the Node that runs it. Run it under the oldest supported Node, and that run is the floor proof for that version.

```
node tests/server-drill.mjs
```

## UI drill

The UI drill is `ui-drill.mjs`. It holds the browser checks. They are written for a self-host instance.

### Sign-in, cards and live updates

- On the public page before sign-in, it proves the deployment's feedback setting (issue #22): the harness's instance names no target, so no Feedback entry stands on the public page or the Help page once the site script settles, and the Feedback page's address answers not found.
- It signs in through the local sign-in page.
- It sees the seeded boards.
- It works a card end to end in the app: make it, add a checklist step, tick it, reopen it and find it ticked.
- It leaves a comment on the card.
- It mints an agent key in Settings.
- It reads the state back through the API with that key.
- It proves live push. A change made through the API lands on the open board with no reload.
- It checks the creator tags. A card the key made wears its maker's name on its face — unless that key holds the card's next step, when the step chip alone names it and the face wears one pill (issue #123). The walk proves all four shapes: maker-held, the person's, another key's and no one's.
- A card the person made wears no tag.
- The person's card shows its comment count.

### Account page

- The person renames themselves. The name stands after a reload. This covers issue #66.
- The sign-in section stands: the passkey list, and a change-password walk that sets a new password and sets the drill password back. This covers issue #109. Given `--data-file <the instance's data file>` (the harness passes it), the walk first ages the session's proof in the file, so the change is refused by the server itself and proved through the proof panel (issue #114); the Account and Admin pages are also checked there for any email address standing in the UI, and the Settings headings for standing above body size at both widths.
- In a fresh context, with the sign-in routes refusing — the shape the transition door presents — the section stands disabled under its note and nothing navigates away, while a board-API refusal still sends the browser to the sign-in page. This covers issue #110.

### The sign-in page

- The remembered name: a sign-in pre-picks the person's name on the next visit; unticking "Remember my name on this device" clears it at once, and the visit after an unticked sign-in pre-picks nothing. This covers issue #112.
- The same instance under a home-style name — `drill-home.local`, which the browser's resolver rule maps to the test machine — is an ordinary HTTP address, and the walk proves the gate there: the sign-in page offers no passkey button and the line stands in its place (framed at desktop and phone widths for the capture set); the password signs in; a passkey made at the secure address still lists on the Account page and can be removed, while the add act is not offered and the line stands in its place. This covers issue #113.
- Given `--hosted-base <the Worker rig's address> --rig-dir <the rig folder>`, a second walk runs against the rig's hosted page, which is the emailed link's page now: an email field carrying the webauthn autofill word, no password field and no name field; the conditional passkey offer starts as the page loads (an options call no click made); the ask lands on the check-your-inbox page; a new person's link — asked over HTTP with the country header a real edge adds, and read out of the drill's own mail capture (the rig's mail path points at it) — opens the joining page in the browser, its Terms tick standing unticked; the joining press itself runs over HTTP (the bot check's widget cannot mint a token for the rig's fake site key in any browser), and the browser then walks the passkey offer, enrols the device passkey with the offer's own button, and signs back in with the sign-in page's passkey button. The rig serves no front end, so a landed sign-in is proven by the session itself. The walk flips the joining switch open in the rig's auth database first, the operator's way — run it after the API drill in Worker mode, on the same rig.
- The local mirror holds no name. A stale name, seeded on purpose, is cleared.
- Logging out clears the mirror whole. This covers issue #58.
- The whole run listens for a content-security-policy violation.
- It reads the app page's security headers. This covers issue #70.
- Given `--spend-family 1 --base <a fresh copy's address>` (plus `--setup-code <code>` on the hosted rig), the run walks only the spend pages and exits. On a copy with no accounts standing, the setup page stands both ways open with the passkey way first (issue #141): the walk asserts that standing at phone width and desktop width, presses the passkey button with the fields standing empty — an empty press names the missing field, the trap of issue #128 — then fills the standing name and setup code fields and completes the enrolment. It then spends an invite the same way. After each enrolment it signs out and reads the sign-in page: the enrolment made the passkey that device's sign-in view, and a later manual switch to the password view is still remembered. The lane runs it against a fresh self-host instance and a fresh Worker rig in turn.

### Admin page

This walk covers issues #107 and #109. It runs as the instance's administrator — the first account the harness seeds takes the flag.

- The Admin entry stands last in the Settings list for the administrator, and no Admin entry stands in a non-administrator's list — at the secure address and at an ordinary HTTP address alike (issue #124).
- Each row shows the account's posture: password set or not, passkeys held or not.
- Minting an invite for a new name opens the invite dialog, carrying the link.
- The dialog stands over the Settings panel, where a person can use it — the walk asks what sits at the dialog's centre, not just whether it is unhidden.
- Near the end of the run, the administrator removes the second drill account from the Admin page, behind its dialog. That leaves one account standing, which is what lets the account-deletion walk below run: the only administrator cannot erase their own account while other accounts stand.

### Delete the account

This walk covers issue #57.

- It opens the account page's delete section.
- The confirm names the boards and the backups' 14 days.
- The delete button stays disabled until DELETE stands typed in full.
- Cancel stands the dialog down at desktop width.
- The run's last walk deletes the account for real at phone width.
- It lands on the sign-in page.
- The key minted earlier in the run is dead.

### Card delete dialog

This walk covers issue #97.

- The editor's Delete opens a fresh dialog over what stands underneath.
- The Archived list's Delete opens the same dialog.
- No confirm lives inside the editor.
- The dialog names the card, its place and the permanence.
- Standing the dialog down returns to the editor with its edits in place.
- Confirming deletes the card from the board and the state.

### Agent key dialogs

This walk covers issue #98.

- Adding a key opens a dialog. It carries the key with a copy button.
- Closing the dialog leaves the key nowhere on the page.
- Deleting a key asks in a dialog over the untouched list.
- The row never expands into the question.
- Standing the dialog down keeps the key working.
- Confirming kills the key.

### Project, board and label delete dialogs

This walk covers issue #99.

- Deleting a project asks in one shared dialog. It works from Settings → Projects and from the press-and-hold editor.
- The dialog stands over the untouched row or editor. No confirm is left in either place.
- Deleting a board asks in a dialog. It names the board and counts all its cards — live and archived alike (issue #134) — plus its labels and projects. A board holding cards deletes whole behind the dialog; the API drill proves the server's cascade in the data file.
- Deleting a label asks in a dialog. It names how many cards wear the label. It uses plain wording when none do.
- Standing each dialog down preserves everything. Confirming acts.
- The account delete confirm stands in its dialog. The type-DELETE field sits inside it.

### Screenshots

Screenshots land in the output folder at 1280px and 390px widths, for a person to look at. They show:

- The sign-in page
- The board
- The account page
- The account delete dialog
- The card face tag
- The editor's comments
- The card delete dialog
- The two key dialogs
- The project, board and label delete dialogs

### Set up Playwright

The drill borrows Playwright. It does not bundle it.

The project itself has no runtime dependencies. Playwright is a test-only tool.

From a fresh clone, give Node a module to borrow. Then give Playwright its Chromium build:

```
npm install --no-save --package-lock=false playwright-core@1.64.0
npx playwright-core install chromium
```

Run both commands from the repository root.

The first command puts `playwright-core` in the ignored `node_modules` folder. It changes neither `package.json` nor any lock file.

The second command downloads the matching Chromium. It goes into the current user's Playwright cache.

Start the throwaway self-host instance from the section above. Then run:

```
node tests/ui-drill.mjs --base http://localhost:8793 \
  --name "Drill A" --password <drill A's own password> --out /tmp/shots
```

A machine that already keeps Playwright somewhere else can skip the install. In that case:

- `PLAYWRIGHT_MODULE` must name the module's entry file itself. For example, `/path/to/node_modules/playwright-core/index.mjs`. It must not name the `playwright-core` folder.
- `CHROMIUM_PATH` must name a Chromium executable file. It must not name its folder.
- If the drill still answers `No Playwright module found`, the value in `PLAYWRIGHT_MODULE` is not that entry file. Or the module is not installed at the path it names.

## A note on rigs

Both drills were written for a rig on a separate machine or in a scratch folder. A rig has a fresh local database and a fresh data folder. Everything is throwaway.

When a rig run ends, its processes stop and its folder is removed. On the Worker rig, rig.mjs is what makes that sentence true — it stops the stack before the folder goes, in that order. Nothing here is meant to run against the deployment you use.
