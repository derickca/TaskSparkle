# Run the service

This guide covers repo files, deploys, backups and data recovery. Where a fact belongs to one way of running, the text names it. For running a home copy day to day, read [Self-hosting TaskSparkle](self-hosting.md).

## Backups

On Cloudflare, a second workflow exports the whole database to a dated `.sql` file every night and stores it in an R2 bucket that keeps 14 days of exports. An export is plain SQL, and it holds everything, for every person on the copy: every board, card, step, link and comment, each owner's email and name, and every agent key's hash and last four characters. Read it with that in mind: anyone who can open the Cloudflare account, or who holds the deployment credential the workflows run on, can read an export in full. Restoring is importing that file into a D1 database (`wrangler d1 execute tasksparkle --remote --file=<the export>` against an empty database, or `wrangler d1 import`). Your data is never locked into a format only this app can read. Data a person deletes is gone from the live database at once and ages out of the exports within the same 14 days.

On a self-hosted copy there is no export workflow, because there is nothing to export from: every board lives in the one SQLite file in the server's data folder, and backing up is copying that file while the server is stopped. Read [Self-hosting TaskSparkle](self-hosting.md) for that path.

## What it costs

Zero on the Cloudflare free tier at personal scale: the app, the site, the database, the live updates and the backup bucket all fit inside the free plan's allowances for a board one or two people use daily. Nothing in the setup asks for a card. A self-hosted copy costs the electricity of a machine you already run.

## Administration and control

A copy runs itself. It has no connection to any centre: no Admin console stands above it, and nothing reports out of it. Its audit log and its error log stand in its own store and never leave it.

The copy's operator surface is the Admin page inside the app — Settings, then Admin. The address `/ops` on the copy's own host leads to it. Only an administrator ever sees the page: its entry in Settings stands only for an administrator, and the routes behind it refuse everyone else.

The first account made on the setup page is the administrator. Standing is a flag on the account in the copy's own store. An administrator grants or removes the flag on the Admin page; the act ends that person's standing sessions, and the flag is read from the account on every request, so the change stands from their next request. The page holds the rest of the operator's work too: invite people, send reset and recovery links, sign a person out everywhere, remove a passkey by name, remove a person and link a waiting set of boards to its person. Each act writes its entry in the copy's audit log in the same act, and the page shows the log's latest entries.

The control plane stands in the copy's own tooling, not in the app's pages. On a home copy it is `server/config.json` and the recovery commands in the self-hosting guide. On Cloudflare it is the settings in `wrangler.toml`, the Worker secrets — the setup code among them — the deployment's own repository secrets and the Cloudflare dashboard. Pages show credential standings only: a key's name and last four, a passkey's nickname. A secret value never stands in a page; a full agent key shows once, at its making, and is held in memory only.

## Repo files

### App and server

- `public/` holds everything the browser loads: `app.js` (the front end: rendering, the editor, settings and the API data layer), `index.html`, `styles.css`, `sw.js`, the manifest and the icons
- `worker/core.js` holds the whole API: every route, the caller checks, the seeding and the directions. It runs in both homes and takes its ties to the world as adapters: the database, the sign-in store and live updates
- `worker/auth.js` holds the one sign-in both homes share: accounts, passwords and passkeys, invites, sessions, the throttle, the audit log, the error log and its daily routine, and the sign-in, setup and invite pages themselves
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

<!-- Documentation-only probe for issue #185: this pull request exists to prove the checks workflow runs none of the set on a documentation-only change. It is closed unmerged once its run stands as the evidence. -->
