# Self-hosting TaskSparkle

TaskSparkle can run on a machine in your home instead of on Cloudflare. The app, the API and your boards are the same; what changes is where they live: one Node program serves everything, and every board sits in a single SQLite file on that machine.

One thing to know before you start, stated plainly: **the local sign-in suits a trusted home network, not the open internet.** On the home network the connection is plain HTTP, so nothing is encrypted on the wire. Inside a home network that is a fair trade for a setup with no accounts to manage elsewhere and no certificates. Do not publish this server to the internet. A private mesh such as Tailscale is the safe away-from-home path described below. It keeps the server off the public internet. It also encrypts the trip. If you want a public address with internet-grade sign-in, run the Cloudflare copy instead — it is free and its sign-in is built for that job.

Sign-in itself is per person, the same promise as on Cloudflare. Signing in is passkey-first: at a secure address the sign-in page opens on the passkey, and a password stands as the fallback. Each person has their own name and sees only their own boards. A password is never shared and never sits in the config. The first account is made on the website itself. Everyone after that arrives by an invite, as the Sign in section below describes.

Two habits back that up. Every password must be at least 12 characters. Sign-in attempts are throttled: failures from one address pile up until tries from that address wait, and the wait doubles each time it locks again. One name guessed from one address locks sooner still. On a home copy no wait runs longer than a minute — a person who mistypes barely notices, and a guessing script hits a wall. And a passkey, added in Settings, then Account, cannot be guessed at all.

## What you need

- A computer that stays on while people use the boards — a desktop, a home server, a Raspberry Pi.
- Node.js 22.5 or newer installed on it (the SQLite store the server uses arrived in Node 22.5). Nothing else: the server uses only what Node carries, so there is no install step for the app itself and nothing to download when it runs.

## Set it up

1. Get the code onto the machine, for example with `git clone`, and open a terminal in the folder.

2. Make your config file. Copy `server/config.example.json` to `server/config.json`, then fill it in:

   - `port` — the port the server listens on. `8080` is fine.
   - `host` — optional. Leave it out (or empty) and the server listens on every network address, ready for the other machines in the house. Set it to `127.0.0.1` and this copy answers on the machine itself only — the right shape if you reach it through your own reverse proxy or a tunnel.
   - `dataDir` — the folder holding your data file, counted from the folder the config file lives in. The default, `data`, means `server/data` for the usual config.
   - `address` — optional. The address people use to reach this copy, like `http://your-machine.local:8080`. Invite links are built from it. Leave it out and links are built as `http://localhost:` plus your port, which only works on the machine itself.

     **Settle this address before anyone adds a passkey.** A passkey is made for one exact address: change the address later and every passkey stops working, and each person must make a new one.
   - `agentHost` — the name and port agents use to reach this machine, printed in the directions the API serves and in the app's Set Up Agent text. Use the machine's network name and the port, like `your-machine.local:8080`. If your agents run on the machine itself, `localhost:8080` is fine.
   - `signupCountries` — optional. A list of country codes, like `["CA", "US"]`, naming the countries account creation is open to when the sign-up door is open (next sections). The country is read from the `CF-IPCountry` header, which only a front door you run — a Cloudflare tunnel or proxy in front of this copy — can set truthfully; on a plain home network nothing sets it, a configured list then refuses every creation, and most home copies want this left out entirely: no list, no gate.
   - `turnstileSiteKey` and `turnstileSecretKey` — optional. A Cloudflare Turnstile widget's keys, standing a bot check on account creation: the site key is the widget's public key, the secret key its secret. Set both and creation waits for the check; leave either out and no check runs. The secret sits in this config, so keep the config file itself private, like the data file.

   Older configs may still carry a `sessionSecret` field. Sessions are server-side rows in the data file now — the server mints and revokes them itself — so the field is ignored and can be deleted.

   The config names no people and holds nothing that can sign anyone in. The install is nameless: accounts live in the data file, not the config, and the first one is made on the website (next section). The real `config.json` is gitignored, so it never travels with the code. The data file is the one to protect: it holds the password hashes and the standing sessions, so keep copies of it somewhere private.

