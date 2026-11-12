# Cloudflare setup

This guide puts your own copy of TaskSparkle on Cloudflare.

## What you get

- Your own copy of TaskSparkle, live on your domain.
- Two addresses on that domain: one for people and one for agents.
- An address on HTTPS, so passkeys work at it.
- People sign in passkey-first, with their own password as the fallback. Agents use a personal key.
- A backup of the whole database every night, kept for 14 days.

## What you need

- A free Cloudflare account.
- A domain whose DNS is on that account.
- Node.js 22.5 or newer, on the machine where you run Wrangler.
- Two hostnames on your domain: one for people and one for agents.

The hostname names are your choice. This guide calls them the browser host and the agent host.

**Choose the browser host's name with care, before anyone signs in.** A passkey is made for the exact name people open: change that name later and every passkey stops working, and each person must make a new one. Passkeys and passwords have their own guide: [Passkeys and passwords](passkeys-and-passwords.md).

This guide covers the Cloudflare path. A self-hosted copy runs the same sign-in from one Node program. Read [Self-hosting TaskSparkle](self-hosting.md) for that path.

Keep this guide open. Do the steps in order.

## Shipping changes

### From GitHub

A push to `main` deploys the app and the API together. The workflows in `.github/workflows` do the work.

Two facts about a fork:

- GitHub starts with Actions turned off on a fork. Turn them on in the fork's Actions tab.
- The workflows expect a self-hosted runner with the labels `self-hosted`, `linux` and `x64`. Without one, change the `runs-on` value in your deploy workflow (made from the example in step 2) and in `.github/workflows/backup.yml` to `ubuntu-latest`. Skip that change and jobs wait forever for a runner the fork does not have.

### By hand

Skip GitHub. Run Wrangler yourself when you want to ship a change.

You still do step 1 and steps 3 to 7. Step 9 lists the three commands you run.

## Get Wrangler ready

1. **Install Wrangler and sign it in.** TaskSparkle pins Wrangler in its workflows. The commands below use that same form.
   - Run `npx wrangler@4.153.0 --version` once to fetch it.
   - Run `npx wrangler@4.153.0 login`.
   - Approve the sign-in in your browser.
   - In a shell with no browser, create a Cloudflare API token with the account permissions you need.
   - Set that token as `CLOUDFLARE_API_TOKEN` in that shell instead.
   - Do not put the token in the repository or in `wrangler.toml`.

## Prepare the fork

Skip this step only for the by-hand path.

