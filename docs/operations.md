# Run the service

This guide covers repo files, deploys, backups and data recovery. Where a fact belongs to one way of running, the text names it. For running a home copy day to day, read [Self-hosting TaskSparkle](self-hosting.md).

## Backups

On Cloudflare, a second workflow exports the whole database to a dated `.sql` file every night and stores it in an R2 bucket that keeps 14 days of exports. An export is plain SQL, and it holds everything, for every person on the copy: every board, card, step, link and comment, each owner's email and name, and every agent key's hash and last four characters. Read it with that in mind: anyone who can open the Cloudflare account, or who holds the deployment credential the workflows run on, can read an export in full. Restoring is importing that file into a D1 database (`wrangler d1 execute tasksparkle --remote --file=<the export>` against an empty database, or `wrangler d1 import`). Your data is never locked into a format only this app can read. Data a person deletes is gone from the live database at once and ages out of the exports within the same 14 days.

On a self-hosted copy there is no export workflow, because there is nothing to export from: every board lives in the one SQLite file in the server's data folder, and backing up is copying that file while the server is stopped. Read [Self-hosting TaskSparkle](self-hosting.md) for that path.

## What it costs

Zero on the Cloudflare free tier at personal scale: the app, the site, the database, the live updates and the backup bucket all fit inside the free plan's allowances for a board one or two people use daily. Nothing in the setup asks for a card. A self-hosted copy costs the electricity of a machine you already run.

## The sign-up door

A copy can open public sign-up: anyone who reaches the sign-in page can make their own account, with their own boards. The door is a switch with three states — open, invite-only and closed — and it stands at invite-only until the operator flips it. Flipping it is one stored value in the sign-in bookkeeping, read on every visit to the sign-up page: no redeploy, no restart, and the change takes effect on the next visit.

The value stands in the `auth_meta` table under the key `door`: `1` is open, `2` is closed, and `0` — or no row at all — is invite-only. One statement sets it:

```sql
INSERT INTO auth_meta (key, value) VALUES ('door', 1)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```

On Cloudflare, run it against the database that holds the sign-in tables — the separate auth database where the deployment has one, the main database where it does not — with `wrangler d1 execute <that database> --remote --command "<the statement>"`, or from the database's own console in the dashboard. On a self-hosted copy, run it against the `tasksparkle.sqlite` file in the server's data folder with any SQLite tool.

While the switch stands at invite-only or closed, the sign-up page refuses in plain words. Invites work in every state, exactly as they do with the door unopened. The first account is never the door's: while no account stands, the setup page owns creation, whatever the switch says.

Two guards can stand on creation, each set where the deployment's own settings live — the Cloudflare settings in [Cloudflare setup](cloudflare-setup.md), the home config in [Self-hosting TaskSparkle](self-hosting.md). A country list names the countries creation is open to; a creation read as coming from outside the list is refused, and sign-in is never gated. A bot check (Cloudflare Turnstile) can stand on creation, verified before any account row is written. Creations also keep their own pace — five per source address per hour — apart from the sign-in throttle, so a creation rush never locks anyone out of signing in.

## Repo files

### App and server

- `public/` holds everything the browser loads: `app.js` (the front end: rendering, the editor, settings and the API data layer), `index.html`, `styles.css`, `sw.js`, the manifest and the icons
- `worker/core.js` holds the whole API: every route, the caller checks, the seeding and the directions. It runs in both homes and takes its ties to the world as adapters: the database, the sign-in store and live updates
- `worker/auth.js` holds the one sign-in both homes share: accounts, passwords and passkeys, invites, sessions, the throttle, the audit log, and the sign-in, setup, invite and sign-up pages themselves
- `worker/worker.js` holds the Cloudflare entry around the core: the plain-HTTP redirect, the hosted door's page routes and the OwnerPush Durable Object the core's push adapter speaks to
- `server/` holds the self-host server. `server.mjs` is the local entry around the same core: the static app, the shared sign-in pages and the recovery commands. `d1-adapter.mjs` is the D1 shape over a local SQLite file, and `push-hub.mjs` is the socket hub that stands in for the Durable Object. `config.example.json` is the config template; the real `config.json` is gitignored
### Guides

- `docs/self-hosting.md` is the self-hosting guide
- `docs/cloudflare-setup.md` is the Cloudflare setup guide
- `docs/using-tasksparkle.md` is the daily use guide
- `docs/passkeys-and-passwords.md` is the passkeys and passwords guide
- `docs/api.md` is the API reference
- `docs/operations.md` is this guide
- `docs/watching-for-changes.md` explains the version poll and state diff an agent or a person can use to follow board changes, and links the runnable digest example
### Examples and tests

- `examples/change-digest/` holds a small Node script that polls with an agent key, keeps a snapshot beside itself and prints what changed
- `tests/` holds the standing drills and how to run them (see `tests/README.md`), with the fake-Access rig for the Cloudflare-mode drills in `tests/rig/`
- `package.json` marks the project as a Node module package, which the self-host server needs to import the shared core; it carries no dependencies
### Data and config

- `worker/schema.sql` holds the database schema, the same file for D1 and for the local SQLite store. It is the fresh-install truth and is safe to re-apply. The deploy adds any declared column an existing table lacks by itself (the column sync step below), so a new column needs no hand-run ALTER
- `scripts/sync-columns.mjs` is the Cloudflare deploy's column sync. It reads the columns `worker/schema.sql` declares, compares them with the live database and adds each missing one in place. A column SQLite cannot add in place (a primary key, a unique rule, a non-constant default) fails the deploy at that step, naming the table and column
- `wrangler.toml.example` holds the Cloudflare copy's settings shape: the routes for both doors (the sign-in page routes included), the D1 bindings, the Durable Object binding for live updates and the public configuration — the door hosts and the pre-first-account email list. Copy it to `wrangler.toml` and fill in your own values. The filled-in file is gitignored and never committed. The app has no workers.dev address. The setup code is a Worker secret, set with `wrangler secret put SETUP_CODE`, never a settings value
- `LICENSE` is the MIT licence
- `CHANGELOG.md` records what each release carries, and `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and `SECURITY.md` hold how to contribute, the behaviour expected and the private route for reporting a vulnerability. The screenshots in the README live in `docs/screenshots/` and show a staged example board with sample cards

## Deploys and backups

A push to main deploys the Cloudflare way through the workflows in `.github/workflows`, written for a self-hosted GitHub Actions runner; [Cloudflare setup](cloudflare-setup.md) says what to change if you do not have one. A deploy publishes the Pages site and the Worker together. It applies the schema first and syncs any missing columns. It then checks that the app's and the API core's build stamps agree before shipping. The deployment's Cloudflare credential and its filled-in `wrangler.toml` are repository secrets, handed to the job for that run only and written to the checkout by the job's first step. The workflows pin their tools (wrangler to an exact version, the checkout action to a commit) so nothing unreviewed runs beside the credential.

A nightly workflow exports the D1 database to a dated `.sql` file in an R2 bucket whose lifecycle rule keeps exports for 14 days. One export holds the whole database — every person's boards and comments, owner emails and names, and every key's hash and last four — so anyone with the account or the deployment credential can read all of it; [Backups](#backups) says this in full. The job deletes its local copies of the export in a final step that runs on every outcome, so the export never rests on the runner.