3. Start the server:

   ```
   node server/server.mjs
   ```

   The first start creates the data folder and the data file and applies the database schema. The server prints the address it is serving, how many accounts stand, the address agents connect at and where the data lives. With no accounts yet it says so, and tells you the first name added becomes the administrator. Leave it running; to keep it running across restarts, start it the way you start anything on that machine (a scheduled task, a systemd service, a login item) with the same command.

   The config can live somewhere else, too: start with `node server/server.mjs --config /path/to/config.json`, or set the `TASKSparkle_CONFIG` environment variable to the path. That is how a second copy runs beside the first — a test instance, say: each config names its own port and data folder.

## Sign in

Open the address the server printed. While nobody has an account, that address is a setup page. It says plainly what happens next: the first name added will be the administrator.

### The first account

Type your name and a password (at least 12 characters, typed twice) and press **Make the first account**. At a secure address the page also stands the passkey way open, listed first; at this copy's plain HTTP address the password way stands alone. The account stands, it is flagged as the administrator, and you are signed in. Your Personal and Professional boards are seeded on this first sign-in, exactly as on Cloudflare.

First-wins is strict: the moment one account stands, the setup page is gone. A second setup attempt is refused in plain words and pointed at the invite path below. From then on, that address is the sign-in page.

The administrator is the person who can invite everyone else, from inside the app. There is nothing special to keep besides the password itself — and if every administrator is ever locked out, the recovery commands at the end of this guide are the way back in.

### Inviting everyone else

1. Signed in as an administrator, open Settings, then Admin. (Only administrators see that page.)
2. Under **Invite someone**, type the name the invite should carry and press **Make invite link**. The link appears in a dialog with a Copy button.
3. Send the link to that person directly — a private message in whatever chat app your household already uses. Not a group chat: until it is used, the link is a bearer secret, and anyone holding it can set that name's password. The link works for 7 days. Making a fresh invite for a name retires that name's earlier unused ones.
4. The person opens the link. Looking is safe: chat apps fetch links on their own to build previews, and merely opening the page uses nothing up. The page shows the name the invite carries, in a field the person can adjust — the name they settle is the name on the sign-in list from then on. They type their own password twice and press **Set password**. At a secure address the page stands the passkey way open first as well, and an account that starts that way holds no password. Either way, the press is what spends the link, and it lands them signed in, with their own boards seeded.

If the link arrives broken, as links in chat sometimes do, the sign-in page has an "Have an invite?" box that takes the bare code from the end of the link instead and leads to the same page. The full code also stands in the invite dialog, under the link, when it is made from the command line (see Recovery).

### Opening sign-up