2. **Prepare the fork if GitHub will deploy for you.**
   - Fork the repository.
   - Clone your fork.
   - Open the fork's Actions tab.
   - Enable workflows. GitHub leaves them off on a new fork.
   - Make the deploy workflow. Copy `.github/workflows/deploy.yml.example` to `.github/workflows/deploy.yml`, then replace the two placeholders in the copy — `<your-database-name>` and `<your-pages-project>` — with your copy's database and Pages project names. This repository ships the workflow as an example on purpose: the live service deploys from its own deployment repository, and no second live copy of its workflow stands here.
   - If the fork has no self-hosted runner labelled `self-hosted`, `linux` and `x64`, change the `runs-on` value in both the deploy workflow you just made and `.github/workflows/backup.yml` to `ubuntu-latest` in your clone.
   - Set the repository variable `TASKS_DEPLOY_ENABLED` to `true` (the fork's Settings, then Secrets and variables, then Actions, then Variables). The backup job runs only where that variable is set, so a fork that skips this backs nothing up. The deploy job needs no variable: it runs on a push to `main` once its workflow stands under its live name.
   - Leave the change unpushed until step 9. Push it after the Cloudflare pieces and secrets exist.

## Cloudflare pieces

3. **Create the database.**
   - Run `npx wrangler@4.153.0 d1 create tasksparkle`.
   - Or use the dashboard: open Workers & Pages, then D1 SQL Database, then Create database.
   - Note the database ID it gives you.
   - The deploy applies `worker/schema.sql`. You do not need to import anything by hand for the GitHub path.
   - Optional: run `npx wrangler@4.153.0 d1 create tasksparkle-auth` for a second database that holds only the sign-in tables. A flood of sign-in attempts writes defence rows; in their own database, those writes can exhaust that database's daily quota without ever touching the boards. Note its ID too. Step 7 binds it.

4. **Create the backup bucket.**
   - In the dashboard, open R2 Object Storage.
   - Create a bucket named exactly `tasksparkle-backups`.
   - Open the bucket, then Settings, then Object lifecycle rules.
   - Add a rule that expires objects 14 days after they are put there.
   - Create the bucket before the first backup run. The nightly backup workflow writes to it from that run.
   - A by-hand deployment that never enables the backup workflow can skip the bucket.

## Set up sign-in

The app runs its own sign-in — there is nothing to set up in Zero Trust, and no other service stands in front of the door. Two things belong to this step:

5. **Set the setup code, and leave the doors open.**
   - Invent a long random string — at least 22 characters; a password manager's generator is the right tool. This is the setup code: the setup page asks for it before making the first account, so a stranger who finds your brand-new copy in the minutes before you arrive cannot take that account. It is asked once and never again.
   - Keep it somewhere safe until the first account stands. Step 8 puts it into the deployment as a secret named `SETUP_CODE`.
   - Nothing gates the browser host. The sign-in page itself is the gate: accounts, passwords and passkeys live in the app, and the invite system in Settings, then Admin, is how everyone after the first person gets in.
   - Nothing gates the agent host either. That door takes agent keys only and serves no pages at all.

## Agent host DNS

6. **Add the agent host to DNS now.**
   - In the Cloudflare dashboard for your domain, open DNS, then Records, then Add record.
   - Choose type `AAAA`.
   - Enter the agent host's subdomain as the name. For `tasksparkle-api.example.com`, enter `tasksparkle-api`.
   - Enter `100::` as the IPv6 address.
   - Leave Proxy status on.
   - This is a proxied placeholder record. Cloudflare answers the name and passes `/api/*` requests to the Worker route in step 7.
   - Without this record, the agent host does not resolve at all.
   - Do not add a DNS record for the browser host by hand. Step 9 attaches it through Pages.

## The settings file

7. **Fill in the settings file.**
   - Copy `wrangler.toml.example` to `wrangler.toml`.
   - Put your two hosts in the routes. The browser host needs its sign-in routes as well as its `/api/*` route — `/login`, `/login/*`, `/setup`, `/invite/*`, `/invite-code` and `/logout` — because the Worker serves those pages itself. Leave them out and nobody can sign in.
   - Put the same hosts in the `BROWSER_HOST` and `AGENT_HOST` values.
   - Add your database ID.
   - If you made the second database in step 3, uncomment its block so it binds as `AUTH_DB`.
   - Add `OWNER_EMAILS`: your own email address. It has one job, only until your first account stands: an agent key made for you keeps working before any account exists, so an agent is never locked out of a fresh copy. After that, keys answer to accounts and the list governs nothing.
   - Check the route zone names against your domain.
   - `wrangler.toml` is in `.gitignore`, because it names your deployment. Never commit it.

## GitHub secrets

8. **Give GitHub the deployment secrets, and set the setup code.** For the GitHub path, open the fork's Settings, then Secrets and variables, then Actions, and add:
   - `CLOUDFLARE_API_TOKEN` — a Cloudflare API token that can write Workers, Pages, D1 and R2 on your account.
   - `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID.
   - `WRANGLER_TOML` — the full text of your filled-in `wrangler.toml`. A fresh checkout has no `wrangler.toml` because the file is gitignored, so the deploy workflow writes it from this secret before it reads it. The workflow hands the secret to the job for that run.

   For the by-hand path, skip these secrets. Run the three commands in step 9 whenever you deploy.

   Either way, the setup code goes on the Worker itself as a secret — never in `wrangler.toml`, which is a settings file, not a secret store. After the first deploy in step 9, run `npx wrangler@4.153.0 secret put SETUP_CODE` and paste the code from step 5. For the GitHub path, run it from your clone once the first deploy has made the Worker.

## Deploy

9. **Deploy, then attach the browser host.**
    - For the GitHub path, push to `main`.
    - Or open Actions, choose Deploy TaskSparkle and run it.
    - For the by-hand path, run the Pages command below. Its first run creates the `tasksparkle` Pages project by deploying the `public` folder.
    - The Worker deploy in the same path applies both `/api/*` routes from `wrangler.toml`. There is no separate Worker custom-domain screen to set.
    - After that first deploy, open Workers & Pages, then the `tasksparkle` Pages project, then Custom domains, then Set up a custom domain.
    - Enter the browser host and confirm.
    - Cloudflare creates and checks the DNS for that host, because the domain is already on your account.
    - If it says that exact host already has a DNS record, remove the conflicting record for that host and attach it again.
    - Wait until the custom domain reads Active before testing sign-in.

By hand, the three commands are:

```sh
npx wrangler@4.153.0 d1 execute tasksparkle --remote --file=worker/schema.sql
npx wrangler@4.153.0 deploy
npx wrangler@4.153.0 pages deploy public --project-name=tasksparkle --branch=main
```

## Test both doors

10. **Test both doors.**
    - Open `https://<browser host>`.
    - The setup page stands, because no account exists yet. Give your name and the setup code from step 5. Then pick your way in: press Make the first account with a passkey, or set a password of at least 12 characters and press Make the first account.
    - You are signed in as the administrator, and your Personal and Professional boards seed.
    - Set up an agent key with [Use TaskSparkle](using-tasksparkle.md#agent-setup).
    - Have the agent read `https://<agent host>/api/v1/version` with that key.
    - A setup page that refuses the code points back to step 8: the secret is set on the Worker, not in the settings file.
    - An agent host that does not resolve points back to step 6.

## Who gets in

Accounts are the whole membership rule. The first account is made on the setup page, behind the setup code, and its person is the administrator. Everyone after that is invited from inside the app, in Settings, then Admin: the invite link sets their name and password, and their boards seed as their own. Nobody can see anyone else's boards.

Removing a person is the administrator's act on the same page, and it ends everything of theirs at once — boards, keys, sessions and passkeys. An account's own sign-in is never visible to anyone else: not the password, not the passkeys.

One recovery door stands outside the app, for the day every administrator is locked out: `scripts/recovery-invite.mjs` mints an invite link directly against the databases, using the deployment's own Cloudflare credential, held by whoever runs the deployment and never by the running copy. Run it with the credential and the sign-in database's ID in the environment, as its header describes.

## Moving over

A copy set up under the older sign-in — Cloudflare Access in front, the email allowlist as the membership rule — moves over in this order, and keeps working at every step:

1. Update the settings file first: add the sign-in routes to the browser host, and set the `SETUP_CODE` secret. Deploy. The new build accepts the new sessions and the old Access sign-in side by side, and the Access path is frozen: it seats people who already have boards and seeds nothing new.
2. Sign in the old way once, open the setup page, and make your account. The app shows your boards standing unclaimed; claim them as yours from the notice at the top of the app. Set a password you will keep, and add a passkey.
3. Sign out, and prove the new door on its own: name and password, then the passkey.
4. Delete the Access application for the browser host, and the install-files application beside it. The door is the app's own now.
5. Prove it again with Access gone: password sign-in, passkey sign-in, and an agent key reading its boards.

Until step 2, nobody's boards move and nothing about the old door changes. A board set nobody claims keeps answering its agent keys with a refusal that names the wait, so claim yours before step 4 if your agents work while you sleep.

## Try it locally

`wrangler dev` runs the Worker on your own machine against a local database, sign-in included: the same pages stand locally, and the setup page asks for the setup code your local settings carry. It is a good way to read the code with the whole product answering.

Use local runs to work on the code. To use TaskSparkle, deploy it. The deploy is free and quick.
