# Passkeys and passwords

Signing in is passkey-first, with a password as the fallback. The choice is each person's own, it can change any time, and the boards never change with it. This guide explains both ways in, what signing in without a password costs, and how anyone gets back in when a way in is lost.

## Two ways in

A password is something you type. A passkey is something your device holds — a phone, a laptop, a security key — and it signs you in with a tap, a face or a fingerprint instead of typing.

The passkey stands first. The sign-in page opens on it, and the password is one tap away. An account works with a password alone, with both, or with a passkey alone. Nothing about your boards, your cards or your agent keys changes with the choice, and no one else — not even the administrator — can make the choice for you.

A new account picks its first way in on the page that creates it: the setup page, the invite page and the sign-up page stand both ways open, the passkey way first, and either one creates the account. An account that starts with a passkey holds no password at all, and can add one later whenever it wants.

## The sign-in page

At a secure address the sign-in page opens on the passkey: your name, and the passkey button as the page's main act. A small switch below it reads **Use a password instead** and trades the page to the password form, with **Use a passkey instead** as the way back.

The switch trades which way stands first, never what is possible. The password is one tap away on every sign-in, whatever your account holds. And a passkey your browser offers through the name field works in either view.

The device remembers which view you last used and opens there next time. A new device opens on the passkey view. Enrolling a passkey — on the setup, invite or sign-up page, or later in Account — makes the passkey that device's view from then on, until you switch it yourself.

## Adding a passkey

Add a passkey in Settings, then Account. Give it a name that says which device it lives on.

The first passkey is proven by what you already have: a fresh password sign-in, so a borrowed signed-in screen cannot plant one. Once a passkey stands, adding another takes a passkey tap instead. A password alone can never grow the passkey set behind your back, and the passkeys you hold stand listed on the Account page, where you can see every one.

## Passkey-only sign-in

Once a passkey stands, you may remove your password. The act lives on the Account page, under the password section: **Remove my password**. It asks for one fresh passkey tap — the tap proves the passkeys carry you before the password goes — and a dialog names what changes before you confirm.

Nothing about your boards changes. Your other sign-ins are signed out, this one stays, and your passkeys are untouched.

A password can always come back. On the same page, **Add a password** sets one again, behind a passkey tap, under the same rules as any password here: at least 12 characters, and not one of the passwords people use most.

## What passkey-only costs

With no password standing, your ways back in are another passkey or a link a person hands you. There is no password road: no reset by email, no security question, nothing the app sends you by itself.

Two more costs, named before you choose:

- A passkey belongs to the exact address it was made at. If this copy's address changes, the passkeys stop working — and on a passkey-only account that is a lockout, not an inconvenience.
- Never remove your password while this copy's only address is ordinary HTTP. Passkeys cannot run at such an address, so a passkey-only account could not sign in there at all. Give the copy HTTPS first, by any route in the hosting guide's ranked list.

## Getting back in

Recovery is always a person or the operator handing you a link. The app never sends one by itself.

- **You hold a password and forgot it:** the administrator — the first account on this copy — sends you a reset link from Settings, then Admin. Spending it sets a new password and signs out every sign-in.
- **You sign in with passkeys and lost them all:** the administrator sends you a link the same way. Your invite opens a recovery page instead of a password form, and spending it enrols a fresh passkey and signs out every sign-in.
- **You run this copy:** the operator can mint the same link at the machine — a command on a home copy, the deployment's own credential on a hosted copy. That is the floor under every account, and it is held by a person, never by the app alone.

## Resets and passkeys

Setting or resetting a password never touches your passkeys. A reset replaces the password and signs out every sign-in, and every passkey stands exactly as it stood.

A passkey comes off an account only by a named act:

- your own removal, on your Account page;
- the administrator removing that named passkey on the Admin page, when a device is lost;
- your own **Start fresh** choice, standing on the reset form and on the recovery page: it removes your passkeys and enrols a new one in the same spend.

That last point carries an instruction, not just a rule: if you reset your password *because* a passkey may be compromised, the reset is not finished until that passkey is removed. Reset, then remove the passkey by name — or pick Start fresh on the form and do both at once.

## The address rules

A passkey runs only at an address the browser genuinely trusts: HTTPS with a real certificate, or a localhost address on the machine itself. The hosting guides rank the routes to such an address.

Clicking through a certificate warning does not restore passkeys. A name the browser warns about is not a secure address, however the warning is answered.

Settle the address before anyone enrols. A passkey is made for one exact address, so pick the name the copy will keep, then invite people and let them enrol.

## Running this copy

The operator holds the floor under every account. What the operator can do:

- mint a recovery link at the machine or through the deployment, for any account, password or passkey-only;
- read the audit log of sign-in acts the app keeps.

What the operator cannot do:

- sign in as another person, or use their passkey;
- enrol a passkey for another person;
- drop another person's password, or set one for them.

One warning, stated before anyone chooses it: if the copy's only administrator removes their password and then loses every passkey, no path inside the product brings them back. The way in is then the operator's own link, minted at the machine or the deployment — the same person, wearing the other hat. Keep a password, or keep a second passkey on another device, if that trade is not worth it.