A copy can also let anyone who reaches it make their own account. That is the sign-up door, and it is shut in the way you would want at home: the switch stands at invite-only until you flip it, and flipping it is one stored value in the data file — [Run the service](operations.md#the-sign-up-door) gives the statement. While the switch stands open, the sign-in page carries a **Create your account** entry and the sign-up page makes an account by the same two ways as an invite — a password, or a passkey at a secure address — landing the person signed in with their own boards seeded. While it stands at invite-only or closed, the sign-up page refuses in plain words and invites work exactly as above. The country list and bot check in the config above can guard creation while the door stands open; neither ever guards signing in.

### Signing in

The sign-in page lists the names of the accounts that stand — one entry per account. Pick your name, type your password, and you are in. At a secure address the page opens on the passkey instead, with a switch to the password view below it. A refusal never says which half was wrong: a name with no account and a wrong password get the same plain answer.

One catch with this address: it is ordinary HTTP, and passkeys need a secure address. So at this address passkeys are off — the sign-in page stands in its password form and says the site is not encrypted, with a link to the routes to HTTPS below, and the Account page offers no passkey adding. Passkeys work at a secure address: on the machine itself, opened as `localhost`, or through a Tailscale Serve address, which is HTTPS (below). Passkeys a person made at such an address still list on the Account page here, and can be removed here. Passkeys and passwords have their own guide: [Passkeys and passwords](passkeys-and-passwords.md).

Names are matched without case: "Robin" and "robin" are the one account. A name is a name — nothing on this copy asks for or shows an email address. (A person can still change the name shown on their boards later, in Settings, then Account. That display name outranks the sign-in name in the app; the sign-in name itself does not change.)

### A forgotten password

A forgotten password is a fresh invite. On the Admin page, each account's row has a **New password link** button: it mints an invite carrying that account's name. Send it the same way. The invite page for an existing account keeps the name fixed — it names the account — and spending the link replaces the password, signs out every sign-in and keeps the boards. It never touches the account's passkeys: a passkey comes off only by a named act — the person's own removal, an administrator removing it by name, or the Start fresh choice the reset form carries. An account that signs in with passkeys alone gets the same link — its button reads **Recovery link** — and its page enrols a new passkey instead of setting a password. There is no other reset path, and nobody — not even an administrator — ever knows anyone else's password.

### Administrators and removal

On the Admin page, **Make administrator** flags another account as an administrator. **Remove** erases a person — behind a dialog that names what goes: their account, their boards and everything on them, and their keys. No undo.

One guard stands over all of it: the only administrator cannot be removed, lose the flag, or erase their own account while other accounts stand — the copy would be left with nobody who can invite or remove anyone. The refusal names the way out: make another person an administrator first. An administrator who is the last account standing can still erase their own account.

A person can always erase themselves: in the app, Settings, then Account, then Delete my boards and account. That deletes their boards, cards, comments and agent keys in one act, along with their password and any invite of theirs still standing, and it ends their session. It is the person's own act — an agent key cannot do it.

Signing out is in the app's Account page, as usual; the local door answers at the same link.

### Older configs

Two older config shapes refuse to start, with a message naming the change and the way over:

- A config carrying `householdPassword` or `householdPasswordHash` (the shared-password setup). Remove those two fields and start again; then the first account is made on the setup page, as above.
- A config carrying a `people` list (the setup where the config named who could sign in). Remove `people` and start again.

Accounts already in the data file stand as they were in both cases: boards, cards and passwords carry over untouched. A person whose account stood under an email address signs in under that address as their name — it is the name on their sign-in entry until they spend a fresh invite and settle a new one. The earliest account standing becomes the administrator, so somebody can always work the Admin page.

## Away from home

Use a private mesh when the household needs the boards away from home. **Tailscale** is the known example. It puts the server machine and each person's phone and laptop on one private WireGuard network, called a tailnet. The TaskSparkle server stays off the public internet, and traffic between devices in the tailnet is encrypted even though the local app address begins with `http://`.

1. Install Tailscale on the machine that runs TaskSparkle.
2. Install Tailscale on each phone and laptop that should reach the boards.
3. Sign every installation in to the same tailnet and approve the devices in the Tailscale admin page when it asks.
4. In `server/config.json`, set `address` to the server machine's MagicDNS address with the TaskSparkle port, such as `http://your-machine.<your-tailnet>.ts.net:8080`, and set `agentHost` to the same host and port without `http://`. Invite links and the agent directions then carry the address that works away from home.
5. Leave the server running and Tailscale connected. A person opens the `address` and signs in as usual. A device that is not in the tailnet cannot use that address.

One shape needs its own word: the server runs inside WSL on a Windows machine. There, install Tailscale inside the WSL as well, and sign it in as its own device with its own name — `tasks`, say, giving `tasks.<your-tailnet>.ts.net`. The reason: Serve on the Windows side sends callers to an address on the Windows machine, and the server inside the WSL does not answer there. With Tailscale inside the WSL, the server's part of the steps above, and the Serve steps below, run inside the WSL, and every address in them carries the WSL device's name.

The config's `host` field sets how widely the Node server listens. Leave `host` out for the direct mesh setup: the server can answer on the home network and on the tailnet. Set `host` to `127.0.0.1` only when a local gateway is the intended front door. Tailscale Serve is that gateway, and the next section sets it up.

### Tailscale Serve

The mesh address above begins with `http://`. The tailnet encrypts the trip, but the address a browser sees is still an ordinary HTTP one — and passkeys need a secure address (HTTPS), so they stay off there. **Tailscale Serve** fixes that. Serve stands in front of the server on the same machine and offers it inside your tailnet at an HTTPS address with a real certificate, like `https://your-machine.<your-tailnet>.ts.net` — no port in the address. Only devices in your tailnet can open it, exactly as with the mesh address. The difference the household feels: at the Serve address, each person can add a passkey and sign in with it, as on Cloudflare.

1. First check what Serve already offers on that machine:

   ```
   tailscale serve status
   ```

   If the list is empty, the machine's HTTPS name is free. If anything stands there, step 3 would put TaskSparkle on that same name and push what stands there aside. Pick a different home for one of them first: Serve can offer TaskSparkle on another port instead (the command in step 3 grows `--https=8443`, and the address it prints carries that port), or the server can get its own tailnet device, as in the WSL passage above.
2. Set `host` to `127.0.0.1` in `server/config.json`, so the server listens on the machine itself only, and restart it. Serve is the front door now. Know what this restart does: from it, the old address stops answering. On an install reached through a port forward, it dies at this moment, before Serve is up. Everyone who uses the boards moves to the Serve address, so finish the steps below in one sitting.
3. On that machine, run:

   ```
   tailscale serve --bg 8080
   ```

   Use the port from your config if yours is not 8080. Serve's commands may need more rights than an ordinary account has: if one answers "serve config denied", run it with `sudo`, or set yourself as the operator once — `sudo tailscale set --operator=$USER` — and the plain commands work from then on. The first time, Tailscale may ask you to turn on HTTPS certificates for your tailnet in its admin page; the command says where. Serve prints the address it made.
4. In `server/config.json`, set `address` to the address Serve printed, like `https://your-machine.<your-tailnet>.ts.net`, and set `agentHost` to the same name without the `https://`. Restart the server. Invite links and the agent directions then carry the Serve address.
5. Open the Serve address and sign in as usual. Settings, then Account, can now add a passkey, and the sign-in page offers it.

Serve is not Funnel. Serve shows the service only inside your tailnet. **Funnel publishes a service to the open internet, which is the shape this guide tells you not to use — do not use Funnel for this server.**

To turn Serve off, run `tailscale serve --https=443 off` on the machine — the form the command itself names when Serve starts. That takes down the HTTPS listener Serve made. (`tailscale serve reset` clears every Serve setting on the machine; reach for it only when nothing else stands there.) Then put `host`, `address` and `agentHost` back as they were, and restart the server. The copy is back on its mesh address. Passkeys made at the Serve address work again if Serve returns with the same name — they belong to that name, as the warning under **Set it up** says.

A hand-built WireGuard network is the same shape as a tailnet: install WireGuard on the server and on each device, give the server a stable address on that private network, then use that address and port for `address` and `agentHost`.

### Routes to HTTPS

Serve is one route to a secure address. Here are the routes worth knowing, in the order to try them. Every route ends at a name, and the warning under **Set it up** governs them all: settle the name before anyone adds a passkey, because moving to a new name later means every person makes a new one.

1. **Tailscale Serve** — the section above. The least work: a real certificate, renewed by Tailscale on its own, and the copy stays private inside the tailnet. The cost is that every phone and laptop that uses the boards runs Tailscale. Use Serve rather than Tailscale's certificate files, which leave the renewing to you.
2. **Your own domain, a certificate proved by DNS, and local DNS.** A reverse proxy stands in front of the server — Nginx Proxy Manager or Zoraxy if you want point-and-click, Caddy or Traefik if you are at home in config files. The proxy gets a Let's Encrypt certificate by proving it controls the domain in DNS, so no port opens to the internet and nothing about the copy is published. Your router, or a home DNS service, then points the name at the proxy inside the house. Every device on the home Wi-Fi reaches the copy at a real HTTPS name with nothing installed on it — new phones and guests included. The costs: a domain to buy and keep renewing, and the most setup of any route here.
3. **Caddy's own certificate authority.** Caddy can also sign the certificates itself, for a name you invent. A browser trusts that name only where someone has installed Caddy's root certificate, so every phone and laptop needs that install, one by one — and a device that missed it gets warnings and no passkeys. Free, and no domain to buy; it suits a small household that can keep up with the installs.
4. **Cloudflare Tunnel — only if you mean it.** A tunnel gives the copy a trusted HTTPS name with no open ports, but it publishes the copy to the open internet: anyone who learns the name reaches the sign-in page. That is the shape the start of this guide tells you not to use. If you choose it anyway, put Cloudflare Access in front of it with an allow list, and keep the app updated.

One route does not work at all: **a plain self-signed certificate gives no passkeys.** A name a browser warns about is not a secure address, and clicking through the warning does not make it one — the passkey acts stay off. Caddy's authority in route 3 is a different shape: once its root is installed, the browser trusts the name outright, with no warning to click through.

## Recovery commands

Day to day, invites and removals are the administrator's job inside the app, and first-run setup never needs a terminal. Two commands stand as the recovery door, for when no administrator can sign in. Both work whether or not the server is running — the data file is the meeting point — and both work on a config the server itself would refuse, because they are part of the way back.

Mint an invite for a name:

```
node server/server.mjs --invite "Their Name"
```

The command prints the link and, under it, the bare code. A name with no account makes a first-password invite; a name that already stands makes a reset, and the invite page keeps that name fixed. If the name only needs its case settled, the person can adjust it on the page for a new account.

Remove a person by name:

```
node server/server.mjs --delete-person "Their Name"
```

It erases the account under that name from the data file: their boards and everything on them, their keys, their password and their invites — the same whole the Admin page's Remove erases. When there is nothing to erase — a mistyped name, or a person already erased — it says so and stops with an error, so a failed erasure never passes as a done one.

Copies you made of the data file for backup are yours to keep or delete; an erasure here does not reach into them.

## Agent setup

Agent keys work exactly as on Cloudflare. In the app, open Settings, then Set Up Agent, and copy the bootstrap text into your agent: it names this machine's address, because the state carries the `agentHost` from your config. Add a key there when the agent asks, and paste the key to the agent once. The full directions are served by the API itself at `GET /api/v1/directions`, same as on Cloudflare, and carry the local address.

One difference from Cloudflare, worth knowing: there is one address here, not two doors. People and agents knock at the same name. A request with a key is an agent; a request with a session is a person; the checks underneath are the same ones the two Cloudflare doors enforce.

To follow changes with a key, use [Watching for changes](watching-for-changes.md). Its digest example works against this same address because a self-hosted copy has one door for people and agents.

## Backups

Every board lives in one file: `tasksparkle.sqlite` in your data folder. To back up, stop the server and copy that file somewhere safe. Stopping matters: a clean stop folds the server's working log back into the one file, so the copy is the whole truth. To restore, put the file back in the data folder and start the server. The file is ordinary SQLite, readable with any SQLite tool — your data is never locked into a format only this app can read.

The same file holds each person's password as a salted hash built to make testing a guess expensive — never the password itself, but enough that a backup deserves care: keep copies somewhere private.

## Update

An update replaces the program files and nothing else. Your config file and your data folder are not part of the code, and an update keeps both exactly as they are.

1. Stop the server.
2. Put the new code in place of the old: `git pull` if you cloned the code, or lay the new program files over the old ones. Leave `server/config.json` and the data folder (the default is `server/data`) untouched.
3. Start the server again, the way you start it every time.

Accounts, passwords and invites live in the data file, not the config, so there is nothing in the config for a start to rewrite. If a release adds a database column, the schema the server applies at every start adds it; nothing needs a hand-run command. A stopped server is also the safe moment to copy the data file aside — see Backups, above.

## How it works

The API is one shared core (`worker/core.js`) that both homes run, and the sign-in is one shared door too (`worker/auth.js`): the same accounts, passkeys, sessions and Admin page on both copies. The Cloudflare entry (`worker/worker.js`) wraps the core with a Durable Object for live updates; this server wraps it with a local SQLite store behind the same database shape, and a small socket hub that plays the Durable Object's part — when a change lands, each open board hears the new version number and refreshes, as it does on Cloudflare. The local pieces are `server/server.mjs`, `server/d1-adapter.mjs` and `server/push-hub.mjs`, and they use nothing outside Node's standard library.
