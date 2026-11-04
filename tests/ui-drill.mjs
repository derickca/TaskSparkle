// TaskSparkle UI drill: the standing browser checks, written for
// a self-host instance on a throwaway config (see tests/README.md).
// It signs in through the local sign-in page as a throwaway
// person, sees the seeded boards, works a card end to end (make
// it in the inbox, add a checklist step, tick it, close, reopen
// and find it ticked), mints an agent key in Settings and reads
// the state back through the API with that key, and proves live
// push: a change made through the API lands on the open board
// without a reload. It walks the label colour modes (issues #94
// and #95): a board's mode, switched in Settings → Boards and
// through the API, paints its cards' first label colour as a
// faded background, a thick trim or a top band on the board's
// faces at both widths and, thinner-lined, on the phone
// overview's rows — the editor and a label-less card never
// paint. It also walks the account page: the person
// renames themselves and the name stands after a reload (issue
// #66), the local mirror is checked to hold no name — a stale
// one seeded on purpose is cleared, and logging out clears the
// mirror whole (issue #58) — and the whole run listens for a
// content-security-policy violation and reads the app page's
// security headers (issue #70). It ends with the person's own
// erasure (issue #57): the account page's delete confirm opens
// and stands down at desktop width, then the phone walk deletes
// the account for real and the run's minted key is dead.
// It walks the Settings board pickers (issue #96): Labels and
// Projects each pick their board from a dropdown, the Columns
// pattern — the page lists only the picked board's labels or
// projects, an add lands on the picked board, and the page
// opens on the board the person is looking at in the main
// view, not on the last pick. And it walks the card delete
// dialog (issue #97): Delete — in the editor and in the
// Archived list — opens a fresh dialog over what stands
// underneath, the editor's edits survive standing it down,
// and confirming deletes, at desktop and phone widths.
// It walks the agent key dialogs (issue #98): adding a key
// opens a dialog carrying the key with a copy button, and
// closing the dialog leaves the key nowhere on the page;
// deleting a key asks in a dialog over the untouched list —
// the row it was pressed on never expands into the question,
// standing the dialog down keeps the key working, and
// confirming kills it. Both dialogs are screenshotted at
// desktop and phone widths.
// It walks the dialog sweep (issue #99): deleting a project
// asks in one shared dialog — from Settings → Projects and
// from the press-and-hold editor alike — over the untouched
// row or editor; deleting a board and deleting a label, which
// used to act on one click, ask in dialogs naming what goes
// with them; and deleting the account asks in a dialog too,
// its type-DELETE field inside the dialog (the issue #57
// section below uses the dialog's selectors). All four
// dialogs are screenshotted at desktop and phone widths.
// Screenshots of the sign-in page and the board land in the
// output folder at desktop and phone widths, for a person to
// look at.
//
// It walks the sign-in page's remembered name and the
// transition door's Account section (issue #112, issue #110)
// in a fresh context of its own: the remembered name pre-picks
// the drill person's name on the sign-in page, unticking the
// box clears it at once and the next visit pre-picks nothing.
// It then walks the same instance at a plain-HTTP home-style
// address (issue #113): no passkey act is offered there, the
// line stands in its place, and a passkey made at the secure
// address still lists and can be removed;
// and with the sign-in routes refusing (the shape the
// transition door presents), the Account page's sign-in
// section stands disabled under its note instead of bouncing
// to the sign-in page, while a board-API refusal still
// bounces, as it should. Given --hosted-base (the Worker
// rig), it also walks the hosted sign-in page in a browser:
// the conditional passkey offer starts as the page loads and
// a password sign-in is undisturbed by it, a passkey signs
// in from the page's own button, and the remembered name
// fills the typed field and clears the same way. The rig
// serves no front end, so a landed sign-in there is proven
// by the session itself, and the enrolment runs from the
// sign-in page through the Account page's own calls — the
// app's enrolment click is covered on the self-host
// instance, whose Account section the walks above read.
//
// Usage:
//   node tests/ui-drill.mjs --base http://host:PORT \
//     --name "Drill A" --password <that person's own password> \
//     --out /path/to/screenshots \
//     [--hosted-base https://host:PORT --hosted-name "Drill A" \
//      --hosted-password <that person's password on the rig>]
//   node tests/ui-drill.mjs --spend-family 1 --base https://host:PORT \
//     [--setup-code <the fresh copy's setup code>]
//     runs only the spend-pages family (issue #128) against a
//     FRESH copy — no account stands when it starts — and exits.
//
// Sign-in on a self-host copy picks the person's name from the
// sign-in page's list and types their password (issue #107);
// the drill does the same, by checking the name's radio.
//
// Playwright is the one tool the drills borrow rather than
// bundle. tests/README.md gives the fresh-clone install route.
// The script imports playwright-core (or playwright) from
// wherever the runner keeps it: set PLAYWRIGHT_MODULE to the
// module entry file itself (for example a path ending in
// playwright-core/index.mjs), not to the module folder, and
// CHROMIUM_PATH to a Chromium executable file if the default
// launch finds none.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
}
const BASE = args.base;
const NAME = args.name || "Drill A";
const PASSWORD = args.password;
const B_PASSWORD = args["password-b"] || PASSWORD;
const HOSTED = args["hosted-base"] || null;
const HOSTED_NAME = args["hosted-name"] || "Drill A";
const HOSTED_PASSWORD = args["hosted-password"] || "";
const OUT = args.out || "/tmp/ui-drill-shots";
if (!BASE || (!PASSWORD && !args["spend-family"])) {
  console.error("usage: see the header of tests/ui-drill.mjs");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

let pw = null;
for (const name of [process.env.PLAYWRIGHT_MODULE, "playwright-core", "playwright"]) {
  if (!name) continue;
  try { pw = await import(name); break; } catch (e) { /* try the next */ }
}
if (!pw) {
  console.error("No Playwright module found. Follow the UI drill setup in tests/README.md, or set PLAYWRIGHT_MODULE to a playwright-core/index.mjs file.");
  process.exit(2);
}

let failures = 0;
let count = 0;
function check(name, cond, detail) {
  count += 1;
  if (!cond) failures += 1;
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail ? "  — " + detail : ""));
}

// The sign-in page's two views (issue #122): at a secure
// address a fresh device opens on the passkey view, where the
// password field stands hidden behind the switch. Walks whose
// subject is the app rather than the switch flip to the
// password view first; at an HTTP address there is no switch
// and the field always stands, so this is a no-op there. The
// switch itself is walked on its own in the #122 sections.
async function showPasswordView(p) {
  const field = p.locator('input[name="password"]');
  const hidden = await field.isHidden().catch(() => false);
  if (hidden) {
    await p.click("#view-switch");
    await field.waitFor({ state: "visible", timeout: 5000 });
  }
}

const browser = await pw.chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  // drill-home.local names this same machine under a
  // home-style name (issue #113): the browser resolves it to
  // the loopback, but the address is no secure context, which
  // is the whole point of the plain-HTTP walk below.
  args: ["--no-sandbox",
    "--host-resolver-rules=MAP drill-home.local 127.0.0.1"],
});

// --- The spend pages in the order they offer (issues #128, #141) ----
// The passkey-first enrolment walks on a FRESH copy: no
// account stands when the run starts. The mode runs only
// with --spend-family, ahead of every other walk, and exits —
// the lane runs it against a fresh self-host instance and a
// fresh Worker rig in turn. It guards the trap the fresh-eyes
// walk found (issue #128): the setup page's switch hid the
// whole form, and with it the name and setup-code fields its
// passkey press reads, so a person who tapped "Use a passkey
// instead" first met a failure no retry could fix. The pages
// now stand both ways open, the passkey way first with equal
// standing (issue #141), so the walks assert that standing —
// both ways visible, the passkey block above the password
// block, no switch anywhere — press the passkey button with
// the fields standing empty first, the order a new person
// meets them, and afterwards read the device's sign-in view:
// an enrolment makes the passkey that device's view, and a
// later manual switch is still remembered after that.
if (args["spend-family"]) {
  const SETUP_NAME = "Drill Setup";
  const INVITEE_NAME = "Drill Invitee";
  const SETUP_CODE = args["setup-code"] || null;

  async function spendContext(width) {
    const ctx = await browser.newContext({
      viewport: { width, height: width <= 480 ? 844 : 900 },
      ignoreHTTPSErrors: true,
    });
    const p = await ctx.newPage();
    const cdp = await ctx.newCDPSession(p);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2", transport: "internal", hasResidentKey: true,
        hasUserVerification: true, isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    return { ctx, p };
  }
  const meOf = (p) => p.evaluate(async () => {
    const res = await fetch("/api/auth/me");
    return { status: res.status, body: await res.json().catch(() => null) };
  });
  const errorTextOf = async (p) => {
    await p.locator("#spend-error").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    return p.locator("#spend-error").innerText().catch(() => "");
  };
  // The two ways' standing on a spend page (issue #141): the
  // ceremony button and the password fields both visible,
  // the passkey block above the password block, no switch.
  const standingOf = (p) => p.evaluate(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0;
    const block = document.getElementById("spend-passkey");
    const pwBlock = document.getElementById("spend-password");
    return {
      bothVisible: vis(document.getElementById("spend-passkey-button")) &&
        vis(document.querySelector('input[name="password"]')),
      passkeyFirst: !!block && !!pwBlock &&
        (block.compareDocumentPosition(pwBlock) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      switchGone: !document.getElementById("spend-switch"),
    };
  });

  // The phone-width probe opens the setup page exactly like
  // the walk below. It spends nothing: an empty press is
  // refused before any ceremony.
  {
    const { ctx, p } = await spendContext(390);
    await p.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
    const standing = await standingOf(p);
    check("#141: at phone width the setup page stands both ways open, the passkey first",
      standing.bothVisible && standing.passkeyFirst && standing.switchGone,
      JSON.stringify(standing));
    check("#128: at phone width the name field the press reads stands visible",
      await p.locator('input[name="name"]').isVisible(), "");
    if (SETUP_CODE) {
      check("#128: at phone width the setup code field the press reads stands visible",
        await p.locator('#spend-code').isVisible(), "");
    }
    await p.screenshot({ path: join(OUT, "spend-setup-passkey-390.png"), fullPage: true });
    await p.click("#spend-passkey-button");
    const err = await errorTextOf(p);
    check("#128: at phone width an empty press names the missing name",
      err.includes("Add your name first"), err);
    await p.screenshot({ path: join(OUT, "spend-setup-missing-390.png"), fullPage: true });
    await ctx.close();
  }

  // The setup page, walked in the order it offers: passkey first.
  const { ctx, p } = await spendContext(1280);
  await p.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  const setupStanding = await standingOf(p);
  check("#141: the fresh copy's setup page stands both ways open, the passkey first",
    setupStanding.bothVisible && setupStanding.passkeyFirst && setupStanding.switchGone,
    JSON.stringify(setupStanding));
  check("#128: the name field the press reads stands visible",
    await p.locator('input[name="name"]').isVisible(), "");
  if (SETUP_CODE) {
    check("#128: the setup code field the press reads stands visible",
      await p.locator('#spend-code').isVisible(), "");
  }
  await p.screenshot({ path: join(OUT, "spend-setup-passkey-1280.png"), fullPage: true });
  await p.click("#spend-passkey-button");
  const errEmpty = await errorTextOf(p);
  check("#128: an empty press names the missing name instead of the generic failure",
    errEmpty.includes("Add your name first"), errEmpty);
  await p.screenshot({ path: join(OUT, "spend-setup-missing-1280.png"), fullPage: true });
  await p.fill('input[name="name"]', SETUP_NAME);
  if (SETUP_CODE) {
    await p.click("#spend-passkey-button");
    const errCode = await errorTextOf(p);
    check("#128: a press with the name but no code names the missing setup code",
      errCode.includes("Add the setup code first"), errCode);
    await p.fill('#spend-code', SETUP_CODE);
  }
  await p.click("#spend-passkey-button");
  await p.waitForURL(BASE + "/", { timeout: 15000 }).catch(() => {});
  const meSetup = await meOf(p);
  check("#128: filling the standing fields and pressing the passkey button completes the enrolment — a passkey-only first account",
    meSetup.status === 200 && !!meSetup.body && meSetup.body.name === SETUP_NAME &&
      meSetup.body.hasPassword === false && meSetup.body.passkeys.length === 1,
    "status " + meSetup.status + " url " + p.url());

  // The invite the new administrator mints, spent the same way.
  const minted = await p.evaluate(async (name) => {
    const res = await fetch("/api/auth/invites", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, INVITEE_NAME);
  const inviteCode = minted.body && minted.body.code;
  check("#128: the first account mints an invite for the invite-page walk",
    !!inviteCode, "status " + minted.status);

  // The enrolment made the passkey this device's sign-in
  // view (issue #141): signed out, the sign-in page opens on
  // the passkey view — and a manual switch to the password
  // view is still remembered after that.
  await p.goto(BASE + "/logout", { waitUntil: "domcontentloaded" });
  check("#141: after the enrolment the device's next sign-in opens on the passkey view",
    (await p.locator("#view-passkey").isVisible()) &&
      (await p.locator("#passkey-button").isVisible()), "");
  await p.click("#view-switch");
  await p.locator("#view-password").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  await p.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  check("#141: a later manual switch to the password view is remembered after that",
    await p.locator("#view-password").isVisible(), "");
  await ctx.close();

  if (inviteCode) {
    const inv = await spendContext(1280);
    await inv.p.goto(BASE + "/invite/" + inviteCode, { waitUntil: "domcontentloaded" });
    const invStanding = await standingOf(inv.p);
    check("#141: the invite page stands both ways open, the passkey first, the invitee's name filled in",
      invStanding.bothVisible && invStanding.passkeyFirst && invStanding.switchGone &&
        (await inv.p.locator('input[name="name"]').inputValue()) === INVITEE_NAME,
      JSON.stringify(invStanding));
    check("#128: the invitee's name field the press reads stands visible",
      await inv.p.locator('input[name="name"]').isVisible(), "");
    await inv.p.screenshot({ path: join(OUT, "spend-invite-passkey-1280.png"), fullPage: true });
    await inv.p.fill('input[name="name"]', "");
    await inv.p.click("#spend-passkey-button");
    const errInvite = await errorTextOf(inv.p);
    check("#128: an invite press with the name cleared names the missing name",
      errInvite.includes("Add your name first"), errInvite);
    await inv.p.fill('input[name="name"]', INVITEE_NAME);
    await inv.p.click("#spend-passkey-button");
    await inv.p.waitForURL(BASE + "/", { timeout: 15000 }).catch(() => {});
    const meInvite = await meOf(inv.p);
    check("#128: filling the name completes the invite enrolment — a passkey-only account",
      meInvite.status === 200 && !!meInvite.body && meInvite.body.name === INVITEE_NAME &&
        meInvite.body.hasPassword === false && meInvite.body.passkeys.length === 1,
      "status " + meInvite.status + " url " + inv.p.url());
    await inv.p.goto(BASE + "/logout", { waitUntil: "domcontentloaded" });
    check("#141: after the invite enrolment the device's next sign-in opens on the passkey view",
      (await inv.p.locator("#view-passkey").isVisible()) &&
        (await inv.p.locator("#passkey-button").isVisible()), "");

    // Removing your own passkey asks first (issue #136): the
    // invitee signs back in, and the removal is walked. The
    // confirm names the passkey and what stands after; for
    // this passkey-only account it states the last-passkey
    // order, and confirming still meets the server's refusal
    // in its own words — the passkey stands. With a password
    // added, the same dialog's shape changes and the removal
    // lands. The sign-in page rebuilds its passkey button as
    // its own options call lands, and a click can lose its
    // node to the rebuild: press, and press again if the
    // session did not follow. The landed sign-in is proven
    // by the session itself — the hosted rig serves no front
    // end to land on.
    let meBack136 = null;
    for (let attempt = 0; attempt < 3 && !meBack136; attempt++) {
      await inv.p.click("#passkey-button").catch(() => {});
      const meTry = await meOf(inv.p).catch(() => null);
      if (meTry && meTry.status === 200 && meTry.body &&
          meTry.body.name === INVITEE_NAME) meBack136 = meTry.body;
      if (!meBack136) await inv.p.waitForTimeout(1000);
    }
    check("#136: the invitee signs back in with the passkey",
      !!meBack136, "url " + inv.p.url());
    if (SETUP_CODE) {
      // The hosted rig serves no front end, so the Account
      // page's dialog cannot be walked here — the same
      // removal acts are driven through the Account page's
      // own calls instead, the way the hosted walk drives
      // enrolment, and the dialog itself is walked on the
      // self-host copy, which serves the same app.
      const call136 = (method, path, body) => inv.p.evaluate(
        async ({ m, u, b }) => {
          const res = await fetch(u, {
            method: m,
            headers: b ? { "Content-Type": "application/json" } : {},
            body: b ? JSON.stringify(b) : undefined,
          });
          return { status: res.status, json: await res.json().catch(() => null) };
        }, { m: method, u: path, b: body || null });
      const pkId136 = meBack136 && meBack136.passkeys &&
        meBack136.passkeys[0] && meBack136.passkeys[0].id;
      const refuse136 = await call136("DELETE",
        "/api/auth/passkeys/" + encodeURIComponent(pkId136 || ""));
      check("#136: on the rig, the last passkey on a passwordless account refuses in the server's own words",
        refuse136.status === 400 && !!refuse136.json &&
          /Add a password first/.test(refuse136.json.error || ""),
        "status " + refuse136.status + " body " + JSON.stringify(refuse136.json).slice(0, 120));
      const add136 = await call136("POST", "/api/auth/password",
        { new_password: "invitee-password-136" });
      check("#136: the invitee adds a password behind the sign-in's fresh proof",
        add136.status === 200, "status " + add136.status);
      const remove136 = await call136("DELETE",
        "/api/auth/passkeys/" + encodeURIComponent(pkId136 || ""));
      const meFinal136 = await meOf(inv.p);
      check("#136: with a password standing, the removal lands",
        remove136.status === 200 && meFinal136.status === 200 &&
          !!meFinal136.body && meFinal136.body.passkeys.length === 0 &&
          meFinal136.body.hasPassword === true,
        "remove " + remove136.status + " me " + meFinal136.status);
      await inv.ctx.close();
      await browser.close();
      console.log(count + " checks, " + failures + " failures");
      process.exit(failures === 0 ? 0 : 1);
    }
    await inv.p.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
    await inv.p.click("#settings-open");
    await inv.p.click('[data-settings-page="settings-account"]');
    await inv.p.waitForSelector("#account-passkeys-list .board-manage-row", { timeout: 10000 });
    await inv.p.locator("#account-passkeys-list .board-manage-row button",
      { hasText: "Remove" }).first().click();
    await inv.p.waitForSelector("#own-passkey-remove-backdrop:not([hidden])", { timeout: 10000 });
    const ownText = await inv.p.locator("#own-passkey-remove-text").textContent();
    check("#136: removing your own passkey opens a confirm naming the passkey and the last-passkey order",
      (ownText || "").includes("Remove your passkey") &&
        (ownText || "").includes("only passkey") &&
        (ownText || "").includes("Add a password first"),
      (ownText || "").slice(0, 140));
    await inv.p.screenshot({ path: join(OUT, "wave3-own-passkey-remove-1280.png") });
    await inv.p.click("#own-passkey-remove-cancel");
    await inv.p.waitForSelector("#own-passkey-remove-backdrop[hidden]",
      { state: "attached", timeout: 10000 });
    const ownKept = await inv.p.locator("#account-passkeys-list .board-manage-row").count();
    check("#136: standing the dialog down keeps the passkey",
      ownKept === 1, "rows=" + ownKept);
    await inv.p.locator("#account-passkeys-list .board-manage-row button",
      { hasText: "Remove" }).first().click();
    await inv.p.waitForSelector("#own-passkey-remove-backdrop:not([hidden])", { timeout: 10000 });
    await inv.p.click("#own-passkey-remove-confirm");
    await inv.p.waitForFunction(() => {
      const n = document.getElementById("account-auth-note");
      return !!n && /Add a password first/.test(n.textContent || "");
    }, undefined, { timeout: 10000 }).catch(() => {});
    const ownStillThere = await inv.p.locator("#account-passkeys-list .board-manage-row").count();
    check("#136: the last passkey on a passwordless account still refuses, in the server's own words",
      ownStillThere === 1, "rows=" + ownStillThere);
    await inv.p.fill("#account-password-new", "invitee-password-136");
    await inv.p.fill("#account-password-confirm", "invitee-password-136");
    await inv.p.click("#account-password-btn");
    await inv.p.waitForTimeout(1500);
    const meInvitee2 = await meOf(inv.p);
    check("#136: the invitee adds a password behind the enrolment session's fresh proof",
      meInvitee2.status === 200 && !!meInvitee2.body && meInvitee2.body.hasPassword === true,
      "status " + meInvitee2.status);
    await inv.p.locator("#account-passkeys-list .board-manage-row button",
      { hasText: "Remove" }).first().click();
    await inv.p.waitForSelector("#own-passkey-remove-backdrop:not([hidden])", { timeout: 10000 });
    const ownText2 = await inv.p.locator("#own-passkey-remove-text").textContent();
    check("#136: with a password standing, the dialog says the password still stands",
      (ownText2 || "").includes("Your password still stands"),
      (ownText2 || "").slice(0, 140));
    await inv.p.click("#own-passkey-remove-confirm");
    await inv.p.waitForFunction(() => {
      const list = document.getElementById("account-passkeys-list");
      return !!list && (list.textContent || "").includes("No passkeys yet.");
    }, undefined, { timeout: 10000 }).catch(() => {});
    const meInvitee3 = await meOf(inv.p);
    check("#136: confirming removes the passkey when a password stands",
      meInvitee3.status === 200 && !!meInvitee3.body &&
        meInvitee3.body.passkeys.length === 0 && meInvitee3.body.hasPassword === true,
      "status " + meInvitee3.status);
    await inv.ctx.close();
  }

  await browser.close();
  console.log(count + " checks, " + failures + " failures");
  process.exit(failures === 0 ? 0 : 1);
}

// --- Desktop: sign in, boards, the card end to end ------------------------------
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
// Issue #70: the run listens for a content-security-policy
// refusal anywhere in the app, and keeps the app page's own
// response headers for the header checks at the end.
const cspViolations = [];
page.on("console", (msg) => {
  const text = msg.text();
  if (/Content Security Policy|Refused to (load|execute|apply|connect|frame|fetch)/.test(text)) {
    cspViolations.push(text);
  }
});
page.on("pageerror", (err) => {
  if (/Content Security Policy/.test(String(err))) cspViolations.push(String(err));
});
let docHeaders = null;
page.on("response", (resp) => {
  if (docHeaders === null && resp.status() === 200 &&
      (resp.url() === BASE + "/" || resp.url() === BASE + "/index.html")) {
    docHeaders = resp.headers();
  }
});
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForURL(/\/login/, { timeout: 10000 }).catch(() => {});
check("sign-in: the front door lands on the sign-in page", page.url().includes("/login"), page.url());
await page.screenshot({ path: join(OUT, "login-1280.png") });
await page.check('input[name="name"][value="' + NAME + '"]');
await showPasswordView(page);
await page.fill('input[name="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
check("sign-in: the boards load after signing in", true, page.url());
// The name the person goes by on this instance, read from
// their own record: the API drill runs before this drill on
// the same instance and sets a display name there, so the
// comment-author checks below expect that name, not the
// sign-in name (issue #120 resolves author names live).
const PERSON_NAME = await page.evaluate(async () => {
  const r = await fetch("/api/v1/me");
  const j = await r.json().catch(() => null);
  return j && j.name;
});
check("sign-in: the person's current name reads back for the author checks",
  typeof PERSON_NAME === "string" && PERSON_NAME.length > 0, "name=" + PERSON_NAME);
const boardNames = await page.locator("#board-switcher button").allTextContents();
check("boards: Personal and Professional stand seeded",
  boardNames.some((t) => t.includes("Personal")) && boardNames.some((t) => t.includes("Professional")),
  boardNames.join(" | "));
const columnHeads = await page.locator("#columns .column-head, #columns section h2, #columns section h3").allTextContents().catch(() => []);
await page.screenshot({ path: join(OUT, "board-1280.png") });

const TITLE = "UI drill card " + Date.now();
await page.click('button[data-add-to="inbox"]');
await page.waitForSelector("#editor-backdrop:not([hidden])", { timeout: 10000 });
await page.fill("#field-title", TITLE);
await page.fill("#checklist-add-input", "Drill step");
await page.click("#checklist-add-btn");
await page.waitForSelector("[data-step-row]", { timeout: 10000 });
await page.check('[data-step-row] input[data-role="step-done"]');
await page.click("#editor-close");
await page.waitForSelector("#editor-backdrop[hidden]", { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(800); // the save queue drains
const cardVisible = await page.locator(".card .card-title", { hasText: TITLE }).count();
check("cards: the new card stands on the board", cardVisible >= 1, "matches: " + cardVisible);

await page.locator(".card", { hasText: TITLE }).first().click();
await page.waitForSelector("#editor-backdrop:not([hidden])", { timeout: 10000 });
const stepChecked = await page.isChecked('[data-step-row] input[data-role="step-done"]');
const stepText = await page.locator("[data-step-row] .step-text").first().textContent();
check("checklist: the step stands ticked on reopen", stepChecked && stepText === "Drill step",
  "checked=" + stepChecked + " text=" + stepText);

// A comment left in the editor (issues #51, #120): every
// comment names its author — the person's comment wears
// their name the way a key's comment wears the key's.
await page.fill("#comment-add-input", "UI drill update");
await page.click("#comment-add-btn");
await page.waitForSelector("[data-comment-row]", { timeout: 10000 });
const commentText = await page.locator("[data-comment-row] .comment-body").first().textContent();
const commentAuthors = await page.locator('[data-comment-row] [data-role="comment-author"]').count();
const commentAuthorText = await page.locator('[data-comment-row] [data-role="comment-author"]').first().textContent().catch(() => null);
check("comments: the person's comment stands in the editor wearing their name",
  commentText === "UI drill update" && commentAuthors === 1 &&
    (commentAuthorText || "").trim() === PERSON_NAME,
  "text=" + commentText + " author tags=" + commentAuthors + " author=" + commentAuthorText);
await page.screenshot({ path: join(OUT, "editor-comments-1280.png") });
await page.click("#editor-close");
await page.waitForTimeout(400);

// --- Settings: mint a key, then read state with it through the API ---------------
await page.click("#settings-open");
await page.click('[data-settings-page="setup-agent"]');
await page.waitForSelector("#key-add", { timeout: 10000 });
const instructions = await page.inputValue("#agent-instructions");
check("agent setup: the bootstrap carries this deployment's own address",
  instructions.includes(BASE.replace(/^https?:\/\//, "").replace(/\/$/, "") + "/api/v1") ||
  instructions.includes("/api/v1"), instructions.split("\n").find((l) => l.includes("agent API")) || "");
await page.fill("#key-add-name", "UI drill key");
await page.click("#key-add");
// Issue #98: the new key arrives in a dialog of its own, over
// the page as it stands — never inline above the list.
let createdDialogOpened = true;
await page.waitForSelector("#key-created-backdrop:not([hidden])", { timeout: 10000 })
  .catch(() => { createdDialogOpened = false; });
check("#98: adding a key opens a dialog carrying the new key",
  createdDialogOpened, "");
const mintedKey = await page.inputValue("#agent-key");
check("keys: the minted key is shown once, in the dialog",
  typeof mintedKey === "string" && mintedKey.startsWith("tsk_live_"), mintedKey ? mintedKey.slice(0, 9) + "…" : "none");
await page.screenshot({ path: join(OUT, "key-created-1280.png") });
// The dialog's Copy button puts the key on the clipboard: the
// button itself says so when the copy lands.
await page.click("#copy-key");
await page.waitForFunction(
  () => document.getElementById("copy-key").textContent === "Copied",
  undefined, { timeout: 5000 }).catch(() => {});
const copySaid = await page.locator("#copy-key").textContent();
check("#98: the dialog's Copy button copies the key and says so",
  (copySaid || "").trim() === "Copied", "button says: " + copySaid);
await page.click("#key-created-close");
await page.waitForSelector("#key-created-backdrop[hidden]", { state: "attached", timeout: 10000 });
// Shown once means gone once the dialog closes: the value
// stands in no field and in no text on the page.
const keyLeftOnPage = await page.evaluate((key) => {
  const inFields = Array.from(document.querySelectorAll("input, textarea"))
    .some((el) => (el.value || "").includes(key));
  const inText = (document.body.innerText || "").includes(key);
  return inFields || inText;
}, mintedKey);
check("#98: closing the dialog leaves the key nowhere on the page",
  !keyLeftOnPage, "");

// --- Admin: the administrator's page (issue #107) -------------------------------
// This instance's first account is its administrator — the
// server flags the earliest standing account when none is
// flagged — so the Admin entry stands in the Settings list
// for this sign-in. The walk mints an invite for a new name
// and reads the link out of its dialog. The dialog must be
// the top thing on screen, not merely unhidden: a backdrop
// that opens under the Settings panel passes every state
// check while showing the person nothing, so the walk asks
// what actually sits at the dialog's centre.
await page.click("#settings-back");
await page.waitForSelector("#settings-people-btn:not([hidden])", { timeout: 10000 })
  .catch(() => {});
const peopleEntryShown = await page.evaluate(() =>
  !document.getElementById("settings-people-btn").hidden);
check("#124: the administrator sees the Admin entry in Settings", peopleEntryShown, "");
// Issue #124: the entry carries the new name and stands
// last in the list — after Set Up Agent, at the end.
const settingsOrder = await page.evaluate(() =>
  Array.from(document.querySelectorAll("#settings-list .settings-list-btn"))
    .filter((b) => !b.hidden)
    .map((b) => (b.querySelector("span") || {}).textContent || ""));
check("#124: the Admin entry stands last in the administrator's Settings list",
  settingsOrder[settingsOrder.length - 1] === "Admin", settingsOrder.join(" / "));
check("#125: the Admin entry is rendered for the administrator",
  await page.locator("#settings-people-btn").isVisible(), "");
await page.screenshot({ path: join(OUT, "settings-list-admin-1280.png") });
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: join(OUT, "settings-list-admin-390.png") });
await page.setViewportSize({ width: 1280, height: 900 });
await page.click("#settings-people-btn");
await page.waitForSelector("#people-list", { timeout: 10000 });
await page.fill("#people-invite-name", "Drill C");
await page.click("#people-invite-btn");
let inviteDialogOpened = true;
await page.waitForSelector("#invite-created-backdrop:not([hidden])", { timeout: 10000 })
  .catch(() => { inviteDialogOpened = false; });
check("#107: minting an invite on the Admin page opens its dialog",
  inviteDialogOpened, "");
const inviteLink = await page.inputValue("#invite-link");
check("#107: the dialog carries the invite link",
  typeof inviteLink === "string" && inviteLink.includes("/invite/"),
  inviteLink ? "code " + inviteLink.split("/").pop().slice(0, 6) + "…" : "none");
const dialogOnTop = await page.evaluate(() => {
  const box = document.querySelector("#invite-created-backdrop .copy-dialog");
  if (!box) return false;
  const r = box.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && box.contains(hit);
});
check("#107: the invite dialog stands over the Settings panel, where a person can use it",
  dialogOnTop, "");
await page.screenshot({ path: join(OUT, "admin-invite-1280.png") });
await page.evaluate(() => document.getElementById("invite-created-close").click());
await page.click("#settings-close").catch(() => {});

// --- Admin: no entry for a non-administrator (issue #124) -----------------------
// The people read is what decides whether the entry
// stands: an administrator's browser gets the roster, a
// non-administrator's gets a refusal — the API drill
// proves that refusal against Drill B's own session. Here
// the read is refused by route inside a signed-in context,
// so the app's own hide path is what is exercised: the
// entry stands hidden in the page, and a refused probe
// never lifts it.
{
  const nctx = await browser.newContext({
    viewport: { width: 1280, height: 900 }, serviceWorkers: "block",
  });
  const npage = await nctx.newPage();
  await npage.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await npage.check('input[name="name"][value="' + NAME + '"]');
  await showPasswordView(npage);
  await npage.fill('input[name="password"]', PASSWORD);
  await npage.click('button[type="submit"]');
  await npage.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  await npage.route("**/api/auth/people", (route) => route.fulfill({
    status: 403, contentType: "application/json",
    body: JSON.stringify({ error: "Administrators only." }),
  }));
  const peopleRead = npage.waitForRequest(
    (req) => req.url().includes("/api/auth/people"), { timeout: 10000 }).catch(() => null);
  await npage.reload({ waitUntil: "domcontentloaded" });
  await npage.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  await npage.click("#settings-open");
  await peopleRead;
  const nonAdmin = await npage.evaluate(() => {
    const btn = document.getElementById("settings-people-btn");
    const visible = Array.from(document.querySelectorAll("#settings-list .settings-list-btn"))
      .filter((b) => !b.hidden)
      .map((b) => (b.querySelector("span") || {}).textContent || "");
    return { btnHidden: !btn || btn.hidden, visible };
  });
  check("#124: a non-administrator's Settings list carries no Admin entry at all",
    nonAdmin.btnHidden && !nonAdmin.visible.includes("Admin"),
    nonAdmin.visible.join(" / "));
  // The rendered row, not only the property (issue #125):
  // a hidden settings-list button must not stand in the
  // list a person sees.
  check("#125: the Admin entry is not rendered for a non-administrator",
    !(await npage.locator("#settings-people-btn").isVisible()), "");
  await npage.screenshot({ path: join(OUT, "settings-list-nonadmin-1280.png") });
  await npage.setViewportSize({ width: 390, height: 844 });
  await npage.screenshot({ path: join(OUT, "settings-list-nonadmin-390.png") });
  await nctx.close();
}

const apiRes = await fetch(BASE + "/api/v1/state", {
  headers: { Authorization: "Bearer " + mintedKey },
});
const apiState = await apiRes.json().catch(() => null);
check("keys: the minted key reads the state through the API, with a name and no email (issue #65)",
  apiRes.status === 200 && apiState && apiState.me && apiState.me.email === undefined &&
    typeof apiState.me.name === "string" && apiState.me.name.length > 0,
  "status " + apiRes.status);
const drillCard = apiState && (apiState.cards || []).find((c) => c.title === TITLE);
check("cards: the UI-made card reads back through the API with its step ticked",
  !!drillCard && drillCard.steps.length === 1 && drillCard.steps[0].done === true,
  drillCard ? JSON.stringify(drillCard.steps) : "missing");
check("comments: the editor's comment reads back through the API with the person's name",
  !!drillCard && drillCard.comments.length === 1 &&
    drillCard.comments[0].body === "UI drill update" && drillCard.comments[0].authorKeyName === null &&
    drillCard.comments[0].authorName === PERSON_NAME,
  drillCard ? JSON.stringify(drillCard.comments) : "missing");

// --- Key delete: a dialog over the untouched list (issue #98) ------------------
// A second key, made and deleted inside this section, so the
// run's working key above is never the one at risk. Delete
// asks in a dialog; the row it was pressed on never expands
// into the question.
const KEY2_NAME = "UI drill key two";
await page.click("#settings-open");
await page.click('[data-settings-page="setup-agent"]');
await page.waitForSelector("#key-add", { timeout: 10000 });
await page.fill("#key-add-name", KEY2_NAME);
await page.click("#key-add");
await page.waitForSelector("#key-created-backdrop:not([hidden])", { timeout: 10000 });
const keyTwo = await page.inputValue("#agent-key");
await page.click("#key-created-close");
await page.waitForSelector("#key-created-backdrop[hidden]", { state: "attached", timeout: 10000 });
const keyTwoRow = page.locator("[data-key-row]", { hasText: KEY2_NAME });
await keyTwoRow.locator('[data-role="key-delete"]').click();
await page.waitForSelector("#key-delete-backdrop:not([hidden])", { timeout: 10000 });
const rowConfirmCount = await page.locator(".key-confirm").count();
const rowStillWhole = await keyTwoRow.locator('[data-role="key-delete"]').isVisible();
const keyDeleteText = await page.locator("#key-delete-text").textContent();
check("#98: deleting a key opens a dialog — the row never expands into the question",
  rowConfirmCount === 0 && rowStillWhole,
  "in-row confirms=" + rowConfirmCount + " row delete still shown=" + rowStillWhole);
check("#98: the dialog names the key, the stop-at-once and the stamps that keep the name",
  (keyDeleteText || "").includes(KEY2_NAME) && /stops working at once/.test(keyDeleteText || "") &&
    /keep its name/.test(keyDeleteText || ""),
  (keyDeleteText || "").slice(0, 130));
check("#152: the dialog also says what happens to cards the key holds — their step comes back to the owner",
  /Cards whose next step it holds come back to you/.test(keyDeleteText || ""),
  (keyDeleteText || "").slice(0, 160));
await page.screenshot({ path: join(OUT, "key-delete-1280.png") });
await page.click("#key-delete-cancel");
await page.waitForSelector("#key-delete-backdrop[hidden]", { state: "attached", timeout: 10000 });
const keyTwoAlive = await fetch(BASE + "/api/v1/state", {
  headers: { Authorization: "Bearer " + keyTwo },
});
check("#98: standing the dialog down keeps the key working",
  keyTwoAlive.status === 200, "status " + keyTwoAlive.status);
await keyTwoRow.locator('[data-role="key-delete"]').click();
await page.waitForSelector("#key-delete-backdrop:not([hidden])", { timeout: 10000 });
await page.click("#key-delete-confirm");
await page.waitForFunction(
  (name) => !Array.from(document.querySelectorAll("[data-key-row]"))
    .some((r) => (r.textContent || "").includes(name)),
  KEY2_NAME, { timeout: 10000 }).catch(() => {});
const keyTwoRowGone = await page.locator("[data-key-row]", { hasText: KEY2_NAME }).count();
const keyTwoDead = await fetch(BASE + "/api/v1/state", {
  headers: { Authorization: "Bearer " + keyTwo },
});
check("#98: confirming in the dialog deletes the key — row gone, key dead",
  keyTwoRowGone === 0 && keyTwoDead.status === 401,
  "rows=" + keyTwoRowGone + " status " + keyTwoDead.status);
await page.click("#settings-close").catch(() => {});

// --- Wave 3: the sweep's remaining fixes, walked (issues #135, #137,
// #138, #139, #148, #150, #151) -------------------------------------------------
// The Admin activity list in plain words (issue #148): the
// roster's recent-activity rows name acts as what happened —
// an invite made, a passkey added — never the stored codes,
// and no row carries a credential fragment.
await page.click("#settings-open");
await page.click('[data-settings-page="settings-people"]');
await page.waitForSelector("#people-list", { timeout: 10000 });
await page.waitForFunction(() => {
  const el = document.getElementById("people-audit");
  return !!el && (el.textContent || "").trim().length > 0;
}, undefined, { timeout: 10000 }).catch(() => {});
const auditTextW3 = await page.locator("#people-audit").innerText().catch(() => "");
check("#148: the Admin activity list speaks in plain words, not act codes",
  auditTextW3.includes("Invite made") &&
    !auditTextW3.includes("invite-minted") &&
    !auditTextW3.includes("passkey-added") &&
    !auditTextW3.includes("passkey-removed") &&
    !auditTextW3.includes("account-created"),
  auditTextW3.slice(0, 180));
await page.screenshot({ path: join(OUT, "wave3-admin-activity-1280.png") });
await page.click("#settings-close").catch(() => {});

// Removing an empty column asks first (issue #135): a fresh
// column with no cards in it opens the same dialog the full
// columns open, with no destination to pick; standing it
// down keeps the column, and confirming removes it.
await page.click("#settings-open");
await page.click('[data-settings-page="settings-columns-section"]');
await page.waitForSelector("#settings-columns-list [data-column-row]", { timeout: 10000 });
await page.click("#column-add-btn");
// The add lands with a save and a rebuild or two, and the
// fresh row can be rebuilt under a fill while they settle:
// find the row by the name standing in it, fill it, and if
// the fill lost its row, find it again.
const w3FindCol = () => page.evaluate(() => {
  const inputs = Array.from(
    document.querySelectorAll('#settings-columns-list [data-role="column-name"]'));
  const input = inputs.find((i) => i.value === "Wave3 Empty") ||
    inputs.find((i) => i.value === "New column");
  const row = input && input.closest("[data-column-row]");
  return row ? row.getAttribute("data-column-row") : null;
});
let w3ColId = null;
for (let attempt = 0; attempt < 4 && !w3ColId; attempt++) {
  await page.waitForFunction(() => Array.from(
    document.querySelectorAll('#settings-columns-list [data-role="column-name"]')
  ).some((i) => i.value === "New column" || i.value === "Wave3 Empty"),
    undefined, { timeout: 10000 }).catch(() => {});
  const idNow = await w3FindCol();
  if (!idNow) break;
  const named = await page.evaluate((id) => {
    const input = document.querySelector(
      '#settings-columns-list [data-column-row="' + id + '"] [data-role="column-name"]');
    return !!input && input.value === "Wave3 Empty";
  }, idNow);
  if (named) { w3ColId = idNow; break; }
  try {
    await page.fill(
      '#settings-columns-list [data-column-row="' + idNow + '"] [data-role="column-name"]',
      "Wave3 Empty", { timeout: 4000 });
    w3ColId = idNow;
  } catch { /* the row rebuilt under the fill — find it again */ }
}
check("#135: the fresh column takes its drill name",
  !!w3ColId, "id " + w3ColId);
await page.keyboard.press("Tab");
// The id captured above can still be the column's temporary
// one: the create's answer, landing after the capture, swaps
// the real id into the row, and every later lookup by the
// temporary id finds no row. Wait on the condition itself —
// the row carrying the drill name carries an id with no
// temporary marker — then take the id from that row.
await page.waitForFunction(() => {
  const inputs = Array.from(
    document.querySelectorAll('#settings-columns-list [data-role="column-name"]'));
  const input = inputs.find((i) => i.value === "Wave3 Empty");
  const row = input && input.closest("[data-column-row]");
  return !!row && row.getAttribute("data-column-row").indexOf("-tmp-") === -1;
}, undefined, { timeout: 10000 }).catch(() => {});
const w3RealId = await w3FindCol();
if (w3RealId) w3ColId = w3RealId;
await page.waitForFunction((id) => {
  const row = document.querySelector(
    '#settings-columns-list [data-column-row="' + id + '"]');
  const note = row && row.querySelector('[data-role="column-remove-note"]');
  return !!note && note.textContent.includes("asks first");
}, w3ColId, { timeout: 10000 }).catch(() => {});
const w3ColNote = await page.locator(
  '#settings-columns-list [data-column-row="' + w3ColId + '"] [data-role="column-remove-note"]'
).textContent().catch(() => "");
const w3RowHtml = await page.evaluate((id) => {
  const row = document.querySelector(
    '#settings-columns-list [data-column-row="' + id + '"]');
  return row ? row.textContent.replace(/\s+/g, " ").slice(0, 200) : "NO ROW";
}, w3ColId).catch(() => "EVAL FAILED");
check("#135: the empty column's row says removing it asks first",
  (w3ColNote || "").includes("asks first"),
  "note=" + JSON.stringify(w3ColNote) + " row=" + w3RowHtml);
await page.locator(
  '#settings-columns-list [data-column-row="' + w3ColId + '"] [data-role="column-remove"]'
).click();
await page.waitForSelector("#column-remove-backdrop:not([hidden])", { timeout: 10000 });
const w3ColText = await page.locator("#column-remove-text").textContent();
const w3ColDestHidden = await page.locator("#column-remove-dest-row").isHidden();
const w3ColSubmit = await page.locator("#column-remove-submit").textContent();
check("#135: removing an empty column asks first, in the standing dialog, with no destination to pick",
  (w3ColText || "").includes("Wave3 Empty") && (w3ColText || "").includes("holds no cards") &&
    w3ColDestHidden && (w3ColSubmit || "").trim() === "Remove column",
  (w3ColText || "").slice(0, 120) + " | submit: " + (w3ColSubmit || "").trim());
await page.screenshot({ path: join(OUT, "wave3-column-remove-1280.png") });
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: join(OUT, "wave3-column-remove-390.png") });
await page.setViewportSize({ width: 1280, height: 900 });
await page.click("#column-remove-cancel");
await page.waitForSelector("#column-remove-backdrop[hidden]", { state: "attached", timeout: 10000 });
const w3ColKept = await page.locator(
  '#settings-columns-list [data-column-row="' + w3ColId + '"]').count();
check("#135: standing the dialog down keeps the empty column",
  w3ColKept === 1, "rows=" + w3ColKept);
await page.locator(
  '#settings-columns-list [data-column-row="' + w3ColId + '"] [data-role="column-remove"]'
).click();
await page.waitForSelector("#column-remove-backdrop:not([hidden])", { timeout: 10000 });
await page.click("#column-remove-submit");
await page.waitForFunction((id) =>
  !document.querySelector('#settings-columns-list [data-column-row="' + id + '"]'),
  w3ColId, { timeout: 10000 }).catch(() => {});
const w3ColGone = await page.locator(
  '#settings-columns-list [data-column-row="' + w3ColId + '"]').count();
check("#135: confirming in the dialog removes the empty column",
  w3ColGone === 0, "rows=" + w3ColGone);
await page.click("#settings-close").catch(() => {});

// Search's Archived bubble widens the results (issue #139):
// two cards share a word, one live and one archived. With
// the bubble off only the live one stands; with it on, both.
const w3Cards = await page.evaluate(async () => {
  const st = await (await fetch("/api/v1/state")).json();
  const board = st.boards[0];
  const mk = async (title) => {
    const res = await fetch("/api/v1/cards", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board_id: board.id, column_id: "inbox", title }),
    });
    return (await res.json()).card;
  };
  const live = await mk("Wave3 Zebra live");
  const arch = await mk("Wave3 Zebra archived");
  const st2 = await (await fetch("/api/v1/state")).json();
  await fetch("/api/v1/cards/" + arch.id, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived: true, baseVersion: st2.version }),
  });
  return { liveId: live.id, archId: arch.id };
});
await page.waitForTimeout(600);
await page.click("#search-toggle");
await page.fill("#search-input", "Wave3 Zebra");
await page.waitForFunction(() =>
  document.querySelectorAll("#search-results .search-result").length === 1,
  undefined, { timeout: 10000 }).catch(() => {});
const w3TitlesOff = await page.locator("#search-results .search-result-title").allTextContents();
check("#139: with the Archived bubble off, search shows the live match only",
  w3TitlesOff.length === 1 && w3TitlesOff[0].includes("Wave3 Zebra live"),
  w3TitlesOff.join(" | "));
await page.click("#search-filters-btn");
await page.click("#search-archived-bubble");
await page.waitForFunction(() =>
  document.querySelectorAll("#search-results .search-result").length === 2,
  undefined, { timeout: 10000 }).catch(() => {});
const w3TitlesOn = await page.locator("#search-results .search-result-title").allTextContents();
check("#139: with the bubble on, the archived match stands beside the live one",
  w3TitlesOn.length === 2 &&
    w3TitlesOn.some((t) => t.includes("Wave3 Zebra live")) &&
    w3TitlesOn.some((t) => t.includes("Wave3 Zebra archived")),
  w3TitlesOn.join(" | "));
await page.screenshot({ path: join(OUT, "wave3-search-archived-1280.png") });
await page.click("#search-archived-bubble");
await page.click("#search-toggle");

// The editor: a refused link and a capped comment (issues
// #150, #151), then the failed save (issue #137) — all on
// the live Zebra card.
await page.locator(".card", { hasText: "Wave3 Zebra live" }).first().click();
await page.waitForSelector("#editor-backdrop:not([hidden])", { timeout: 10000 });
await page.fill("#link-add-url", "junk%20junk");
await page.click("#link-add-btn");
await page.waitForFunction(() => {
  const err = document.getElementById("link-error");
  return !!err && !err.hidden && (err.textContent || "").includes("not a web address");
}, undefined, { timeout: 10000 }).catch(() => {});
const w3LinkRows = await page.locator("#links-list .link-row").count();
const w3LinkErr = await page.locator("#link-error").textContent();
check("#150: a refused link address leaves no phantom row, and the refusal stands beside the field",
  w3LinkRows === 0 && (w3LinkErr || "").includes("That is not a web address"),
  "rows=" + w3LinkRows + " error=" + (w3LinkErr || "").slice(0, 80));
await page.screenshot({ path: join(OUT, "wave3-link-refusal-1280.png") });
const w3LongComment = "x".repeat(2001);
await page.fill("#comment-add-input", w3LongComment);
await page.click("#comment-add-btn");
await page.waitForSelector("#comment-error:not([hidden])", { timeout: 10000 }).catch(() => {});
const w3CapText = await page.locator("#comment-error").textContent();
const w3Draft = await page.inputValue("#comment-add-input");
const w3CommentRows = await page.locator("#comments-list [data-comment-row]").count();
check("#151: a comment past the cap refuses at the editor — the count named, the draft kept, nothing posted",
  (w3CapText || "").includes("2,001") && (w3CapText || "").includes("2,000") &&
    w3Draft === w3LongComment && w3CommentRows === 0,
  "error=" + (w3CapText || "").slice(0, 90) + " draft=" + w3Draft.length + " rows=" + w3CommentRows);
await page.screenshot({ path: join(OUT, "wave3-comment-cap-1280.png") });
await page.fill("#comment-add-input", "");

// A failed save keeps its banner and its text (issue #137):
// the card PATCH is aborted at the network while the editor
// commits a new title; the state reload that follows the
// failure must not clear the banner, and a close pressed
// while the retry is still failing must not complete — the
// editor stays open holding the text. With the way clear,
// the close lands and the edit is on the card.
await page.route("**/api/cards/*", (route) => {
  if (route.request().method() === "PATCH") route.abort();
  else route.continue();
});
await page.fill("#field-title", "Wave3 Zebra live edited");
await page.locator("#field-notes").click();
await page.waitForSelector("#api-error:not([hidden])", { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1000);
const w3BannerStays = await page.locator("#api-error").isVisible().catch(() => false);
check("#137: a failed save's banner is still standing after the reload that follows it",
  w3BannerStays, "");
await page.click("#editor-close");
await page.waitForTimeout(1000);
const w3EditorStays = await page.locator("#editor-backdrop:not([hidden])").isVisible().catch(() => false);
const w3TitleKept = await page.inputValue("#field-title");
check("#137: a close pressed against a failing save waits — the editor stays open with the person's text",
  w3EditorStays && w3TitleKept === "Wave3 Zebra live edited",
  "editor open=" + w3EditorStays + " title=" + w3TitleKept);
await page.screenshot({ path: join(OUT, "wave3-failed-save-1280.png") });
await page.unroute("**/api/cards/*");
await page.click("#editor-close");
await page.waitForSelector("#editor-backdrop[hidden]", { state: "attached", timeout: 10000 });
const w3SavedTitle = await page.evaluate(async (id) => {
  const st = await (await fetch("/api/v1/state")).json();
  const card = st.cards.find((c) => c.id === id);
  return card ? card.title : null;
}, w3Cards.liveId);
check("#137: with the way clear the close lands, and the edit is on the card",
  w3SavedTitle === "Wave3 Zebra live edited", "title=" + w3SavedTitle);

// An open app picks up a newer build (issue #138): the
// version answers are turned to a moved stamp, and a tab
// return — the visibility the app already listens for —
// reloads the app once; the boot that follows meets the
// same stamp and, the guard remembering it, loads instead
// of reloading again.
const w3Version = await page.evaluate(async () => {
  const res = await fetch("/api/version");
  return res.json().catch(() => null);
});
await page.evaluate(() => { window.__wave3Mark = "before"; });
let w3VersionAnswers = 0;
// The route stands at the context level, not the page's:
// after the reload the page is service-worker controlled,
// and the worker's own fetches pass a page route by.
await page.context().route("**/api/version", (route) => {
  w3VersionAnswers++;
  route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ version: w3Version && w3Version.version, build: "r9999-wave3-1" }),
  });
});
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await page.waitForFunction(() => window.__wave3Mark === undefined,
  undefined, { timeout: 15000 }).catch(() => {});
await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 }).catch(() => {});
const w3MarkGone = await page.evaluate(() => window.__wave3Mark === undefined).catch(() => true);
check("#138: an open app reloads itself once when a check meets a newer build",
  w3MarkGone && w3VersionAnswers >= 1,
  "mark gone=" + w3MarkGone + " version answers=" + w3VersionAnswers);
// And no more than once: a fresh mark stands on the
// reloaded app, the version answers still carry the moved
// stamp, and another tab return checks again — the answer
// count rises, the mark survives, because the boot's guard
// remembers this stamp was already reloaded for.
await page.evaluate(() => { window.__wave3Mark2 = "after"; });
const w3AnswersBefore = w3VersionAnswers;
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
for (let i = 0; i < 40 && w3VersionAnswers <= w3AnswersBefore; i++) {
  await page.waitForTimeout(100);
}
const w3Second = await page.evaluate(() => ({
  mark: window.__wave3Mark2,
})).catch(() => ({ mark: undefined }));
check("#138: a further check against the same moved build does not reload again",
  w3Second.mark === "after" && w3VersionAnswers > w3AnswersBefore,
  "mark=" + w3Second.mark + " answers " + w3AnswersBefore + " -> " + w3VersionAnswers);
await page.screenshot({ path: join(OUT, "wave3-build-reload-1280.png") });
await page.context().unroute("**/api/version");

// --- Live push: an API change lands on the open board ------------------------------
const RENAMED = TITLE + " (renamed by push)";
const patch = await fetch(BASE + "/api/v1/cards/" + drillCard.id, {
  method: "PATCH",
  headers: { Authorization: "Bearer " + mintedKey, "Content-Type": "application/json" },
  body: JSON.stringify({ title: RENAMED }),
});
check("push: the API rename answers 200", patch.status === 200, "status " + patch.status);
let pushed = false;
try {
  await page.waitForSelector(".card .card-title:text-is(\"" + RENAMED + "\")", { timeout: 8000 });
  pushed = true;
} catch (e) { /* the board did not update on its own */ }
check("push: the open board shows the change without a reload", pushed, "");
await page.screenshot({ path: join(OUT, "board-after-push-1280.png") });

// --- Creator tags (issue #50): a key-made card's maker is named -------------------
// The face rule since issue #123: the maker tag stands only
// when the step holder is not the key that made the card.
// A fresh key-made card holds its maker's step, so its face
// wears the step chip alone — the tag's standing shapes are
// walked in the #121 and #123 sections below.
const KEY_TITLE = "Key-made card " + Date.now();
const personalBoard = apiState.boards.find((b) => b.name === "Personal");
const keyCardRes = await fetch(BASE + "/api/v1/cards", {
  method: "POST",
  headers: { Authorization: "Bearer " + mintedKey, "Content-Type": "application/json" },
  body: JSON.stringify({ board_id: personalBoard.id, column_id: "inbox", title: KEY_TITLE }),
});
const keyCardJson = await keyCardRes.json().catch(() => null);
check("creators: a key-made card answers with the key's name and no creator on the person-made one",
  keyCardRes.status === 201 && keyCardJson && keyCardJson.card &&
    keyCardJson.card.creatorKeyName === "UI drill key" && drillCard.creatorKeyName === null,
  "status " + keyCardRes.status + " creator " + (keyCardJson && keyCardJson.card && keyCardJson.card.creatorKeyName));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
await page.waitForSelector(".card .card-title:text-is(\"" + KEY_TITLE + "\")", { timeout: 10000 });
const keyCardEl = page.locator(".card", { hasText: KEY_TITLE }).first();
const tagCount = await keyCardEl.locator("[data-creator-tag]").count();
check("#123: a card whose maker holds its step wears no maker tag — the step chip alone names the key",
  tagCount === 0, "tags=" + tagCount);
const personCardEl = page.locator(".card", { hasText: RENAMED }).first();
const personTagCount = await personCardEl.locator("[data-creator-tag]").count();
check("creators: the person-made card wears no tag", personTagCount === 0, "tags=" + personTagCount);
const faceCommentCount = await personCardEl.locator("[data-comment-count]").textContent().catch(() => null);
check("comments: the face shows the comment count",
  (faceCommentCount || "").includes("1"), "count=" + faceCommentCount);
await page.screenshot({ path: join(OUT, "creator-tag-1280.png") });

// --- The editor names the maker (issue #126) -----------------------------------
// The face names a card's maker, but the editor never did —
// Derick: "when in edit mode I can't tell who wrote the card."
// Under the title the editor now reads "Made by <name>", the
// name in the creator-tag pill, resolved live the way the
// face's tag and the comments' authors are: a key-made card
// names its key, and a person-made card names the person.
await keyCardEl.click();
await page.waitForSelector("#editor-backdrop:not([hidden])", { timeout: 10000 });
const keyMakerLine = await page.locator('[data-role="card-maker"]').textContent().catch(() => null);
check("#126: the editor on a key-made card reads Made by the key's name",
  (keyMakerLine || "").replace(/\s+/g, " ").trim() === "Made by UI drill key",
  "line=" + keyMakerLine);
await page.screenshot({ path: join(OUT, "editor-maker-key-1280.png") });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, "editor-maker-key-390.png") });
await page.setViewportSize({ width: 1280, height: 900 });
await page.click("#editor-close");
await page.waitForSelector("#editor-backdrop[hidden]", { state: "attached", timeout: 10000 });
await personCardEl.click();
await page.waitForSelector("#editor-backdrop:not([hidden])", { timeout: 10000 });
const personMakerLine = await page.locator('[data-role="card-maker"]').textContent().catch(() => null);
check("#126: the editor on a person-made card reads Made by the person's name",
  (personMakerLine || "").replace(/\s+/g, " ").trim() === "Made by " + PERSON_NAME,
  "line=" + personMakerLine);
await page.click("#editor-close");
await page.waitForSelector("#editor-backdrop[hidden]", { state: "attached", timeout: 10000 });

// --- Handing over (issue #119): the chip, the editor row, the filter -------------
// A key-made card holds its maker's step and wears the chip
// with no wait on it. The person-made drill card wears none.
// Handing the drill card to the key from the editor — with a
// comment standing in the box — flips its step, posts the
// comment in the same act and leaves the card waiting, which
// the editor line and the face chip both say. The filter row
// then narrows the board by holder.
const keyStateRes = await fetch(BASE + "/api/v1/state", {
  headers: { Authorization: "Bearer " + mintedKey },
});
const keyStateJson = await keyStateRes.json().catch(() => null);
const uiKeyEntry = keyStateJson && (keyStateJson.keys || []).find((k) => k.name === "UI drill key");
check("#119: the state names the key for the chooser and the filter",
  !!uiKeyEntry && !!uiKeyEntry.id, "keys: " + JSON.stringify((keyStateJson && keyStateJson.keys || []).map((k) => k.name)));
const uiKeyId = uiKeyEntry && uiKeyEntry.id;
async function keyStateCard(id) {
  const r = await fetch(BASE + "/api/v1/state", {
    headers: { Authorization: "Bearer " + mintedKey },
  });
  const j = await r.json().catch(() => null);
  return j && (j.cards || []).find((c) => c.id === id);
}
async function waitForCard(id, pred) {
  for (let i = 0; i < 30; i++) {
    const c = await keyStateCard(id);
    if (c && pred(c)) return c;
    await page.waitForTimeout(300);
  }
  return keyStateCard(id);
}

const keyChipText = await keyCardEl.locator("[data-step-chip]").textContent().catch(() => null);
check("#119: a key-held card wears the next-step chip naming the key",
  (keyChipText || "").trim() === "UI drill key", "chip=" + keyChipText);
const keyChipWaiting = await keyCardEl.locator("[data-step-waiting]").count();
check("#119: a card its maker holds is not waiting, so its chip carries no age",
  keyChipWaiting === 0, "waiting chips=" + keyChipWaiting);
const personChipCount = await personCardEl.locator("[data-step-chip]").count();
check("#119: the person's own card wears no next-step chip",
  personChipCount === 0, "chips=" + personChipCount);

// The hand-over from the editor, with the comment riding.
await personCardEl.click();
await page.waitForSelector("#editor-backdrop:not([hidden])", { timeout: 10000 });
const stepLineBefore = await page.locator("#step-line").textContent();
check("#119: the editor's line names the person's step before the hand-over",
  (stepLineBefore || "").trim() === "Next step: You", "line=" + stepLineBefore);
await page.fill("#comment-add-input", "Please pick this up.");
await page.selectOption("#field-step", uiKeyId);
const handedCard = await waitForCard(drillCard.id, (c) =>
  c.step && c.step.holder === "agent" && c.step.waiting === true &&
  (c.comments || []).some((cm) => cm.body === "Please pick this up."));
check("#119: the editor hand-over flips the step, posts the riding comment and waits",
  !!handedCard && handedCard.step.keyId === uiKeyId,
  "step " + JSON.stringify(handedCard && handedCard.step));
const stepLineAfter = await page.locator("#step-line").textContent();
check("#119: the editor's line says who holds it, when, and not picked up",
  /^Next step: UI drill key · handed over .+ · not picked up$/.test((stepLineAfter || "").trim()),
  "line=" + stepLineAfter);
await page.screenshot({ path: join(OUT, "handover-editor-1280.png") });
await page.click("#editor-close");
await page.waitForSelector("#editor-backdrop[hidden]", { state: "attached", timeout: 10000 });
await page.waitForSelector("[data-step-waiting=\"" + drillCard.id + "\"]", { timeout: 10000 });
const waitingChipText = await page.locator("[data-step-chip=\"" + drillCard.id + "\"]").textContent().catch(() => null);
check("#119: a waiting card's chip carries its age in short form",
  /UI drill key · \d+[mhdw]/.test(waitingChipText || ""), "chip=" + waitingChipText);
await page.screenshot({ path: join(OUT, "handover-board-1280.png") });

// The filter row narrows the board by holder.
async function boardCardCount() { return page.locator(".card").count(); }
const allCount = await boardCardCount();
const freshStateRes = await fetch(BASE + "/api/v1/state", {
  headers: { Authorization: "Bearer " + mintedKey },
});
const freshStateJson = await freshStateRes.json().catch(() => null);
const keyHeldCount = (freshStateJson.cards || []).filter((c) =>
  c.boardId === personalBoard.id && !c.archived && c.step &&
  c.step.holder === "agent" && c.step.keyId === uiKeyId).length;
await page.click("[data-step-filter=\"" + uiKeyId + "\"]");
await page.waitForFunction(
  (n) => document.querySelectorAll(".card").length === n,
  keyHeldCount,
  { timeout: 10000 }).catch(() => {});
const keyCount = await boardCardCount();
check("#119: the key's filter entry narrows the board to that key's cards",
  keyCount > 0 && keyCount < allCount &&
    await page.locator(".card", { hasText: KEY_TITLE }).count() === 1 &&
    await page.locator(".card", { hasText: RENAMED }).count() === 1,
  "all=" + allCount + " key=" + keyCount);
await page.screenshot({ path: join(OUT, "handover-filter-1280.png") });
await page.click("[data-step-filter=\"mine\"]");
await page.waitForFunction(
  () => !document.querySelector("[data-step-chip]"), null, { timeout: 10000 }).catch(() => {});
const mineChipCount = await page.locator("[data-step-chip]").count();
const mineShowsPerson = await page.locator(".card", { hasText: RENAMED }).count();
check("#119: Mine narrows the board to the person's cards — no agent chip stands",
  mineChipCount === 0 && mineShowsPerson === 0,
  "chips=" + mineChipCount + " handed card shown=" + mineShowsPerson);
await page.click("[data-step-filter=\"everyone\"]");
await page.waitForFunction(
  (n) => document.querySelectorAll(".card").length === n, allCount, { timeout: 10000 }).catch(() => {});
check("#119: Everyone restores the whole board",
  (await boardCardCount()) === allCount, "count=" + await boardCardCount());

// Put the drill card back the way the family found it: the key
// hands it to the person, and the person's own write — naming
// their step again — is the pickup that clears the wait.
await fetch(BASE + "/api/v1/cards/" + drillCard.id, {
  method: "PATCH",
  headers: { Authorization: "Bearer " + mintedKey, "Content-Type": "application/json" },
  body: JSON.stringify({ next_step: "owner" }),
});
await page.evaluate(async (id) => {
  await fetch("/api/v1/cards/" + encodeURIComponent(id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ next_step: "owner" }),
  });
}, drillCard.id);
const restoredCard = await waitForCard(drillCard.id, (c) =>
  c.step && c.step.holder === "owner" && c.step.waiting === false);
check("#119: the drill card stands restored as the person's step, picked up",
  !!restoredCard, "step " + JSON.stringify(restoredCard && restoredCard.step));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });

// --- Names resolve live on the board (issue #121) -------------------------------
// The maker tag and the step chip both read the key's name
// from its record as the board is read — the card carries
// the key's id, never a copy of the name (issue #121,
// Derick's rule: a name change in the UI is reflected
// everywhere). Since issue #123 the two never stand on the
// same card — the tag stands only when the maker does not
// hold the step — so the walk proves the rename on each
// where it stands: the key's card is handed to the person
// first, where its tag stands, and a fresh key-made card
// carries the chip. The walk renames the key back and the
// key takes its card's step back when it is done, so the
// sections after see the board they expect.
const keyCardApiId = keyCardJson.card.id;
await page.evaluate(async (id) => {
  await fetch("/api/v1/cards/" + encodeURIComponent(id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ next_step: "owner" }),
  });
}, keyCardApiId);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
await page.waitForSelector(".card .card-title:text-is(\"" + KEY_TITLE + "\")", { timeout: 10000 });
const ownerHeldKeyEl = page.locator(".card", { hasText: KEY_TITLE }).first();
const stoodTag = await ownerHeldKeyEl.locator("[data-creator-tag]").textContent().catch(() => null);
check("#123: handed to the person, the key-made card's maker tag stands",
  (stoodTag || "").trim() === "UI drill key", "tag=" + stoodTag);
await page.evaluate(async (id) => {
  await fetch("/api/v1/me/token/" + encodeURIComponent(id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "UI drill key renamed" }),
  });
}, uiKeyId);
const KEY_TITLE2 = "Key-made card, renamed " + Date.now();
const keyCard2Res = await fetch(BASE + "/api/v1/cards", {
  method: "POST",
  headers: { Authorization: "Bearer " + mintedKey, "Content-Type": "application/json" },
  body: JSON.stringify({ board_id: personalBoard.id, column_id: "inbox", title: KEY_TITLE2 }),
});
check("#121: a fresh card under the renamed key answers 201",
  keyCard2Res.status === 201, "status " + keyCard2Res.status);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
await page.waitForSelector(".card .card-title:text-is(\"" + KEY_TITLE + "\")", { timeout: 10000 });
const renamedKeyEl = page.locator(".card", { hasText: KEY_TITLE }).first();
const renamedTag = await renamedKeyEl.locator("[data-creator-tag]").textContent().catch(() => null);
const renamedKey2El = page.locator(".card", { hasText: KEY_TITLE2 }).first();
const renamedChip = await renamedKey2El.locator("[data-step-chip]").textContent().catch(() => null);
const renamedTag2Count = await renamedKey2El.locator("[data-creator-tag]").count();
check("#121: after the key's rename, the maker tag and the step chip both wear the new name",
  (renamedTag || "").trim() === "UI drill key renamed" &&
    (renamedChip || "").trim() === "UI drill key renamed" &&
    renamedTag2Count === 0,
  "tag=" + renamedTag + " chip=" + renamedChip + " fresh tags=" + renamedTag2Count);
// The editor's maker line follows the same rename (issue
// #126): it resolves the name as the card is read, so the
// line under the title wears the key's new name too.
await renamedKeyEl.click();
await page.waitForSelector("#editor-backdrop:not([hidden])", { timeout: 10000 });
const renamedMakerLine = await page.locator('[data-role="card-maker"]').textContent().catch(() => null);
check("#126: after the key's rename, the editor's maker line wears the new name",
  (renamedMakerLine || "").replace(/\s+/g, " ").trim() === "Made by UI drill key renamed",
  "line=" + renamedMakerLine);
await page.click("#editor-close");
await page.waitForSelector("#editor-backdrop[hidden]", { state: "attached", timeout: 10000 });
await page.screenshot({ path: join(OUT, "board-names-1280.png") });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, "board-names-390.png") });
await page.setViewportSize({ width: 1280, height: 900 });
await page.evaluate(async (id) => {
  await fetch("/api/v1/me/token/" + encodeURIComponent(id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "UI drill key" }),
  });
}, uiKeyId);
// The key takes its card's step back — its own write is the
// pickup — so the card stands maker-held again.
await fetch(BASE + "/api/v1/cards/" + keyCardApiId, {
  method: "PATCH",
  headers: { Authorization: "Bearer " + mintedKey, "Content-Type": "application/json" },
  body: JSON.stringify({ next_step: uiKeyId }),
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });

// --- One pill when the maker holds the step (issue #123) -------------------------
// Derick's ruling: the maker tag stands only when the step
// holder is not the key that made the card, compared by key
// id, never by name. The creators walk proved the plain
// coincide case and the #121 walk the person's case; this
// walk proves the remaining shapes on the key's card: a
// second key holding the step (two pills, different names),
// no one holding it (the tag alone) and the coincide case
// in its waiting form (the chip alone, carrying its age).
// The second key is revoked again at the end.
async function patchStepVia(key, value) {
  const r = await fetch(BASE + "/api/v1/cards/" + keyCardApiId, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ next_step: value }),
  });
  return r.status;
}
async function reloadToKeyCard() {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  await page.waitForSelector(".card .card-title:text-is(\"" + KEY_TITLE + "\")", { timeout: 10000 });
  return page.locator(".card", { hasText: KEY_TITLE }).first();
}
const secondKeyJson = await page.evaluate(async () => {
  const r = await fetch("/api/v1/me/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "UI second key" }),
  });
  return r.json().catch(() => null);
});
const secondKey = secondKeyJson && secondKeyJson.key;
const secondKeyId = secondKeyJson && secondKeyJson.id;
check("#123: a second key stands for the other-key case",
  !!secondKey && !!secondKeyId, "minted " + !!secondKey);

// Another key holds the step: both pills, different names.
check("#123: handing the card to the second key answers 200",
  (await patchStepVia(mintedKey, secondKeyId)) === 200, "");
let pillEl = await reloadToKeyCard();
const twoTag = await pillEl.locator("[data-creator-tag]").textContent().catch(() => null);
const twoChip = await pillEl.locator("[data-step-chip]").textContent().catch(() => null);
check("#123: another key holding the step — the maker tag and the step chip stand side by side, naming different keys",
  (twoTag || "").trim() === "UI drill key" &&
    /^UI second key · \d+[mhdw]$/.test((twoChip || "").trim()),
  "tag=" + twoTag + " chip=" + twoChip);
await page.screenshot({ path: join(OUT, "pills-two-1280.png") });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, "pills-two-390.png") });
await page.setViewportSize({ width: 1280, height: 900 });

// No one holds the step: the tag stands alone.
check("#123: clearing the step to no one answers 200",
  (await patchStepVia(mintedKey, "none")) === 200, "");
pillEl = await reloadToKeyCard();
const noneTagCount = await pillEl.locator("[data-creator-tag]").count();
const noneChipCount = await pillEl.locator("[data-step-chip]").count();
check("#123: the step no one's — the maker tag stands and no chip does",
  noneTagCount === 1 && noneChipCount === 0,
  "tags=" + noneTagCount + " chips=" + noneChipCount);

// The coincide case, waiting: the second key hands the card
// back to its maker, so the card waits on the key that made
// it — the chip alone, carrying its age.
check("#123: the second key handing the card back to its maker answers 200",
  (await patchStepVia(secondKey, uiKeyId)) === 200, "");
pillEl = await reloadToKeyCard();
const waitTagCount = await pillEl.locator("[data-creator-tag]").count();
const waitChip = await pillEl.locator("[data-step-chip]").textContent().catch(() => null);
const waitMark = await pillEl.locator("[data-step-waiting]").count();
check("#123: the maker holds the step again, waiting — one pill, the chip with its age, and no maker tag",
  waitTagCount === 0 && waitMark === 1 &&
    /^UI drill key · \d+[mhdw]$/.test((waitChip || "").trim()),
  "tags=" + waitTagCount + " waiting=" + waitMark + " chip=" + waitChip);
await page.screenshot({ path: join(OUT, "pills-one-1280.png") });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, "pills-one-390.png") });
await page.setViewportSize({ width: 1280, height: 900 });

// Put the card back: the maker takes its own step — its own
// write is the pickup — and the second key is revoked.
check("#123: the maker taking its step back answers 200",
  (await patchStepVia(mintedKey, uiKeyId)) === 200, "");
const pillRestored = await waitForCard(keyCardApiId, (c) =>
  c.step && c.step.holder === "agent" && c.step.keyId === uiKeyId && c.step.waiting === false);
check("#123: the card stands restored — maker-held, picked up",
  !!pillRestored, "step " + JSON.stringify(pillRestored && pillRestored.step));
await page.evaluate(async (id) => {
  await fetch("/api/v1/me/token/" + encodeURIComponent(id), { method: "DELETE" });
}, secondKeyId);
await reloadToKeyCard();

// --- Comment authors in the editor (issue #120) --------------------------------
// A throwaway card carries one comment from the key and one
// from the person: the editor names both authors, each name
// beside its comment's time, in the one style comments wear.
// The card is deleted again at the end of the walk.
async function makeCardViaApiEarly(title) {
  const r = await fetch(BASE + "/api/v1/cards", {
    method: "POST",
    headers: { Authorization: "Bearer " + mintedKey, "Content-Type": "application/json" },
    body: JSON.stringify({ board_id: personalBoard.id, column_id: "inbox", title }),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, card: j && j.card };
}
const AUTHORS_TITLE = "Comment authors card " + Date.now();
const authorsMade = await makeCardViaApiEarly(AUTHORS_TITLE);
check("#120: the card for the authors walk is made",
  authorsMade.status === 201 && !!authorsMade.card, "status " + authorsMade.status);
const agentCommentRes = await fetch(BASE + "/api/v1/cards/" + authorsMade.card.id + "/comments", {
  method: "POST",
  headers: { Authorization: "Bearer " + mintedKey, "Content-Type": "application/json" },
  body: JSON.stringify({ body: "Agent note on authors" }),
});
check("#120: the key's comment stands on the authors card",
  agentCommentRes.status === 201, "status " + agentCommentRes.status);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
await page.locator(".card", { hasText: AUTHORS_TITLE }).first().click();
await page.waitForSelector("#editor-backdrop:not([hidden])", { timeout: 10000 });
await page.fill("#comment-add-input", "Person note on authors");
await page.click("#comment-add-btn");
await page.waitForFunction(
  () => document.querySelectorAll("[data-comment-row]").length === 2,
  null, { timeout: 10000 }).catch(() => {});
const authorRows = await page.locator("[data-comment-row]").evaluateAll((rows) =>
  rows.map((row) => {
    const tag = row.querySelector('[data-role="comment-author"]');
    const body = row.querySelector(".comment-body");
    return { body: body ? body.textContent : null, author: tag ? tag.textContent.trim() : null };
  }));
check("#120: the editor names both comments' authors — the key's name and the person's",
  authorRows.length === 2 &&
    authorRows.some((r) => r.body === "Agent note on authors" && r.author === "UI drill key") &&
    authorRows.some((r) => r.body === "Person note on authors" && r.author === PERSON_NAME),
  JSON.stringify(authorRows));
await page.screenshot({ path: join(OUT, "editor-comment-authors-1280.png") });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, "editor-comment-authors-390.png") });
await page.setViewportSize({ width: 1280, height: 900 });
await page.click("#editor-close");
await page.waitForSelector("#editor-backdrop[hidden]", { state: "attached", timeout: 10000 });
await fetch(BASE + "/api/v1/cards/" + authorsMade.card.id, {
  method: "DELETE",
  headers: { Authorization: "Bearer " + mintedKey },
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });

// --- Card delete: a fresh dialog over the untouched editor (issue #97) ----------
// Delete never reshapes the edit view. Pressing it opens a
// separate dialog over the editor as it stands; the dialog
// names the card, says whether it is on the board or archived
// and that the deletion cannot be undone; standing the dialog
// down returns to the editor with its edits in place, and
// confirming deletes. The Archived list's Delete opens the
// same dialog over the board.
async function makeCardViaApi(title) {
  const r = await fetch(BASE + "/api/v1/cards", {
    method: "POST",
    headers: { Authorization: "Bearer " + mintedKey, "Content-Type": "application/json" },
    body: JSON.stringify({ board_id: personalBoard.id, column_id: "inbox", title }),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, card: j && j.card };
}
async function stateHasCard(id) {
  const r = await fetch(BASE + "/api/v1/state", {
    headers: { Authorization: "Bearer " + mintedKey },
  });
  const j = await r.json().catch(() => null);
  return !!j && (j.cards || []).some((c) => c.id === id);
}

const DEL_TITLE = "Delete dialog card " + Date.now();
const delMade = await makeCardViaApi(DEL_TITLE);
check("#97: the card for the delete walk is made",
  delMade.status === 201 && !!delMade.card, "status " + delMade.status);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
await page.locator(".card", { hasText: DEL_TITLE }).first().click();
await page.waitForSelector("#editor-backdrop:not([hidden])", { timeout: 10000 });
// An edit typed but not closed over: the question must leave it be.
await page.fill("#field-notes", "Notes that must survive the question");
await page.click("#editor-delete");
await page.waitForSelector("#card-delete-backdrop:not([hidden])", { timeout: 10000 });
const inlineConfirmCount = await page.locator("#editor-delete-confirm").count();
const editorStillOpen = await page.locator("#editor-backdrop:not([hidden])").count();
const deleteBtnStillShown = await page.isVisible("#editor-delete");
const titleUnderDialog = await page.inputValue("#field-title");
const notesUnderDialog = await page.inputValue("#field-notes");
const dialogText = await page.locator("#card-delete-text").textContent();
check("#97: delete opens a separate dialog — no confirm lives inside the editor",
  inlineConfirmCount === 0, "inline confirms in the DOM: " + inlineConfirmCount);
check("#97: the editor stands untouched underneath, its Delete button still showing",
  editorStillOpen === 1 && deleteBtnStillShown,
  "editor open=" + editorStillOpen + " delete shown=" + deleteBtnStillShown);
check("#97: the edits stand in the editor while the dialog asks",
  titleUnderDialog === DEL_TITLE && notesUnderDialog === "Notes that must survive the question",
  "title=" + titleUnderDialog + " notes=" + notesUnderDialog);
check("#97: the dialog names the card, its place on the board and the permanence",
  (dialogText || "").includes(DEL_TITLE) && /on the board/.test(dialogText || "") &&
    /cannot be brought back/.test(dialogText || ""),
  (dialogText || "").slice(0, 110));
await page.screenshot({ path: join(OUT, "card-delete-1280.png") });
await page.click("#card-delete-cancel");
await page.waitForSelector("#card-delete-backdrop[hidden]", { state: "attached", timeout: 10000 });
const editorAfterCancel = await page.locator("#editor-backdrop:not([hidden])").count();
const notesAfterCancel = await page.inputValue("#field-notes");
check("#97: standing the dialog down returns to the editor, edits intact",
  editorAfterCancel === 1 && notesAfterCancel === "Notes that must survive the question",
  "editor open=" + editorAfterCancel + " notes=" + notesAfterCancel);
await page.click("#editor-delete");
await page.waitForSelector("#card-delete-backdrop:not([hidden])", { timeout: 10000 });
await page.click("#card-delete-confirm");
await page.waitForSelector("#editor-backdrop[hidden]", { state: "attached", timeout: 10000 });
await page.waitForTimeout(800); // the save queue drains
const faceGone = await page.locator(".card .card-title", { hasText: DEL_TITLE }).count();
const stateGone = !(await stateHasCard(delMade.card.id));
check("#97: confirming in the dialog deletes the card, on the board and in the state",
  faceGone === 0 && stateGone, "faces=" + faceGone + " gone from state=" + stateGone);

// The Archived list's Delete opens the same dialog.
const ARCH_TITLE = "Delete dialog archived " + Date.now();
const archMade = await makeCardViaApi(ARCH_TITLE);
const archPatch = await fetch(BASE + "/api/v1/cards/" + archMade.card.id, {
  method: "PATCH",
  headers: { Authorization: "Bearer " + mintedKey, "Content-Type": "application/json" },
  body: JSON.stringify({ archived: true }),
});
check("#97: the card for the archived walk stands archived",
  archPatch.status === 200, "status " + archPatch.status);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
await page.waitForSelector("#archived-section:not([hidden])", { timeout: 10000 });
const archRow = page.locator("[data-archived-card=\"" + archMade.card.id + "\"]");
await archRow.locator('[data-role="archived-delete"]').click();
await page.waitForSelector("#card-delete-backdrop:not([hidden])", { timeout: 10000 });
const archDialogText = await page.locator("#card-delete-text").textContent();
check("#97: the Archived list's Delete opens the same dialog, naming the card as archived",
  (archDialogText || "").includes(ARCH_TITLE) && /archived/.test(archDialogText || "") &&
    /cannot be brought back/.test(archDialogText || ""),
  (archDialogText || "").slice(0, 110));
await page.click("#card-delete-cancel");
await page.waitForSelector("#card-delete-backdrop[hidden]", { state: "attached", timeout: 10000 });
const rowStands = await page.locator("[data-archived-card=\"" + archMade.card.id + "\"]").count();
check("#97: standing the dialog down leaves the archived row standing",
  rowStands === 1, "rows=" + rowStands);
await archRow.locator('[data-role="archived-delete"]').click();
await page.waitForSelector("#card-delete-backdrop:not([hidden])", { timeout: 10000 });
await page.click("#card-delete-confirm");
await page.waitForTimeout(800); // the save queue drains
const rowGone = await page.locator("[data-archived-card=\"" + archMade.card.id + "\"]").count();
const archStateGone = !(await stateHasCard(archMade.card.id));
check("#97: confirming deletes the archived card, row and state alike",
  rowGone === 0 && archStateGone, "rows=" + rowGone + " gone from state=" + archStateGone);

// One card more, for the phone walk below: it opens the same
// dialog over the editor at phone width, for the screenshot.
const PHONE_TITLE = "Delete dialog phone " + Date.now();
const phoneMade = await makeCardViaApi(PHONE_TITLE);
check("#97: the card for the phone screenshot is made",
  phoneMade.status === 201 && !!phoneMade.card, "status " + phoneMade.status);

// --- Label colour modes (issues #94, #95): the board paints its cards -----------
// Warm is made before Cool on purpose: the board's label order,
// not the order a card lists its labels in, picks the painter —
// the multi-label card lists Cool first and must still paint
// Warm. The measurements compare the card against its own first
// chip, so they hold in either theme: the chip's background is
// the faded paint's colour, the chip's border is the trims'.
async function apiCall(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: "Bearer " + mintedKey, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const warmRes = await apiCall("POST", "/api/v1/labels", { board_id: personalBoard.id, name: "Paint warm", colour: "amber" });
const coolRes = await apiCall("POST", "/api/v1/labels", { board_id: personalBoard.id, name: "Paint cool", colour: "blue" });
check("paint: the two paint labels are made",
  warmRes.status === 201 && coolRes.status === 201, warmRes.status + "/" + coolRes.status);
const warmId = warmRes.json.label.id;
const coolId = coolRes.json.label.id;
const MULTI = "Paint multi " + Date.now();
const NONE = "Paint none " + Date.now();
const multiRes = await apiCall("POST", "/api/v1/cards", {
  board_id: personalBoard.id, column_id: "inbox", title: MULTI, labels: [coolId, warmId],
});
const noneRes = await apiCall("POST", "/api/v1/cards", {
  board_id: personalBoard.id, column_id: "inbox", title: NONE,
});
check("paint: the painted and plain cards are made",
  multiRes.status === 201 && noneRes.status === 201, multiRes.status + "/" + noneRes.status);
async function setMode(mode) {
  const r = await apiCall("PATCH", "/api/v1/boards/" + personalBoard.id, { label_colour_mode: mode });
  if (r.status !== 200) throw new Error("setting mode " + mode + " answered " + r.status);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  await page.waitForSelector(".card .card-title:text-is(\"" + MULTI + "\")", { timeout: 10000 });
}
async function paintOf(title) {
  return page.locator(".card", { hasText: title }).first().evaluate((node) => {
    const cs = getComputedStyle(node);
    const chip = node.querySelector(".chip");
    const chipCs = chip ? getComputedStyle(chip) : null;
    return {
      paint: node.getAttribute("data-label-paint"),
      background: cs.backgroundColor,
      borderTopColor: cs.borderTopColor,
      borderTopWidth: cs.borderTopWidth,
      borderLeftWidth: cs.borderLeftWidth,
      chipBackground: chipCs ? chipCs.backgroundColor : null,
      chipBorder: chipCs ? chipCs.borderColor : null,
    };
  });
}
await setMode("chip");
let paint = await paintOf(MULTI);
check("paint: at chip the card face carries no paint, only its chips",
  paint.paint === null && paint.chipBackground !== null, "paint=" + paint.paint);

// The first switch goes through Settings → Boards, the person's
// own control: the board's row shows its mode and sets it live.
await page.click("#settings-open");
await page.click('[data-settings-page="settings-boards"]');
const modeSelect = page.locator('[data-board-row="' + personalBoard.id + '"] [data-role="board-label-mode"]');
await modeSelect.waitFor({ timeout: 10000 });
const modeAtRest = await modeSelect.inputValue();
check("paint: the board's row in Settings shows its mode standing at Just the label",
  modeAtRest === "chip", "value " + modeAtRest);
await page.screenshot({ path: join(OUT, "settings-boards-mode-1280.png") });
await modeSelect.selectOption("background");
await page.waitForTimeout(900);
await page.click("#settings-close").catch(() => {});
paint = await paintOf(MULTI);
check("paint: a Settings switch paints the board behind it — the faded background is the first label's colour",
  paint.paint === "background" && paint.background === paint.chipBackground && paint.chipBackground !== null,
  "paint=" + paint.paint + " card " + paint.background + " chip " + paint.chipBackground);
const nonePaint = await paintOf(NONE);
check("paint: a card with no labels is never painted", nonePaint.paint === null, "paint=" + nonePaint.paint);
await page.screenshot({ path: join(OUT, "paint-background-1280.png") });

// The editor never paints, in any mode.
await page.locator(".card", { hasText: MULTI }).first().click();
await page.waitForSelector("#editor-backdrop:not([hidden])", { timeout: 10000 });
const editorPaint = await page.evaluate(() => {
  const panel = document.querySelector("#editor-backdrop .editor");
  return {
    paintedInside: document.querySelectorAll("#editor-backdrop [data-label-paint]").length,
    background: panel ? getComputedStyle(panel).backgroundColor : null,
  };
});
paint = await paintOf(MULTI).catch(() => null);
check("paint: the card editor stands unpainted while its board paints",
  editorPaint.paintedInside === 0, "painted elements inside the editor: " + editorPaint.paintedInside);
await page.screenshot({ path: join(OUT, "paint-editor-1280.png") });
await page.click("#editor-close");
await page.waitForSelector("#editor-backdrop[hidden]", { state: "attached", timeout: 10000 });

await setMode("trim");
paint = await paintOf(MULTI);
check("paint: thick trim rings the card in the first label's border colour",
  paint.paint === "trim" && paint.borderTopWidth === "4px" && paint.borderLeftWidth === "4px" &&
    paint.borderTopColor === paint.chipBorder && paint.chipBorder !== null,
  "paint=" + paint.paint + " top " + paint.borderTopWidth + " left " + paint.borderLeftWidth +
    " colour " + paint.borderTopColor + " chip " + paint.chipBorder);
await page.screenshot({ path: join(OUT, "paint-trim-1280.png") });

await setMode("top");
paint = await paintOf(MULTI);
check("paint: the top trim is a thick band across the top only",
  paint.paint === "top" && paint.borderTopWidth === "12px" && paint.borderLeftWidth === "1px" &&
    paint.borderTopColor === paint.chipBorder && paint.chipBorder !== null,
  "paint=" + paint.paint + " top " + paint.borderTopWidth + " left " + paint.borderLeftWidth +
    " colour " + paint.borderTopColor + " chip " + paint.chipBorder);
await page.screenshot({ path: join(OUT, "paint-top-1280.png") });

await setMode("chip");
paint = await paintOf(MULTI);
check("paint: back at chip the paint is gone", paint.paint === null, "paint=" + paint.paint);

// --- Settings board pickers (issue #96): Labels and Projects ----------------------
// Both pages pick their board from a dropdown, the Columns
// pattern: the page lists only the picked board's labels or
// projects, an add lands on the picked board, and the page
// opens on the board the person is looking at in the main
// view — not on the last pick.
const professionalBoard = apiState.boards.find((b) => b.name === "Professional");
async function settingsRowNames(wrapSel, inputSel) {
  return page.locator(wrapSel + " " + inputSel).evaluateAll((els) => els.map((e) => e.value));
}
await page.click("#settings-open");
await page.click('[data-settings-page="settings-labels-section"]');
await page.waitForSelector("#labels-board-picker", { timeout: 10000 });
const labelsPickerAtOpen = await page.inputValue("#labels-board-picker");
check("settings pickers: the Labels page opens on the board on screen",
  labelsPickerAtOpen === personalBoard.id, "picker " + labelsPickerAtOpen);
const B_LABEL = "Drill B label " + Date.now();
await page.selectOption("#labels-board-picker", professionalBoard.id);
await page.waitForTimeout(300);
await page.fill("#settings-labels [data-role='add-name']", B_LABEL);
await page.click("#settings-labels [data-role='add-label']");
await page.waitForFunction((name) =>
  Array.from(document.querySelectorAll("#settings-labels [data-label-row] [data-role='name']"))
    .some((e) => e.value === name), B_LABEL, { timeout: 10000 });
check("settings pickers: a label added on the picked board stands in its list", true, B_LABEL);
await page.selectOption("#labels-board-picker", personalBoard.id);
await page.waitForTimeout(300);
const labelsOnA = await settingsRowNames("#settings-labels", "[data-label-row] [data-role='name']");
check("settings pickers: the Labels page lists only the picked board's labels",
  !labelsOnA.includes(B_LABEL), labelsOnA.join(" | "));
await page.selectOption("#labels-board-picker", professionalBoard.id);
await page.waitForTimeout(300);
const labelsOnB = await settingsRowNames("#settings-labels", "[data-label-row] [data-role='name']");
check("settings pickers: switching back shows the label on its own board",
  labelsOnB.includes(B_LABEL), labelsOnB.join(" | "));
await page.screenshot({ path: join(OUT, "settings-labels-1280.png") });
// The page opens on the board on screen, not on the last pick:
// the main view still stands on Personal, so leaving the
// picker on Professional and reopening the page must land
// back on Personal.
await page.click("#settings-close").catch(() => {});
await page.click("#settings-open");
await page.click('[data-settings-page="settings-labels-section"]');
await page.waitForSelector("#labels-board-picker", { timeout: 10000 });
const labelsPickerReopened = await page.inputValue("#labels-board-picker");
check("settings pickers: reopening Labels starts from the board on screen, not the last pick",
  labelsPickerReopened === personalBoard.id, "picker " + labelsPickerReopened);

await page.click("#settings-back");
await page.click('[data-settings-page="settings-projects-section"]');
await page.waitForSelector("#projects-board-picker", { timeout: 10000 });
const projectsPickerAtOpen = await page.inputValue("#projects-board-picker");
check("settings pickers: the Projects page opens on the board on screen",
  projectsPickerAtOpen === personalBoard.id, "picker " + projectsPickerAtOpen);
const B_PROJECT = "Drill B project " + Date.now();
await page.selectOption("#projects-board-picker", professionalBoard.id);
await page.waitForTimeout(300);
await page.fill("#settings-projects [data-role='add-name']", B_PROJECT);
await page.click("#settings-projects [data-role='add-project']");
await page.waitForFunction((name) =>
  Array.from(document.querySelectorAll("#settings-projects [data-project-row] [data-role='project-name']"))
    .some((e) => e.value === name), B_PROJECT, { timeout: 10000 });
check("settings pickers: a project added on the picked board stands in its list", true, B_PROJECT);
await page.selectOption("#projects-board-picker", personalBoard.id);
await page.waitForTimeout(300);
const projectsOnA = await settingsRowNames("#settings-projects", "[data-project-row] [data-role='project-name']");
check("settings pickers: the Projects page lists only the picked board's projects",
  !projectsOnA.includes(B_PROJECT), projectsOnA.join(" | "));
await page.screenshot({ path: join(OUT, "settings-projects-1280.png") });
await page.click("#settings-close").catch(() => {});

// --- Dialog sweep (issue #99): project, board and label deletes ask in dialogs ----
// Every destructive act asks in a dialog — never an expanding
// form, never a bare click. Project delete is the shared one:
// the same dialog from Settings → Projects and from the
// press-and-hold editor, over the untouched row or editor.
// Board delete and label delete gain dialogs of their own,
// naming what goes with them. Standing any of them down
// preserves everything; confirming acts exactly as the old
// shapes acted.
async function apiStateNow() {
  const r = await fetch(BASE + "/api/v1/state", {
    headers: { Authorization: "Bearer " + mintedKey },
  });
  return r.json().catch(() => null);
}

// Project delete from Settings → Projects.
const PROJ_NAME = "Dialog project " + Date.now();
const projRes = await apiCall("POST", "/api/v1/projects", { board_id: personalBoard.id, name: PROJ_NAME });
const projId = projRes.json && projRes.json.project && projRes.json.project.id;
const projCardRes = await apiCall("POST", "/api/v1/cards", {
  board_id: personalBoard.id, column_id: "inbox", title: "Dialog project card " + Date.now(), project_id: projId,
});
check("#99: the project and its card are made",
  projRes.status === 201 && !!projId && projCardRes.status === 201,
  projRes.status + "/" + projCardRes.status);
const projCardId = projCardRes.json.card.id;
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
await page.click("#settings-open");
await page.click('[data-settings-page="settings-projects-section"]');
await page.waitForSelector("#projects-board-picker", { timeout: 10000 });
const projRow = page.locator('[data-project-row="' + projId + '"]');
await projRow.locator('[data-role="project-delete"]').click();
await page.waitForSelector("#project-delete-backdrop:not([hidden])", { timeout: 10000 });
const inRowConfirms = await page.locator('[data-role="project-confirm"], .project-confirm').count();
const projRowDeleteShown = await projRow.locator('[data-role="project-delete"]').isVisible();
const projDialogText = await page.locator("#project-delete-text").textContent();
check("#99: project delete opens the dialog — no confirm remains inside the row",
  inRowConfirms === 0 && projRowDeleteShown,
  "in-row confirms=" + inRowConfirms + " row delete still shown=" + projRowDeleteShown);
check("#99: the project dialog names the project and the cards that carry on projectless",
  (projDialogText || "").includes(PROJ_NAME) &&
    (projDialogText || "").includes("On 1 card — it will carry on with no project."),
  (projDialogText || "").slice(0, 140));
await page.screenshot({ path: join(OUT, "project-delete-1280.png") });
await page.click("#project-delete-cancel");
await page.waitForSelector("#project-delete-backdrop[hidden]", { state: "attached", timeout: 10000 });
let stateNow = await apiStateNow();
check("#99: standing the project dialog down preserves the project and its card's project",
  !!stateNow && stateNow.projects.some((p) => p.id === projId) &&
    (stateNow.cards.find((c) => c.id === projCardId) || {}).projectId === projId,
  "");
await projRow.locator('[data-role="project-delete"]').click();
await page.waitForSelector("#project-delete-backdrop:not([hidden])", { timeout: 10000 });
await page.click("#project-delete-confirm");
await page.waitForFunction(
  (id) => !document.querySelector('[data-project-row="' + id + '"]'),
  projId, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(500);
stateNow = await apiStateNow();
check("#99: confirming in the dialog deletes the project — its card carries on with no project",
  !!stateNow && !stateNow.projects.some((p) => p.id === projId) &&
    (stateNow.cards.find((c) => c.id === projCardId) || {}).projectId === null,
  "");
await page.click("#settings-close").catch(() => {});

// Project delete from the press-and-hold editor: the same
// dialog, over the editor as it stands.
const PRESS_PROJ_NAME = "Dialog press project " + Date.now();
const pressProjRes = await apiCall("POST", "/api/v1/projects", { board_id: personalBoard.id, name: PRESS_PROJ_NAME });
const pressProjId = pressProjRes.json && pressProjRes.json.project && pressProjRes.json.project.id;
check("#99: the press editor's project is made",
  pressProjRes.status === 201 && !!pressProjId, "status " + pressProjRes.status);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
await page.dblclick('.filter-btn[data-project="' + pressProjId + '"]');
await page.waitForSelector('[data-role="press-editor"]', { timeout: 10000 });
await page.click('[data-role="press-editor-delete"]');
await page.waitForSelector("#project-delete-backdrop:not([hidden])", { timeout: 10000 });
const pressEditorStands = await page.locator('[data-role="press-editor"]').count();
const inEditorConfirms = await page.locator('[data-role="press-editor-confirm"]').count();
const pressDialogText = await page.locator("#project-delete-text").textContent();
check("#99: the press editor's Delete opens the same dialog over the untouched editor",
  pressEditorStands === 1 && inEditorConfirms === 0,
  "editor stands=" + pressEditorStands + " in-editor confirms=" + inEditorConfirms);
check("#99: the dialog over the editor names the project and its card count",
  (pressDialogText || "").includes(PRESS_PROJ_NAME) &&
    (pressDialogText || "").includes("No cards carry it."),
  (pressDialogText || "").slice(0, 140));
await page.screenshot({ path: join(OUT, "project-delete-press-1280.png") });
await page.click("#project-delete-cancel");
await page.waitForSelector("#project-delete-backdrop[hidden]", { state: "attached", timeout: 10000 });
const pressEditorAfterCancel = await page.locator('[data-role="press-editor"]').count();
stateNow = await apiStateNow();
check("#99: standing the dialog down returns to the untouched editor, project alive",
  pressEditorAfterCancel === 1 && !!stateNow && stateNow.projects.some((p) => p.id === pressProjId),
  "editor stands=" + pressEditorAfterCancel);
await page.click('[data-role="press-editor-delete"]');
await page.waitForSelector("#project-delete-backdrop:not([hidden])", { timeout: 10000 });
await page.click("#project-delete-confirm");
await page.waitForSelector('[data-role="press-editor"]', { state: "detached", timeout: 10000 }).catch(() => {});
await page.waitForTimeout(500);
stateNow = await apiStateNow();
check("#99: confirming over the editor deletes the project and closes the editor",
  (await page.locator('[data-role="press-editor"]').count()) === 0 &&
    !!stateNow && !stateNow.projects.some((p) => p.id === pressProjId),
  "");

// Board delete: a dialog naming the board, its cards (the
// count — active and archived alike, issue #134), its labels
// and its projects. No row note blocks the delete any more;
// the one guard left is the last board.
const BOARD_NAME = "Dialog board " + Date.now();
const boardRes = await apiCall("POST", "/api/v1/boards", { name: BOARD_NAME });
const dialogBoardId = boardRes.json && boardRes.json.board && boardRes.json.board.id;
const bLabelRes = await apiCall("POST", "/api/v1/labels", { board_id: dialogBoardId, name: "Dialog board label", colour: "red" });
const bProjRes = await apiCall("POST", "/api/v1/projects", { board_id: dialogBoardId, name: "Dialog board project" });
const bCardRes = await apiCall("POST", "/api/v1/cards", {
  board_id: dialogBoardId, column_id: "inbox", title: "Dialog board archived " + Date.now(),
});
const bArchRes = await apiCall("PATCH", "/api/v1/cards/" + bCardRes.json.card.id, { archived: true });
const bLive1Res = await apiCall("POST", "/api/v1/cards", {
  board_id: dialogBoardId, column_id: "inbox", title: "Dialog board live one " + Date.now(),
});
const bLive2Res = await apiCall("POST", "/api/v1/cards", {
  board_id: dialogBoardId, column_id: "inbox", title: "Dialog board live two " + Date.now(),
});
check("#99: the deletable board stands with two live cards, an archived card, a label and a project",
  boardRes.status === 201 && !!dialogBoardId && bLabelRes.status === 201 &&
    bProjRes.status === 201 && bArchRes.status === 200 &&
    bLive1Res.status === 201 && bLive2Res.status === 201,
  boardRes.status + "/" + bLabelRes.status + "/" + bProjRes.status + "/" + bArchRes.status +
    "/" + bLive1Res.status + "/" + bLive2Res.status);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
await page.click("#settings-open");
await page.click('[data-settings-page="settings-boards"]');
const boardRow = page.locator('[data-board-row="' + dialogBoardId + '"]');
await boardRow.waitFor({ timeout: 10000 });
const boardRowNote = await boardRow.locator('[data-role="board-delete-note"]').textContent().catch(() => "");
const boardDeleteEnabled = !(await boardRow.locator('[data-role="board-delete"]').isDisabled().catch(() => true));
check("#134: the board row carries no blocking note and its delete stands enabled",
  (boardRowNote || "").trim() === "" && boardDeleteEnabled, (boardRowNote || "").slice(0, 90));
await boardRow.locator('[data-role="board-delete"]').click();
await page.waitForSelector("#board-delete-backdrop:not([hidden])", { timeout: 10000 });
const boardDialogText = await page.locator("#board-delete-text").textContent();
check("#134: board delete asks first — the dialog names the board and its whole card count",
  (boardDialogText || "").includes(BOARD_NAME) && /Its 3 cards go with it/.test(boardDialogText || "") &&
    /label/.test(boardDialogText || "") && /project/.test(boardDialogText || ""),
  (boardDialogText || "").slice(0, 150));
await page.screenshot({ path: join(OUT, "board-delete-1280.png") });
await page.click("#board-delete-cancel");
await page.waitForSelector("#board-delete-backdrop[hidden]", { state: "attached", timeout: 10000 });
stateNow = await apiStateNow();
check("#99: standing the board dialog down preserves the board whole",
  !!stateNow && stateNow.boards.some((b) => b.id === dialogBoardId) &&
    stateNow.cards.some((c) => c.id === bCardRes.json.card.id),
  "");
await boardRow.locator('[data-role="board-delete"]').click();
await page.waitForSelector("#board-delete-backdrop:not([hidden])", { timeout: 10000 });
await page.click("#board-delete-confirm");
await page.waitForFunction(
  (id) => !document.querySelector('[data-board-row="' + id + '"]'),
  dialogBoardId, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(500);
stateNow = await apiStateNow();
check("#134: confirming deletes the board with all its cards, labels and projects",
  !!stateNow && !stateNow.boards.some((b) => b.id === dialogBoardId) &&
    !stateNow.cards.some((c) => c.boardId === dialogBoardId) &&
    !stateNow.labels.some((l) => l.boardId === dialogBoardId) &&
    !stateNow.projects.some((p) => p.boardId === dialogBoardId),
  "");

// Label delete: a dialog naming the label and how many cards
// on its board wear it — a plain wording when none do.
const LABEL_NAME = "Dialog label " + Date.now();
const labelRes = await apiCall("POST", "/api/v1/labels", { board_id: personalBoard.id, name: LABEL_NAME, colour: "red" });
const dialogLabelId = labelRes.json && labelRes.json.label && labelRes.json.label.id;
const wear1 = await apiCall("POST", "/api/v1/cards", {
  board_id: personalBoard.id, column_id: "inbox", title: "Dialog label wearer one " + Date.now(), labels: [dialogLabelId],
});
const wear2 = await apiCall("POST", "/api/v1/cards", {
  board_id: personalBoard.id, column_id: "inbox", title: "Dialog label wearer two " + Date.now(), labels: [dialogLabelId],
});
check("#99: the label and its two wearers are made",
  labelRes.status === 201 && !!dialogLabelId && wear1.status === 201 && wear2.status === 201,
  labelRes.status + "/" + wear1.status + "/" + wear2.status);
await page.click("#settings-back");
await page.click('[data-settings-page="settings-labels-section"]');
await page.waitForSelector("#labels-board-picker", { timeout: 10000 });
const labelRow = page.locator('[data-label-row="' + dialogLabelId + '"]');
await labelRow.locator('[data-role="delete"]').click();
await page.waitForSelector("#label-delete-backdrop:not([hidden])", { timeout: 10000 });
const labelDialogText = await page.locator("#label-delete-text").textContent();
check("#99: label delete asks first — the dialog names the label and how many cards wear it",
  (labelDialogText || "").includes(LABEL_NAME) && /2 cards/.test(labelDialogText || ""),
  (labelDialogText || "").slice(0, 140));
await page.screenshot({ path: join(OUT, "label-delete-1280.png") });
await page.click("#label-delete-cancel");
await page.waitForSelector("#label-delete-backdrop[hidden]", { state: "attached", timeout: 10000 });
stateNow = await apiStateNow();
check("#99: standing the label dialog down keeps the label on its cards",
  !!stateNow && stateNow.labels.some((l) => l.id === dialogLabelId) &&
    [wear1.json.card.id, wear2.json.card.id].every((id) =>
      ((stateNow.cards.find((c) => c.id === id) || {}).labels || []).includes(dialogLabelId)),
  "");
await labelRow.locator('[data-role="delete"]').click();
await page.waitForSelector("#label-delete-backdrop:not([hidden])", { timeout: 10000 });
await page.click("#label-delete-confirm");
await page.waitForFunction(
  (id) => !document.querySelector('[data-label-row="' + id + '"]'),
  dialogLabelId, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(500);
stateNow = await apiStateNow();
check("#99: confirming deletes the label and strips it from every card",
  !!stateNow && !stateNow.labels.some((l) => l.id === dialogLabelId) &&
    [wear1.json.card.id, wear2.json.card.id].every((id) =>
      !(((stateNow.cards.find((c) => c.id === id) || {}).labels || []).includes(dialogLabelId))),
  "");
// The plain wording when no card wears the label.
const BARE_LABEL = "Dialog bare label " + Date.now();
const bareRes = await apiCall("POST", "/api/v1/labels", { board_id: personalBoard.id, name: BARE_LABEL, colour: "blue" });
const bareLabelId = bareRes.json && bareRes.json.label && bareRes.json.label.id;
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
await page.click("#settings-open");
await page.click('[data-settings-page="settings-labels-section"]');
await page.waitForSelector("#labels-board-picker", { timeout: 10000 });
const bareRow = page.locator('[data-label-row="' + bareLabelId + '"]');
await bareRow.locator('[data-role="delete"]').click();
await page.waitForSelector("#label-delete-backdrop:not([hidden])", { timeout: 10000 });
const bareDialogText = await page.locator("#label-delete-text").textContent();
check("#99: a label no card wears gets the plain wording",
  (bareDialogText || "").includes(BARE_LABEL) && /No cards/.test(bareDialogText || ""),
  (bareDialogText || "").slice(0, 140));
await page.click("#label-delete-cancel");
await page.waitForSelector("#label-delete-backdrop[hidden]", { state: "attached", timeout: 10000 });
await page.click("#settings-close").catch(() => {});

// --- Stale refreshes in the open editor (issues #164, #165) -------------------
// A refresh fetch can read the state before the person's own
// change lands and carry that older snapshot back after it —
// the snapshot is genuine, just late. What the editor must
// never do is rewind to it: the Next step chooser must hold
// the holder the person just picked (#164), in both windows
// where the late snapshot can land — while the hand-over
// itself is still in flight, and after it has landed — and a
// Close press must not stop on a "changed somewhere else"
// question about a change that never happened (#165). The
// walk holds the app's state fetches at the network — on the
// browser context, not the page, because the app's fetches
// ride its service worker once the worker controls the page
// and page routes never see them — and answers the first with
// a snapshot taken before the person's change, while the
// follow-up fetch is still being held.
{
  const staleBoardRes = await apiCall("POST", "/api/v1/boards", { name: "UI Stale Board" });
  const staleBoard = staleBoardRes.json.board;
  const staleCardRes = await apiCall("POST", "/api/v1/cards", {
    board_id: staleBoard.id, column_id: "inbox", title: "UI stale chooser card",
    next_step: uiKeyId,
  });
  const staleOtherRes = await apiCall("POST", "/api/v1/cards", {
    board_id: staleBoard.id, column_id: "inbox", title: "UI stale other card",
  });
  const staleCard = staleCardRes.json.card;
  const staleOther = staleOtherRes.json.card;
  check("#164/#165: the stale-refresh fixtures stand",
    staleBoardRes.status === 201 && staleCardRes.status === 201 && staleOtherRes.status === 201 &&
      !!staleCard.step && staleCard.step.holder === "agent",
    "statuses " + staleBoardRes.status + "/" + staleCardRes.status + "/" + staleOtherRes.status);

  let staleArmed = false;
  const heldStateRoutes = [];
  const staleStateHandler = async (route) => {
    if (!staleArmed) { await route.continue(); return; }
    heldStateRoutes.push(route);
  };
  await page.context().route("**/api/state", staleStateHandler);
  let cardPatchArmed = false;
  const heldCardPatches = [];
  const staleCardPatchHandler = async (route) => {
    if (!cardPatchArmed || route.request().method() !== "PATCH") { await route.continue(); return; }
    heldCardPatches.push(route);
  };
  await page.context().route("**/api/cards/*", staleCardPatchHandler);
  async function waitHeld(list, n, tries) {
    for (let i = 0; i < (tries || 200) && list.length < n; i++) {
      await page.waitForTimeout(50);
    }
    return list.length >= n;
  }
  async function releaseHeld(list, index, body) {
    const route = list[index];
    if (!route) return;
    try {
      if (body != null) {
        await route.fulfill({ status: 200, headers: { "content-type": "application/json" }, body });
      } else {
        await route.continue();
      }
    } catch (e) { /* the route already went on its way */ }
  }
  async function personStateText() {
    return page.evaluate(async () => {
      const r = await fetch("/api/state");
      return r.text();
    });
  }

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  await page.click('.board-tab[data-board="' + staleBoard.id + '"]');
  await page.waitForSelector(".card .card-title:text-is(\"UI stale chooser card\")", { timeout: 10000 });

  // #164, the in-flight window: the stale snapshot lands while
  // the hand-over's own save is still out.
  await page.locator(".card", { hasText: "UI stale chooser card" }).first().click();
  await page.waitForSelector("#editor-backdrop:not([hidden])", { timeout: 10000 });
  const chooserAtOpen = await page.inputValue("#field-step").catch(() => "?");
  const staleTextA = await personStateText();
  staleArmed = true;
  cardPatchArmed = true;
  await apiCall("PATCH", "/api/v1/cards/" + staleOther.id, { title: "UI stale other changed" });
  const heldA1 = await waitHeld(heldStateRoutes, 1);
  await page.selectOption("#field-step", "owner");
  const patchHeld = await waitHeld(heldCardPatches, 1);
  await releaseHeld(heldStateRoutes, 0, staleTextA);
  // Give the stale landing time to be taken in: the follow-up
  // fetch starting is the sign, but the refresh waits on the
  // person's own in-flight write, so the follow-up may not
  // start until the held hand-over below is released — its
  // arrival is reported in the check's detail, not required.
  const followUpA = await waitHeld(heldStateRoutes, 2, 60);
  const chooserInFlight = await page.inputValue("#field-step").catch(() => "?");
  check("#164: the chooser holds the person's new holder while the hand-over itself is still in flight",
    chooserAtOpen === uiKeyId && heldA1 && patchHeld && chooserInFlight === "owner",
    "chooser=" + chooserInFlight + " at open=" + chooserAtOpen +
      " held=" + heldA1 + "/" + patchHeld + "/" + followUpA);
  // Let the hand-over land, then let the refresh catch up.
  await releaseHeld(heldCardPatches, 0, null);
  cardPatchArmed = false;
  const handedBack = await waitForCard(staleCard.id, (c) =>
    c.step && c.step.holder === "owner");
  for (let i = 1; i < heldStateRoutes.length; i++) await releaseHeld(heldStateRoutes, i, null);
  staleArmed = false;
  await page.waitForFunction(
    () => (document.body.innerText || "").includes("UI stale other changed"),
    null, { timeout: 10000 }).catch(() => {});
  check("#164: the hand-over landed and the board caught up after the in-flight window",
    !!handedBack, "");
  await page.click("#editor-close");
  await page.waitForSelector("#editor-backdrop[hidden]", { state: "attached", timeout: 10000 }).catch(() => {});

  // #164, the landed window: the stale snapshot was read
  // before the hand-over and is delivered after it.
  heldStateRoutes.length = 0;
  await apiCall("PATCH", "/api/v1/cards/" + staleCard.id, { next_step: uiKeyId });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  await page.click('.board-tab[data-board="' + staleBoard.id + '"]');
  await page.waitForSelector(".card .card-title:text-is(\"UI stale chooser card\")", { timeout: 10000 });
  await page.locator(".card", { hasText: "UI stale chooser card" }).first().click();
  await page.waitForSelector("#editor-backdrop:not([hidden])", { timeout: 10000 });
  const staleTextB = await personStateText();
  staleArmed = true;
  await apiCall("PATCH", "/api/v1/cards/" + staleOther.id, { title: "UI stale other changed more" });
  const heldB1 = await waitHeld(heldStateRoutes, 1);
  await page.selectOption("#field-step", "owner");
  const handedStale = await waitForCard(staleCard.id, (c) =>
    c.step && c.step.holder === "owner");
  await page.waitForFunction(
    () => ((document.getElementById("step-line") || {}).textContent || "").includes("You"),
    null, { timeout: 10000 }).catch(() => {});
  await releaseHeld(heldStateRoutes, 0, staleTextB);
  const heldB2 = await waitHeld(heldStateRoutes, 2);
  const chooserDuringStale = await page.inputValue("#field-step").catch(() => "?");
  check("#164: the chooser holds the person's new holder while a stale refresh is still landing",
    heldB1 && heldB2 && !!handedStale && chooserDuringStale === "owner",
    "chooser=" + chooserDuringStale + " held=" + heldB1 + "/" + heldB2);
  await releaseHeld(heldStateRoutes, 1, null);
  staleArmed = false;
  await page.waitForFunction(
    () => (document.body.innerText || "").includes("UI stale other changed more"),
    null, { timeout: 10000 }).catch(() => {});
  const chooserAfterHeal = await page.inputValue("#field-step").catch(() => "?");
  check("#164: the chooser still names the holder once the refresh has caught up",
    chooserAfterHeal === "owner", "chooser=" + chooserAfterHeal);
  await page.click("#editor-close");
  await page.waitForSelector("#editor-backdrop[hidden]", { state: "attached", timeout: 10000 }).catch(() => {});

  // #165: a Close pressed once closes, over a stale refresh.
  heldStateRoutes.length = 0;
  await page.locator(".card", { hasText: "UI stale chooser card" }).first().click();
  await page.waitForSelector("#editor-backdrop:not([hidden])", { timeout: 10000 });
  const staleText165 = await personStateText();
  await apiCall("PATCH", "/api/v1/cards/" + staleCard.id, { title: "UI stale server title" });
  await page.waitForFunction(
    () => document.getElementById("field-title").value === "UI stale server title",
    null, { timeout: 10000 }).catch(() => {});
  await page.fill("#field-title", "UI stale my title");
  staleArmed = true;
  await apiCall("PATCH", "/api/v1/cards/" + staleOther.id, { title: "UI stale other changed again" });
  const heldC1 = await waitHeld(heldStateRoutes, 1);
  await releaseHeld(heldStateRoutes, 0, staleText165);
  // A refused stale snapshot is fetched again at once; either
  // way the Close below is pressed into the settled moment
  // after the stale landing, with any follow-up still held.
  await waitHeld(heldStateRoutes, 2, 40);
  await page.click("#editor-close");
  let closeTook = true;
  await page.waitForSelector("#editor-backdrop[hidden]", { state: "attached", timeout: 3000 })
    .catch(() => { closeTook = false; });
  const phantomConflict = await page.locator("#editor-conflict:not([hidden])").isVisible().catch(() => false);
  check("#165: a Close pressed once closes the editor while a stale refresh lands",
    heldC1 && closeTook,
    "closed=" + closeTook + " held=" + heldC1);
  check("#165: no phantom conflict question stands after a stale refresh",
    !phantomConflict, "conflict shown=" + phantomConflict);
  for (let i = 1; i < heldStateRoutes.length; i++) await releaseHeld(heldStateRoutes, i, null);
  staleArmed = false;
  await page.context().unroute("**/api/state", staleStateHandler);
  await page.context().unroute("**/api/cards/*", staleCardPatchHandler);
  // Stand the editor down whatever the checks found, so the
  // walks after this one start from a closed editor: answer a
  // standing conflict with Keep mine, then close.
  await page.waitForFunction(
    () => (document.body.innerText || "").includes("UI stale other changed again"),
    null, { timeout: 10000 }).catch(() => {});
  if (await page.locator("#editor-conflict:not([hidden])").isVisible().catch(() => false)) {
    await page.click("#editor-conflict-mine");
  }
  if (await page.locator("#editor-backdrop:not([hidden])").isVisible().catch(() => false)) {
    await page.click("#editor-close");
  }
  await page.waitForSelector("#editor-backdrop[hidden]", { state: "attached", timeout: 10000 }).catch(() => {});
}

// --- Moving a card to another board (issue #163) ------------------------------
// The editor's Move board button opens a dialog picking the
// board, the column and the project. The board defaults to a
// board that is not the card's; changing it re-aims the column
// and the project by name and re-writes the line naming the
// labels that would be left behind. Confirming closes the
// editor with the card standing on the destination board.
{
  const mvSrcRes = await apiCall("POST", "/api/v1/boards", { name: "UI Move Source" });
  const mvDstRes = await apiCall("POST", "/api/v1/boards", { name: "UI Move Dest" });
  const uiSrc = mvSrcRes.json.board; const uiDst = mvDstRes.json.board;
  await apiCall("POST", "/api/v1/columns", { board_id: uiDst.id, name: "In Progress", kind: "in-progress-ui" });
  const uiSrcCross = (await apiCall("POST", "/api/v1/labels", { board_id: uiSrc.id, name: "UI Crossing", colour: "red" })).json.label;
  const uiSrcOnly = (await apiCall("POST", "/api/v1/labels", { board_id: uiSrc.id, name: "UI Source Only", colour: "green" })).json.label;
  const uiDstCross = (await apiCall("POST", "/api/v1/labels", { board_id: uiDst.id, name: "UI Crossing", colour: "blue" })).json.label;
  const uiSrcProject = (await apiCall("POST", "/api/v1/projects", { board_id: uiSrc.id, name: "UI Shared" })).json.project;
  const uiDstProject = (await apiCall("POST", "/api/v1/projects", { board_id: uiDst.id, name: "UI Shared" })).json.project;
  const uiDstOwnProject = (await apiCall("POST", "/api/v1/projects", { board_id: uiDst.id, name: "UI Dest Project" })).json.project;
  const UI_MOVE_TITLE = "UI move card " + Date.now();
  const uiCardRes = await apiCall("POST", "/api/v1/cards", {
    board_id: uiSrc.id, column_id: "doing", title: UI_MOVE_TITLE,
    labels: [uiSrcCross.id, uiSrcOnly.id], project_id: uiSrcProject.id,
  });
  const uiCard = uiCardRes.json.card;
  check("#163 ui: the move fixtures stand",
    mvSrcRes.status === 201 && mvDstRes.status === 201 && uiCardRes.status === 201 && !!uiCard,
    "statuses " + mvSrcRes.status + "/" + mvDstRes.status + "/" + uiCardRes.status);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  await page.click('.board-tab[data-board="' + uiSrc.id + '"]');
  await page.waitForSelector(".card .card-title:text-is(\"" + UI_MOVE_TITLE + "\")", { timeout: 10000 });
  await page.locator(".card", { hasText: UI_MOVE_TITLE }).first().click();
  await page.waitForSelector("#editor-backdrop:not([hidden])", { timeout: 10000 });
  await page.waitForSelector("#editor-move-board:not([hidden])", { timeout: 10000 });
  await page.click("#editor-move-board");
  await page.waitForSelector("#move-board-backdrop:not([hidden])", { timeout: 10000 });
  const defaultBoard = await page.inputValue("#move-board-board");
  check("#163 ui: the dialog's board defaults to a board that is not the card's",
    !!defaultBoard && defaultBoard !== uiSrc.id, "default " + defaultBoard);
  await page.selectOption("#move-board-board", uiDst.id);
  const reaimedColumn = await page.inputValue("#move-board-column");
  const reaimedProject = await page.inputValue("#move-board-project");
  check("#163 ui: changing the board re-aims the column and project by name",
    reaimedColumn === "doing" && reaimedProject === uiDstProject.id,
    "column " + reaimedColumn + " project " + reaimedProject);
  const leftBehind = await page.locator("#move-board-labels").textContent();
  check("#163 ui: the dialog names the label that would be left behind",
    !!leftBehind && leftBehind.includes("UI Source Only") && !leftBehind.includes("UI Crossing"),
    leftBehind || "no line");
  await page.screenshot({ path: join(OUT, "move-board-1280.png") });
  await page.selectOption("#move-board-column", "in-progress-ui");
  await page.selectOption("#move-board-project", uiDstOwnProject.id);
  await page.click("#move-board-confirm");
  await page.waitForSelector("#move-board-backdrop[hidden]", { state: "attached", timeout: 10000 });
  await page.waitForSelector("#editor-backdrop[hidden]", { state: "attached", timeout: 10000 });
  const uiState = await apiCall("GET", "/api/v1/state");
  const uiMoved = uiState.json.cards.find((c) => c.id === uiCard.id);
  check("#163 ui: after confirming, the editor is closed and the card stands on the destination board",
    !!uiMoved && uiMoved.boardId === uiDst.id && uiMoved.columnId === "in-progress-ui" &&
      uiMoved.projectId === uiDstOwnProject.id &&
      JSON.stringify(uiMoved.labels) === JSON.stringify([uiDstCross.id]),
    JSON.stringify(uiMoved && { board: uiMoved.boardId, column: uiMoved.columnId, labels: uiMoved.labels }));
  await page.waitForSelector(".card .card-title:text-is(\"" + UI_MOVE_TITLE + "\")", { timeout: 10000 });
  check("#163 ui: the destination board is on screen with the card in it", true, "");

  // The dialog at phone width, for the screenshot: the card now
  // stands on the destination board, and its editor offers the
  // move from there.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".card", { hasText: UI_MOVE_TITLE }).first().click();
  await page.waitForSelector("#editor-backdrop:not([hidden])", { timeout: 10000 });
  await page.click("#editor-move-board");
  await page.waitForSelector("#move-board-backdrop:not([hidden])", { timeout: 10000 });
  await page.screenshot({ path: join(OUT, "move-board-390.png") });
  await page.click("#move-board-cancel");
  await page.waitForSelector("#move-board-backdrop[hidden]", { state: "attached", timeout: 10000 });
  await page.click("#editor-close");
  await page.waitForSelector("#editor-backdrop[hidden]", { state: "attached", timeout: 10000 }).catch(() => {});
  await page.setViewportSize({ width: 1280, height: 900 });
  // Leave the person standing on their Personal board again:
  // this section runs mid-drill, and the walks after it work
  // from the board the earlier walks left standing.
  await page.click('.board-tab[data-board="' + personalBoard.id + '"]');
}

// --- The person's name, and what the browser keeps (issues #58, #66, #70) -----------
await page.click("#settings-open");
await page.click('[data-settings-page="settings-account"]');
await page.waitForSelector("#account-name-input", { timeout: 10000 });
await page.fill("#account-name-input", "Drill Person");
await page.evaluate(() => document.getElementById("account-name-input").blur());
await page.waitForTimeout(600);
const accountName = await page.locator("#account-name").textContent();
check("#66: the account page shows the new name at once",
  (accountName || "").includes("Drill Person"), accountName || "");
await page.screenshot({ path: join(OUT, "account-1280.png") });
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
await page.click("#settings-open");
await page.click('[data-settings-page="settings-account"]');
await page.waitForSelector("#account-name-input", { timeout: 10000 });
const persistedName = await page.inputValue("#account-name-input");
check("#66: the name stands after a reload",
  persistedName === "Drill Person", persistedName);
// Issue #131: the rename is the sign-in name's rename too.
// Sign out: the pick list must offer the new name and not
// the old; signing in under the new name must work; the
// Admin roster must list the new name and not the old. The
// name is then set back for the walks that follow.
await page.click("#logout-link");
await page.waitForURL(/\/login/, { timeout: 10000 });
const oldPick131 = await page.locator('input[name="name"][value="Drill A"]').count();
const newPick131 = await page.locator('input[name="name"][value="Drill Person"]').count();
check("#131: the sign-in pick list offers the new name and not the old",
  newPick131 === 1 && oldPick131 === 0,
  "new " + newPick131 + " old " + oldPick131);
if (newPick131 === 1) {
  await page.check('input[name="name"][value="Drill Person"]');
  await showPasswordView(page);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  check("#131: signing in under the new name loads the boards", true, page.url());
  await page.click("#settings-open");
  await page.click('[data-settings-page="settings-people"]');
  await page.waitForSelector("#people-list", { timeout: 10000 });
  const rosterText131 = await page.locator("#people-list").innerText();
  check("#131: the Admin roster lists the new name and not the old",
    rosterText131.includes("Drill Person") && !rosterText131.includes("Drill A"),
    rosterText131.replace(/\s+/g, " ").slice(0, 160));
  await page.screenshot({ path: join(OUT, "admin-roster-renamed-1280.png") });
  await page.click("#settings-close").catch(() => {});
  await page.click("#settings-open");
  await page.click('[data-settings-page="settings-account"]');
  await page.waitForSelector("#account-name-input", { timeout: 10000 });
  await page.fill("#account-name-input", "Drill A");
  await page.evaluate(() => document.getElementById("account-name-input").blur());
  await page.waitForTimeout(600);
  const nameBack131 = await page.locator("#account-name").textContent();
  check("#131: the name is set back for the walks that follow",
    (nameBack131 || "").includes("Drill A"), nameBack131 || "");
} else {
  check("#131: signing in under the new name loads the boards",
    false, "the pick list offered no new name");
  check("#131: the Admin roster lists the new name and not the old",
    false, "the pick list offered no new name");
  check("#131: the name is set back for the walks that follow",
    false, "the rename never stood");
  // Sign back in under the old name so the walks after this
  // one can run at all.
  if (oldPick131 === 1) {
    await page.check('input[name="name"][value="Drill A"]');
    await showPasswordView(page);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  }
}

const mirrorRaw = await page.evaluate(() => localStorage.getItem("tasksparkle-mirror"));
const mirror = mirrorRaw ? JSON.parse(mirrorRaw) : null;
check("#58: the mirror in local storage holds no name",
  mirror === null || !("name" in mirror), mirrorRaw || "no mirror");
// A stale mirror from before the fix: the name goes on the
// next open, the theme copy stays.
await page.evaluate(() => {
  const m = JSON.parse(localStorage.getItem("tasksparkle-mirror") || "{}");
  m.name = "Stale Name";
  localStorage.setItem("tasksparkle-mirror", JSON.stringify(m));
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
const mirrorAfter = JSON.parse(await page.evaluate(() => localStorage.getItem("tasksparkle-mirror") || "{}"));
check("#58: a stale name left in the mirror is cleared on the next open",
  !("name" in mirrorAfter) && typeof mirrorAfter.theme === "string",
  JSON.stringify(mirrorAfter));

await page.click("#settings-open");
await page.click('[data-settings-page="settings-account"]');
await page.waitForSelector("#logout-link", { timeout: 10000 });

// The sign-in section (issue #109): the passkey list stands on
// the account page, and the change-password walk runs end to
// end — the new password is set, then set back, so the walks
// after this one sign in with the drill password as before.
await page.waitForSelector("#account-passkey-add", { timeout: 10000 });
const passkeyListText = await page.locator("#account-passkeys-list").innerText();
check("#109: the account page's passkey section stands, listing what the account holds",
  passkeyListText.includes("No passkeys yet") || passkeyListText.includes("Passkey"),
  passkeyListText.slice(0, 80));
const UI_NEW_PW = "ui-drill-changed-password";
// Issue #114: the form carries no current-password field —
// the freshness proof comes through the proof panel. When
// the run is given the instance's data file (--data-file),
// the walk first ages the session's proof past its window in
// the file itself, so the refusal the panel answers is the
// server's own; the proof then goes through the real proof
// route and the act retries and lands. Without a data file
// the walk takes whichever honest path the server gives —
// panel or direct — and proves through the panel if it opens.
check("#114: the change form has no current-password field",
  (await page.locator("#account-password-current").count()) === 0, "");
let proofAged = false;
if (args["data-file"]) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(args["data-file"]);
    db.prepare("UPDATE sessions SET proof_at = 0").run();
    db.close();
    proofAged = true;
  } catch (e) {
    console.log("  (proof aging skipped: " + String(e).slice(0, 80) + ")");
  }
}
await page.fill("#account-password-new", UI_NEW_PW);
await page.fill("#account-password-confirm", UI_NEW_PW);
await page.click("#account-password-btn");
const panelShown = await page.waitForSelector("#account-proof-panel:not([hidden])",
  { timeout: 6000 }).then(() => true).catch(() => false);
if (proofAged) {
  check("#114: a stale proof is asked for through the panel, not silently accepted",
    panelShown, "");
}
if (panelShown) {
  await page.fill("#account-proof-password", PASSWORD);
  await page.click("#account-proof-password-btn");
}
await page.waitForFunction(
  () => (document.getElementById("account-auth-note") || {}).textContent.includes("Password changed"),
  undefined, { timeout: 10000 }).catch(() => {});
const pwNote = await page.locator("#account-auth-note").textContent();
check("#109: changing the password in the app lands and says so",
  (pwNote || "").includes("Password changed"), (pwNote || "").slice(0, 90));
await page.screenshot({ path: join(OUT, "account-signin-1280.png") });
await page.fill("#account-password-new", PASSWORD);
await page.fill("#account-password-confirm", PASSWORD);
await page.click("#account-password-btn");
const panelAgain = await page.waitForSelector("#account-proof-panel:not([hidden])",
  { timeout: 3000 }).then(() => true).catch(() => false);
if (panelAgain) {
  await page.fill("#account-proof-password", UI_NEW_PW);
  await page.click("#account-proof-password-btn");
}
await page.waitForFunction(
  () => (document.getElementById("account-auth-note") || {}).textContent.includes("Password changed"),
  undefined, { timeout: 10000 }).catch(() => {});
const pwNoteBack = await page.locator("#account-auth-note").textContent();
check("#109: the password is set back for the walks that follow",
  (pwNoteBack || "").includes("Password changed"), (pwNoteBack || "").slice(0, 90));

// Passkey-first in the browser (issue #122): the Account
// page's password section in its two states, and the drop
// behind its dialog. The account's standing passkeys came
// from the API drill's own authenticators, whose keys this
// browser does not hold, so the walk first removes them
// through their own route (the HTTP walk below does the
// same), then enrols this device's passkey through the
// page's own acts — the one credential this browser can
// prove the drop with.
const acctCdp = await page.context().newCDPSession(page);
await acctCdp.send("WebAuthn.enable");
await acctCdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
await page.evaluate(async () => {
  const meRes = await fetch("/api/auth/me");
  const me = await meRes.json().catch(() => null);
  for (const pk of (me && me.passkeys) || []) {
    await fetch("/api/auth/passkeys/" + encodeURIComponent(pk.id), { method: "DELETE" });
  }
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
await page.click("#settings-open");
await page.click('[data-settings-page="settings-account"]');
await page.waitForSelector("#account-passkey-add", { timeout: 10000 });
await page.fill("#account-passkey-nickname", "Drop walk device");
await page.click("#account-passkey-add");
const dropEnrolPanel = await page.waitForSelector("#account-proof-panel:not([hidden])",
  { timeout: 6000 }).then(() => true).catch(() => false);
if (dropEnrolPanel) {
  await page.fill("#account-proof-password", PASSWORD);
  await page.click("#account-proof-password-btn");
}
await page.waitForFunction(
  () => (document.getElementById("account-passkeys-list") || { textContent: "" })
    .textContent.includes("Drop walk device"), undefined, { timeout: 15000 }).catch(() => {});
const dropListText = await page.locator("#account-passkeys-list").innerText();
check("#122: the drop walk enrols this device's passkey through the page's own acts",
  dropListText.includes("Drop walk device"), dropListText.slice(0, 90));
// Issue #132: a second passkey, added while one stands. The
// step-up demands a passkey tap; after the tap the enrolment
// ceremony must actually run and the new passkey must stand
// in the list — on the broken code the ceremony never fired
// and the list silently kept one passkey.
await page.fill("#account-passkey-nickname", "Second walk device");
await page.click("#account-passkey-add");
await page.waitForSelector("#account-proof-panel:not([hidden])", { timeout: 10000 });
check("#132: adding a second passkey asks for a passkey tap first",
  (await page.locator("#account-proof-password-btn").isHidden().catch(() => true)) &&
    (await page.locator("#account-proof-passkey-btn").isVisible()), "");
await page.click("#account-proof-passkey-btn");
await page.waitForFunction(
  () => (document.getElementById("account-passkeys-list") || { textContent: "" })
    .textContent.includes("Second walk device"), undefined, { timeout: 15000 }).catch(() => {});
const secondListText = await page.locator("#account-passkeys-list").innerText();
check("#132: the second enrolment completes — both passkeys stand in the list",
  secondListText.includes("Drop walk device") && secondListText.includes("Second walk device"),
  secondListText.slice(0, 120));
await page.screenshot({ path: join(OUT, "account-two-passkeys-1280.png") });
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: join(OUT, "account-two-passkeys-390.png") });
await page.setViewportSize({ width: 1280, height: 900 });
check("#122: with a password and a passkey standing, the Account page offers the drop",
  await page.locator("#account-password-remove").isVisible(), "");
await page.click("#account-password-remove");
await page.waitForSelector("#password-drop-backdrop:not([hidden])", { timeout: 6000 });
const dropText = await page.locator("#password-drop-text").innerText();
check("#122: the drop dialog names the recovery story before the confirm stands",
  dropText.includes("sign in with your passkeys alone") &&
    dropText.includes("recovery link") &&
    dropText.includes("address changes"),
  dropText.replace(/\s+/g, " ").slice(0, 170));
await page.screenshot({ path: join(OUT, "account-drop-dialog-1280.png") });
await page.click("#password-drop-confirm");
const dropPanel = await page.waitForSelector("#account-proof-panel:not([hidden])",
  { timeout: 6000 }).then(() => true).catch(() => false);
if (dropPanel) {
  check("#122: the drop asks for a passkey tap — the proof panel offers no password proof for it",
    (await page.locator("#account-proof-password-btn").isHidden().catch(() => true)) &&
      (await page.locator("#account-proof-passkey-btn").isVisible()),
    "");
  await page.click("#account-proof-passkey-btn");
}
await page.waitForFunction(
  () => (document.getElementById("account-auth-note") || {}).textContent.includes("Password removed"),
  undefined, { timeout: 15000 }).catch(() => {});
const dropNote = await page.locator("#account-auth-note").textContent();
check("#122: the drop lands and the page says so",
  (dropNote || "").includes("Password removed"), (dropNote || "").slice(0, 90));
const noPwSection = await page.locator("#account-password-section").innerText();
check("#122: the password section now reads as a state, with the add standing under it",
  noPwSection.includes("No password — you sign in with a passkey.") &&
    (await page.locator("#account-password-btn").innerText()).includes("Add a password"),
  noPwSection.replace(/\s+/g, " ").slice(0, 130));
await page.screenshot({ path: join(OUT, "account-nopassword-1280.png") });
await page.fill("#account-password-new", PASSWORD);
await page.fill("#account-password-confirm", PASSWORD);
await page.click("#account-password-btn");
await page.waitForFunction(
  () => (document.getElementById("account-auth-note") || {}).textContent.includes("Password added"),
  undefined, { timeout: 15000 }).catch(() => {});
const addNote = await page.locator("#account-auth-note").textContent();
check("#122: adding the password back lands behind the passkey proof",
  (addNote || "").includes("Password added"), (addNote || "").slice(0, 90));
check("#122: the section stands in its password state again, the drop offered once more",
  (await page.locator("#account-password-btn").innerText()).includes("Change password") &&
    (await page.locator("#account-password-remove").isVisible()), "");

// Issue #114: headings are visibly headings at both widths —
// the section's h3 and its h4s sit above the body size, on
// the desktop and at the phone width alike. (The h4s once had
// no size of their own and rendered at body size.)
const headingSizes = () => page.evaluate(() => {
  const size = (sel) => {
    const el = document.querySelector(sel);
    return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
  };
  return {
    body: parseFloat(getComputedStyle(document.body).fontSize),
    h3: size("#settings-account h3"),
    h4: size("#settings-account h4"),
  };
});
const sizesWide = await headingSizes();
check("#114: at 1280 the Account headings stand above body size",
  sizesWide.h3 > sizesWide.body && sizesWide.h4 > sizesWide.body,
  JSON.stringify(sizesWide));
await page.screenshot({ path: join(OUT, "account-headings-1280.png") });
await page.setViewportSize({ width: 390, height: 844 });
const sizesPhone = await headingSizes();
check("#114: at 390 the Account headings still stand above body size",
  sizesPhone.h3 > sizesPhone.body && sizesPhone.h4 > sizesPhone.body,
  JSON.stringify(sizesPhone));
await page.screenshot({ path: join(OUT, "account-headings-390.png") });
await page.setViewportSize({ width: 1280, height: 900 });

// --- The reset form's start fresh, in the browser (issue #133) -----
// Drill B enrols a passkey in a fresh context, then spends a
// reset invite the way the sweep did: new password typed,
// start fresh ticked, Set password pressed. The ceremony
// must run from that press, and B ends holding exactly the
// new passkey — removal without enrolment is impossible.
{
  const bctx = await browser.newContext({
    viewport: { width: 1280, height: 900 }, serviceWorkers: "block",
  });
  const bp = await bctx.newPage();
  const bcdp = await bctx.newCDPSession(bp);
  await bcdp.send("WebAuthn.enable");
  await bcdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await bp.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await bp.check('input[name="name"][value="Drill B"]');
  await showPasswordView(bp);
  await bp.fill('input[name="password"]', B_PASSWORD);
  await bp.click('button[type="submit"]');
  await bp.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  await bp.click("#settings-open");
  await bp.click('[data-settings-page="settings-account"]');
  await bp.waitForSelector("#account-passkey-add", { timeout: 10000 });
  await bp.fill("#account-passkey-nickname", "B's reset walk device");
  await bp.click("#account-passkey-add");
  await bp.waitForFunction(
    () => (document.getElementById("account-passkeys-list") || { textContent: "" })
      .textContent.includes("B's reset walk device"), undefined, { timeout: 15000 }).catch(() => {});
  const bListBefore = await bp.locator("#account-passkeys-list").innerText();
  check("#133: B enrols a passkey for the reset walk",
    bListBefore.includes("B's reset walk device"), bListBefore.slice(0, 90));
  const mintedB = await page.evaluate(async () => {
    const res = await fetch("/api/auth/invites", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Drill B" }),
    });
    return res.json().catch(() => null);
  });
  const resetCodeB = mintedB && mintedB.code;
  check("#133: the administrator mints B's reset invite", !!resetCodeB,
    JSON.stringify(mintedB).slice(0, 90));
  const B_NEW_PW = "ui-drill-b-reset-password";
  await bp.goto(BASE + "/invite/" + resetCodeB, { waitUntil: "domcontentloaded" });
  await bp.waitForSelector('input[name="password"]', { timeout: 10000 });
  await bp.fill('input[name="password"]', B_NEW_PW);
  await bp.fill('input[name="confirm"]', B_NEW_PW);
  await bp.check('input[name="start_fresh"]');
  await bp.screenshot({ path: join(OUT, "reset-startfresh-1280.png") });
  await bp.setViewportSize({ width: 390, height: 844 });
  await bp.screenshot({ path: join(OUT, "reset-startfresh-390.png") });
  await bp.setViewportSize({ width: 1280, height: 900 });
  await bp.click('button[type="submit"]');
  await bp.waitForURL(BASE + "/", { timeout: 20000 }).catch(() => {});
  await bp.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 }).catch(() => {});
  check("#133: the ticked reset press runs the ceremony and lands B signed in",
    bp.url() === BASE + "/", bp.url());
  const meAfterB = await bp.evaluate(async () => {
    const res = await fetch("/api/auth/me");
    return res.json().catch(() => null);
  });
  check("#133: exactly one passkey stands after the start-fresh reset — the ceremony's new one",
    !!meAfterB && meAfterB.passkeys.length === 1 &&
      (meAfterB.passkeys[0].nickname || "") !== "B's reset walk device",
    JSON.stringify(meAfterB && meAfterB.passkeys));
  await bp.click("#settings-open");
  await bp.click('[data-settings-page="settings-account"]');
  await bp.waitForSelector("#account-passkeys-list", { timeout: 10000 });
  const bListAfter = await bp.locator("#account-passkeys-list").innerText();
  check("#133: B's Account page agrees — the old passkey is gone, the new one stands",
    !bListAfter.includes("B's reset walk device") && bListAfter.includes("Passkey"),
    bListAfter.slice(0, 120));
  await bp.screenshot({ path: join(OUT, "reset-startfresh-done-1280.png") });
  await bp.setViewportSize({ width: 390, height: 844 });
  await bp.screenshot({ path: join(OUT, "reset-startfresh-done-390.png") });
  await bp.setViewportSize({ width: 1280, height: 900 });
  await bp.click("#logout-link");
  await bp.waitForURL(/\/login/, { timeout: 10000 });
  await bp.check('input[name="name"][value="Drill B"]');
  await showPasswordView(bp);
  await bp.fill('input[name="password"]', B_PASSWORD);
  await bp.click('button[type="submit"]');
  await bp.waitForTimeout(1500);
  check("#133: B's old password no longer signs in after the ceremony spend",
    bp.url().includes("/login"), bp.url());
  await bp.click("#view-switch");
  await bp.click("#passkey-button");
  await bp.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 }).catch(() => {});
  check("#133: the ceremony's new passkey signs B in",
    await bp.locator("#board-ui:not([hidden])").isVisible().catch(() => false), bp.url());
  await bctx.close();
}

// The delete section (issue #57): the first press opens the
// dialog (issue #99 — the confirm lives in the dialog now,
// not in a box expanding on the page), the note names what
// goes and the backups' 14 days, and the act waits for DELETE
// typed in full inside the dialog. Cancel stands it
// down — the real deletion is the phone walk at the end.
await page.click("#account-delete-btn");
await page.waitForSelector("#account-delete-backdrop:not([hidden])", { timeout: 10000 });
const inPageConfirmCount = await page.locator("#account-delete-confirm").count();
check("#99: account delete asks in a dialog — no confirm box remains on the page",
  inPageConfirmCount === 0, "in-page confirms in the DOM: " + inPageConfirmCount);
const deleteNote = await page.locator("#account-delete-note").textContent();
check("#57: the delete confirm names what goes, and the backups' 14 days",
  /boards/.test(deleteNote || "") && /14 days/.test(deleteNote || ""), (deleteNote || "").slice(0, 90));
const confirmStartsDisabled = await page.isDisabled("#account-delete-confirm-btn");
await page.fill("#account-delete-type", "DELET");
const confirmStillDisabled = await page.isDisabled("#account-delete-confirm-btn");
await page.fill("#account-delete-type", "DELETE");
const confirmNowEnabled = await page.isEnabled("#account-delete-confirm-btn");
check("#57: the delete button waits for DELETE typed in full",
  confirmStartsDisabled && confirmStillDisabled && confirmNowEnabled,
  "start " + confirmStartsDisabled + " partial " + confirmStillDisabled + " full " + confirmNowEnabled);
await page.screenshot({ path: join(OUT, "account-delete-1280.png") });
// The sole-administrator refusal reaches the page (issue
// #149): on this instance A is the only administrator while
// other accounts stand, so the server refuses the deletion
// in plain words — and the dialog must show those words,
// not a connection error the person would retry against.
// The press is made only when the roster read back in this
// same moment says A stands alone as administrator.
const adminsNow = await page.evaluate(async () => {
  const res = await fetch("/api/auth/people");
  const body = await res.json().catch(() => null);
  return body ? (body.people || []).filter((p) => p.admin).map((p) => p.name) : [];
});
if (adminsNow.length === 1 && adminsNow[0] === NAME) {
  await page.click("#account-delete-confirm-btn");
  await page.waitForFunction(() => {
    const n = document.getElementById("account-delete-note");
    return !!n && (n.textContent || "").includes("only administrator");
  }, undefined, { timeout: 10000 }).catch(() => {});
  const refusalNote = await page.locator("#account-delete-note").textContent();
  check("#149: the sole-administrator refusal shows the server's own words, not a connection error",
    (refusalNote || "").includes("This account is the only administrator, and other accounts stand.") &&
      (refusalNote || "").includes("Make another person an administrator first.") &&
      !(refusalNote || "").includes("Check your connection"),
    (refusalNote || "").slice(0, 130));
  await page.screenshot({ path: join(OUT, "wave3-sole-admin-refusal-1280.png") });
} else {
  check("#149: the sole-administrator refusal shows the server's own words (skipped — the roster does not leave A alone)",
    true, "admins: " + adminsNow.join(", "));
}
await page.click("#account-delete-cancel");
await page.waitForSelector("#account-delete-backdrop[hidden]", { state: "attached", timeout: 10000 });

await page.click("#logout-link");
await page.waitForURL(/\/login/, { timeout: 10000 });
const mirrorGone = await page.evaluate(() => localStorage.getItem("tasksparkle-mirror"));
check("#58: logging out clears the mirror",
  mirrorGone === null, String(mirrorGone));

check("#70: no content-security-policy refusal fired while the app worked",
  cspViolations.length === 0, cspViolations[0] || "");
check("#70: the app page carries the security headers",
  !!docHeaders && /frame-ancestors 'none'/.test(docHeaders["content-security-policy"] || "") &&
    docHeaders["x-content-type-options"] === "nosniff" &&
    /'self'/.test(docHeaders["content-security-policy"] || ""),
  docHeaders ? (docHeaders["content-security-policy"] || "no csp header").slice(0, 80) : "no document response seen");

// --- Phone width: sign-in page and board --------------------------------------------
const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
await phone.goto(BASE + "/logout", { waitUntil: "domcontentloaded" }).catch(() => {});
await phone.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await phone.waitForURL(/\/login/, { timeout: 10000 }).catch(() => {});
await phone.screenshot({ path: join(OUT, "login-390.png") });
await phone.check('input[name="name"][value="' + NAME + '"]');
await showPasswordView(phone);
await phone.fill('input[name="password"]', PASSWORD);
await phone.click('button[type="submit"]');
await phone.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
await phone.screenshot({ path: join(OUT, "board-390.png") });
check("phone: the board loads at phone width", true, "");

// --- Card delete at phone width: the same dialog over the editor (issue #97) ----
await phone.reload({ waitUntil: "domcontentloaded" });
await phone.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
if (!(await phone.locator(".card .card-title:text-is(\"" + PHONE_TITLE + "\")").count())) {
  await phone.click('.step-btn[data-column="inbox"]');
}
await phone.locator(".card", { hasText: PHONE_TITLE }).first().click();
await phone.waitForSelector("#editor-backdrop:not([hidden])", { timeout: 10000 });
await phone.click("#editor-delete");
await phone.waitForSelector("#card-delete-backdrop:not([hidden])", { timeout: 10000 });
const phoneDialogText = await phone.locator("#card-delete-text").textContent();
check("#97: the phone's Delete opens the dialog over the editor too",
  (phoneDialogText || "").includes(PHONE_TITLE), (phoneDialogText || "").slice(0, 110));
await phone.screenshot({ path: join(OUT, "card-delete-390.png") });
await phone.click("#card-delete-cancel");
await phone.waitForSelector("#card-delete-backdrop[hidden]", { state: "attached", timeout: 10000 });
await phone.click("#editor-close");
await phone.waitForSelector("#editor-backdrop[hidden]", { state: "attached", timeout: 10000 });

// --- Agent key dialogs at phone width (issue #98) -------------------------------
// The same two dialogs at phone width, for the screenshots: a
// key made here, screenshotted in its dialog, stood down, then
// deleted through its dialog so nothing of it is left behind.
await phone.click("#settings-open");
await phone.click('[data-settings-page="setup-agent"]');
await phone.waitForSelector("#key-add", { timeout: 10000 });
await phone.fill("#key-add-name", "UI drill phone key");
await phone.click("#key-add");
await phone.waitForSelector("#key-created-backdrop:not([hidden])", { timeout: 10000 });
await phone.screenshot({ path: join(OUT, "key-created-390.png") });
await phone.click("#key-created-close");
await phone.waitForSelector("#key-created-backdrop[hidden]", { state: "attached", timeout: 10000 });
const phoneKeyRow = phone.locator("[data-key-row]", { hasText: "UI drill phone key" });
await phoneKeyRow.locator('[data-role="key-delete"]').click();
await phone.waitForSelector("#key-delete-backdrop:not([hidden])", { timeout: 10000 });
await phone.screenshot({ path: join(OUT, "key-delete-390.png") });
await phone.click("#key-delete-confirm");
await phone.waitForSelector("#key-delete-backdrop[hidden]", { state: "attached", timeout: 10000 });
await phone.click("#settings-close").catch(() => {});

// --- Label colour modes at phone width: the faces and the overview (issue #95) ---
// The overview is the board zoomed out, so the paint stands
// there too — but the colour lines scale down to the one-line
// rows: a 2px trim and a 4px top line, where the board's faces
// wear 4px and 12px. The faded background is a fill and does
// not change. The schedule view never paints (it is not the
// board); the rows there are covered by their own checks.
async function phonePaintOf(title) {
  return phone.locator(".card", { hasText: title }).first().evaluate((node) => {
    const cs = getComputedStyle(node);
    const chip = node.querySelector(".chip");
    const chipCs = chip ? getComputedStyle(chip) : null;
    return {
      paint: node.getAttribute("data-label-paint"),
      background: cs.backgroundColor,
      borderTopWidth: cs.borderTopWidth,
      borderLeftWidth: cs.borderLeftWidth,
      chipBackground: chipCs ? chipCs.backgroundColor : null,
      chipBorder: chipCs ? chipCs.borderColor : null,
    };
  });
}
async function ovPaintOf(title) {
  return phone.locator(".ov-card", { hasText: title }).first().evaluate((node) => {
    const cs = getComputedStyle(node);
    return {
      paint: node.getAttribute("data-label-paint"),
      background: cs.backgroundColor,
      borderTopWidth: cs.borderTopWidth,
      borderLeftWidth: cs.borderLeftWidth,
    };
  });
}
async function overviewOpenNow() {
  return (await phone.locator("#board-overview:not([hidden])").count()) > 0;
}
async function setOverview(open) {
  if ((await overviewOpenNow()) === open) return;
  await phone.click("#overview-toggle");
  await phone.waitForSelector(open ? ".ov-card" : "#board-overview[hidden]",
    open ? { timeout: 10000 } : { state: "attached", timeout: 10000 });
}
async function setModePhone(mode) {
  const r = await apiCall("PATCH", "/api/v1/boards/" + personalBoard.id, { label_colour_mode: mode });
  if (r.status !== 200) throw new Error("setting mode " + mode + " answered " + r.status);
  await phone.reload({ waitUntil: "domcontentloaded" });
  await phone.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  await setOverview(false);
  if (!(await phone.locator(".card .card-title:text-is(\"" + MULTI + "\")").count())) {
    await phone.click('.step-btn[data-column="inbox"]');
  }
  await phone.waitForSelector(".card .card-title:text-is(\"" + MULTI + "\")", { timeout: 10000 });
}
await setModePhone("background");
let phonePaint = await phonePaintOf(MULTI);
check("paint: the faded background paints the phone's card faces too",
  phonePaint.paint === "background" && phonePaint.background === phonePaint.chipBackground &&
    phonePaint.chipBackground !== null,
  "paint=" + phonePaint.paint + " card " + phonePaint.background + " chip " + phonePaint.chipBackground);
await phone.screenshot({ path: join(OUT, "paint-background-390.png") });
await setOverview(true);
let ovPaint = await ovPaintOf(MULTI);
check("paint: the overview's rows take the faded background as a fill, unchanged",
  ovPaint.paint === "background" && ovPaint.background === phonePaint.chipBackground,
  "paint=" + ovPaint.paint + " row " + ovPaint.background + " chip " + phonePaint.chipBackground);
const ovNone = await ovPaintOf(NONE);
check("paint: a label-less card's overview row stays plain", ovNone.paint === null, "paint=" + ovNone.paint);
await phone.screenshot({ path: join(OUT, "overview-background-390.png") });

await setModePhone("trim");
await setOverview(true);
ovPaint = await ovPaintOf(MULTI);
check("paint: the overview's trim is a line, not the face's block — 2px where the face wears 4px",
  ovPaint.paint === "trim" && ovPaint.borderTopWidth === "2px" && ovPaint.borderLeftWidth === "2px",
  "paint=" + ovPaint.paint + " top " + ovPaint.borderTopWidth + " left " + ovPaint.borderLeftWidth);
await phone.screenshot({ path: join(OUT, "overview-trim-390.png") });
await setOverview(false);
phonePaint = await phonePaintOf(MULTI);
check("paint: the phone's faces keep the full 4px trim",
  phonePaint.paint === "trim" && phonePaint.borderTopWidth === "4px" && phonePaint.borderLeftWidth === "4px",
  "paint=" + phonePaint.paint + " top " + phonePaint.borderTopWidth);
await phone.screenshot({ path: join(OUT, "paint-trim-390.png") });

await setModePhone("top");
await setOverview(true);
ovPaint = await ovPaintOf(MULTI);
check("paint: the overview's top band is a line — 4px where the face wears 12px",
  ovPaint.paint === "top" && ovPaint.borderTopWidth === "4px" && ovPaint.borderLeftWidth === "1px",
  "paint=" + ovPaint.paint + " top " + ovPaint.borderTopWidth + " left " + ovPaint.borderLeftWidth);
await phone.screenshot({ path: join(OUT, "overview-top-390.png") });
await setOverview(false);
phonePaint = await phonePaintOf(MULTI);
check("paint: the phone's faces keep the full 12px top band",
  phonePaint.paint === "top" && phonePaint.borderTopWidth === "12px" && phonePaint.borderLeftWidth === "1px",
  "paint=" + phonePaint.paint + " top " + phonePaint.borderTopWidth);
await phone.screenshot({ path: join(OUT, "paint-top-390.png") });

await setModePhone("chip");
phonePaint = await phonePaintOf(MULTI);
check("paint: back at chip the phone's faces are plain again",
  phonePaint.paint === null, "paint=" + phonePaint.paint);
await phone.click("#settings-open");
await phone.click('[data-settings-page="settings-account"]');
await phone.waitForSelector("#account-name-input", { timeout: 10000 });
await phone.screenshot({ path: join(OUT, "account-390.png") });
await phone.click("#settings-close").catch(() => {});
await phone.click('.step-btn[data-column="inbox"]');
await phone.waitForSelector(".card .card-title:text-is(\"" + KEY_TITLE + "\")", { timeout: 10000 });
await phone.screenshot({ path: join(OUT, "creator-tag-390.png") });
await phone.locator(".card", { hasText: RENAMED }).first().click();
await phone.waitForSelector("#editor-backdrop:not([hidden])", { timeout: 10000 });
const phoneComment = await phone.locator("[data-comment-row] .comment-body").first().textContent().catch(() => null);
check("phone: the comment stands in the editor at phone width",
  phoneComment === "UI drill update", "text=" + phoneComment);
await phone.screenshot({ path: join(OUT, "editor-comments-390.png") });
await phone.click("#editor-close");
await phone.waitForSelector("#editor-backdrop[hidden]", { state: "attached", timeout: 10000 });

// --- Settings pages at phone width (issue #96) ---------------------------------------
await phone.click("#settings-open");
await phone.click('[data-settings-page="settings-labels-section"]');
await phone.waitForSelector("#labels-board-picker", { timeout: 10000 });
await phone.screenshot({ path: join(OUT, "settings-labels-390.png") });
await phone.click("#settings-back");
await phone.click('[data-settings-page="settings-projects-section"]');
await phone.waitForSelector("#projects-board-picker", { timeout: 10000 });
await phone.screenshot({ path: join(OUT, "settings-projects-390.png") });
await phone.click("#settings-back");
await phone.click('[data-settings-page="settings-columns-section"]');
await phone.waitForSelector("#columns-board-picker", { timeout: 10000 });
await phone.screenshot({ path: join(OUT, "settings-columns-390.png") });
await phone.click("#settings-close").catch(() => {});

// --- Dialog sweep at phone width (issue #99) --------------------------------------
// The same three dialogs at phone width, for the screenshots:
// a project, a board and a label, each stood down once and
// then confirmed, so nothing of them is left behind.
const PHONE_PROJ = "Phone dialog project " + Date.now();
const phoneProjRes = await apiCall("POST", "/api/v1/projects", { board_id: personalBoard.id, name: PHONE_PROJ });
const phoneProjId = phoneProjRes.json && phoneProjRes.json.project && phoneProjRes.json.project.id;
const PHONE_BOARD = "Phone dialog board " + Date.now();
const phoneBoardRes = await apiCall("POST", "/api/v1/boards", { name: PHONE_BOARD });
const phoneBoardId = phoneBoardRes.json && phoneBoardRes.json.board && phoneBoardRes.json.board.id;
const PHONE_LABEL = "Phone dialog label " + Date.now();
const phoneLabelRes = await apiCall("POST", "/api/v1/labels", { board_id: personalBoard.id, name: PHONE_LABEL, colour: "red" });
const phoneLabelId = phoneLabelRes.json && phoneLabelRes.json.label && phoneLabelRes.json.label.id;
check("#99: the phone walk's project, board and label are made",
  phoneProjRes.status === 201 && phoneBoardRes.status === 201 && phoneLabelRes.status === 201,
  phoneProjRes.status + "/" + phoneBoardRes.status + "/" + phoneLabelRes.status);
await phone.reload({ waitUntil: "domcontentloaded" });
await phone.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
await phone.click("#settings-open");
await phone.click('[data-settings-page="settings-projects-section"]');
await phone.waitForSelector("#projects-board-picker", { timeout: 10000 });
const phoneProjRow = phone.locator('[data-project-row="' + phoneProjId + '"]');
await phoneProjRow.locator('[data-role="project-delete"]').click();
await phone.waitForSelector("#project-delete-backdrop:not([hidden])", { timeout: 10000 });
await phone.screenshot({ path: join(OUT, "project-delete-390.png") });
await phone.click("#project-delete-cancel");
await phone.waitForSelector("#project-delete-backdrop[hidden]", { state: "attached", timeout: 10000 });
await phoneProjRow.locator('[data-role="project-delete"]').click();
await phone.waitForSelector("#project-delete-backdrop:not([hidden])", { timeout: 10000 });
await phone.click("#project-delete-confirm");
await phone.waitForFunction(
  (id) => !document.querySelector('[data-project-row="' + id + '"]'),
  phoneProjId, { timeout: 10000 }).catch(() => {});
check("#99: the phone's project dialog deletes the project",
  (await phone.locator('[data-project-row="' + phoneProjId + '"]').count()) === 0, "");
await phone.click("#settings-back");
await phone.click('[data-settings-page="settings-boards"]');
const phoneBoardRow = phone.locator('[data-board-row="' + phoneBoardId + '"]');
await phoneBoardRow.waitFor({ timeout: 10000 });
await phoneBoardRow.locator('[data-role="board-delete"]').click();
await phone.waitForSelector("#board-delete-backdrop:not([hidden])", { timeout: 10000 });
await phone.screenshot({ path: join(OUT, "board-delete-390.png") });
await phone.click("#board-delete-cancel");
await phone.waitForSelector("#board-delete-backdrop[hidden]", { state: "attached", timeout: 10000 });
await phoneBoardRow.locator('[data-role="board-delete"]').click();
await phone.waitForSelector("#board-delete-backdrop:not([hidden])", { timeout: 10000 });
await phone.click("#board-delete-confirm");
await phone.waitForFunction(
  (id) => !document.querySelector('[data-board-row="' + id + '"]'),
  phoneBoardId, { timeout: 10000 }).catch(() => {});
check("#99: the phone's board dialog deletes the board",
  (await phone.locator('[data-board-row="' + phoneBoardId + '"]').count()) === 0, "");
await phone.click("#settings-back");
await phone.click('[data-settings-page="settings-labels-section"]');
await phone.waitForSelector("#labels-board-picker", { timeout: 10000 });
const phoneLabelRow = phone.locator('[data-label-row="' + phoneLabelId + '"]');
await phoneLabelRow.locator('[data-role="delete"]').click();
await phone.waitForSelector("#label-delete-backdrop:not([hidden])", { timeout: 10000 });
await phone.screenshot({ path: join(OUT, "label-delete-390.png") });
await phone.click("#label-delete-confirm");
await phone.waitForFunction(
  (id) => !document.querySelector('[data-label-row="' + id + '"]'),
  phoneLabelId, { timeout: 10000 }).catch(() => {});
check("#99: the phone's label dialog deletes the label",
  (await phone.locator('[data-label-row="' + phoneLabelId + '"]').count()) === 0, "");
await phone.click("#settings-close").catch(() => {});

// --- The remembered name and the transition door's Account section ------------------
// A fresh context, so its sign-outs never touch the main
// walk's session: it signs in as the drill person, proves the
// Account section's refusal state (issue #110), then walks
// the remembered name's whole life on the pick list (issue
// #112).
{
  // Service workers are blocked in this context: the app's
  // worker would carry the fetches itself, and the route
  // refusals below must be the ones answering.
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 }, serviceWorkers: "block",
  });
  const side = await ctx.newPage();
  await side.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await side.waitForURL(/\/login/, { timeout: 10000 }).catch(() => {});
  await side.check('input[name="name"][value="' + NAME + '"]');
  await showPasswordView(side);
  await side.fill('input[name="password"]', PASSWORD);
  await side.click('button[type="submit"]');
  await side.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  check("#112: the side context signs in for the sign-in walks", true, side.url());

  // Issue #110: with the sign-in routes refusing — the shape
  // the transition door presents to a caller who holds boards
  // but no account — the Account page's sign-in section
  // stands disabled under its note, and nothing navigates
  // away. A board-API refusal still navigates, as it must.
  await side.route("**/api/auth/**", (route) => route.fulfill({
    status: 401, contentType: "application/json",
    body: JSON.stringify({ error: "Sign-in is required." }),
  }));
  await side.reload({ waitUntil: "domcontentloaded" });
  await side.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  await side.click("#settings-open");
  await side.click('[data-settings-page="settings-account"]');
  await side.waitForFunction(
    () => (document.getElementById("account-auth-note") || {}).textContent
      .includes("Sign-in settings are not available"),
    undefined, { timeout: 10000 }).catch(() => {});
  const refusalNote = await side.locator("#account-auth-note").textContent();
  check("#110: the refused caller reads why the section stands down",
    (refusalNote || "").includes("Sign-in settings are not available for this sign-in."),
    (refusalNote || "").slice(0, 90));
  check("#110: the section's acts stand disabled — nothing invites a click that cannot work",
    await side.isDisabled("#account-passkey-add") &&
      await side.isDisabled("#account-passkey-nickname") &&
      await side.isDisabled("#account-password-btn") &&
      await side.isDisabled("#account-signout-everywhere"),
    "");
  check("#110: the refusal never navigated to the sign-in page",
    !side.url().includes("/login"), side.url());
  await side.unroute("**/api/auth/**");
  // The blanket rule's sign is the navigation attempt: the
  // app sends the browser to /login, and the still-valid
  // session bounces it straight back, so the attempt — not
  // the resting URL — is what is counted.
  let loginNavigations = 0;
  const countLoginNavigation = (req) => {
    if (req.isNavigationRequest() && req.url() === BASE + "/login") loginNavigations += 1;
  };
  side.on("request", countLoginNavigation);
  await side.route("**/api/state", (route) => route.fulfill({
    status: 401, contentType: "application/json",
    body: JSON.stringify({ error: "Sign-in is required." }),
  }));
  await side.reload({ waitUntil: "domcontentloaded" });
  await side.waitForTimeout(2500);
  check("#110: a board-API 401 still sends the browser to the sign-in page",
    loginNavigations >= 1, "navigations " + loginNavigations);
  side.off("request", countLoginNavigation);
  await side.unroute("**/api/state");
  await side.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await side.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  check("#110: with the routes answering again the app stands back up",
    true, side.url());

  // Issue #114: no email address stands anywhere in the UI.
  // The state answer is shaped as a hosted, claimed
  // identity's — carrying the person's old address in
  // me.email, as the hosted copy's does — and the Account
  // page must still show none of it. (The API drill pins what
  // the answers themselves carry.)
  let servedName = NAME;
  await side.route("**/api/state", async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    if (data && data.me) {
      data.me.email = "drill-a@example.test";
      if (data.me.name) servedName = data.me.name;
    }
    await route.fulfill({ response: res, json: data });
  });
  await side.reload({ waitUntil: "domcontentloaded" });
  await side.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  await side.click("#settings-open");
  await side.click('[data-settings-page="settings-account"]');
  await side.waitForSelector("#account-name", { timeout: 10000 });
  check("#114: the Account page has no email element left",
    (await side.locator("#account-email").count()) === 0 &&
      (await side.locator("#account-email-wrap").count()) === 0, "");
  const signedInLine = await side.locator("#settings-account p").first().textContent();
  check("#114: the signed-in line is the name alone",
    (signedInLine || "").trim() === "Signed in as " + servedName + ".",
    (signedInLine || "").slice(0, 60));
  const accountText = await side.locator("#settings-account").innerText();
  check("#114: no address stands anywhere on the Account page",
    !accountText.includes("drill-a@example.test") && !accountText.includes("@"),
    accountText.replace(/\s+/g, " ").slice(0, 90));
  await side.unroute("**/api/state");

  // The claim view names a set by its boards, its card count
  // and its last change — never the address it stands under.
  // The people answer is shaped with one unclaimed set (the
  // API drill pins the real payload); the rendering is the
  // page's own.
  await side.route("**/api/auth/people", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      me: { name: NAME, admin: true },
      people: [{ key: "drill a", name: NAME, admin: true, you: true,
        hasPassword: true, linked: true, passkeys: [] },
        { key: "drill passkey", name: "Drill Passkey", admin: false, you: false,
          hasPassword: false, linked: true,
          passkeys: [{ id: "cred-stub-1", nickname: "Stub device",
            createdAt: 1761000000000, rpHome: "" }] }],
      unclaimed: [{ ownerId: "owner_fixture", boards: ["Personal", "Professional"],
        cardCount: 7, lastChangeAt: 1761000000000 }],
      audit: [{ at: 1761000100000, actor: NAME, act: "claim", target: NAME,
        detail: "Personal, Professional" }],
    }),
  }));
  await side.reload({ waitUntil: "domcontentloaded" });
  await side.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  await side.click("#settings-open");
  await side.click('[data-settings-page="settings-people"]');
  await side.waitForSelector("#people-unclaimed .board-manage-row", { timeout: 10000 }).catch(() => {});
  const peopleText = await side.locator("#settings-people").innerText();
  check("#114: the claim view names the set by its boards, count and last change",
    peopleText.includes("Personal, Professional") && peopleText.includes("7 cards") &&
      peopleText.includes("last changed"), peopleText.replace(/\s+/g, " ").slice(0, 120));
  check("#114: no address stands anywhere on the Admin page",
    !peopleText.includes("@"), peopleText.replace(/\s+/g, " ").slice(0, 120));
  check("#122: the Admin page names a passwordless account's state in the open — Passkey only",
    peopleText.includes("Passkey only"), peopleText.replace(/\s+/g, " ").slice(0, 160));
  await side.screenshot({ path: join(OUT, "admin-1280.png") });
  await side.setViewportSize({ width: 390, height: 844 });
  await side.screenshot({ path: join(OUT, "admin-390.png") });
  await side.setViewportSize({ width: 1280, height: 900 });
  await side.unroute("**/api/auth/people");
  await side.reload({ waitUntil: "domcontentloaded" });
  await side.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });

  // Issue #112: the remembered name. The sign-in above stood
  // the cookie (the box starts ticked), so the sign-in page
  // pre-picks the name; unticking clears the cookie at once,
  // and the visit after an unticked sign-in pre-picks
  // nothing.
  await side.goto(BASE + "/logout", { waitUntil: "domcontentloaded" });
  await side.waitForURL(/\/login/, { timeout: 10000 }).catch(() => {});
  check("#112: the sign-in page pre-picks the remembered name",
    await side.isChecked('input[name="name"][value="' + NAME + '"]'), side.url());
  await side.screenshot({ path: join(OUT, "login-remember-1280.png") });
  // The phone-width frame: a page in an existing context
  // keeps that context's width, so the frame gets its own
  // context carrying this context's cookies.
  const phoneCtx = await browser.newContext({
    viewport: { width: 390, height: 844 }, serviceWorkers: "block",
  });
  await phoneCtx.addCookies(await ctx.cookies(BASE));
  const sidePhone = await phoneCtx.newPage();
  await sidePhone.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await sidePhone.waitForTimeout(400);
  await sidePhone.screenshot({ path: join(OUT, "login-remember-390.png") });
  await phoneCtx.close();
  await side.uncheck("#remember-name");
  const cookieAfterUntick = await side.evaluate(() => document.cookie);
  check("#112: unticking the box clears the remembered name at once",
    !cookieAfterUntick.includes("ts_name="), cookieAfterUntick.slice(0, 60));
  await showPasswordView(side);
  await side.fill('input[name="password"]', PASSWORD);
  await side.click('button[type="submit"]');
  await side.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  await side.goto(BASE + "/logout", { waitUntil: "domcontentloaded" });
  await side.waitForURL(/\/login/, { timeout: 10000 }).catch(() => {});
  check("#112: after an unticked sign-in the page pre-picks nothing",
    (await side.locator('input[name="name"]:checked').count()) === 0, side.url());
  await ctx.close();
}

// --- The plain-HTTP address: passkeys are not offered there (issue #113) -----------
// The same instance under a home-style name — drill-home.local,
// which the browser's resolver rule maps to this machine — is
// an ordinary HTTP address: not a secure context, so no
// passkey ceremony can run there. The walk proves the pages
// say so instead of offering dead acts: the sign-in page
// carries the line and no passkey button; the password door
// works; a passkey made at the secure address still lists on
// the Account page there and can be removed (a plain call,
// not a ceremony); and the add act is not offered — the line
// stands in its place. Under the full harness the API drill
// has already enrolled its own passkeys on this account, and
// this browser's device holds none of their keys, so it could
// never answer the passkey step-up they bring on: the walk
// removes those through their own route (the hosted walk
// below does the same), enrols a proof passkey of its own
// first, and the named enrolment then answers the step-up
// with that device passkey — and since issue #132 the
// enrolment behind the tap completes on the same device:
// the enrolment options no longer name the standing
// credential as one to exclude, so the browser no longer
// refuses the ceremony outright.
{
  const basePort = new URL(BASE).port;
  const INSECURE = "http://drill-home.local" + (basePort ? ":" + basePort : "");
  const ictx = await browser.newContext({
    viewport: { width: 1280, height: 900 }, serviceWorkers: "block",
  });
  const ipage = await ictx.newPage();
  const icdp = await ictx.newCDPSession(ipage);
  await icdp.send("WebAuthn.enable");
  const iauth = await icdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await ipage.goto(INSECURE + "/login", { waitUntil: "domcontentloaded" });
  check("#113: the home-style address is not a secure context",
    (await ipage.evaluate(() => window.isSecureContext)) === false, ipage.url());
  check("#113: the sign-in page offers no passkey button at an HTTP address",
    (await ipage.locator("#passkey-button").count()) === 0, "");
  const offLine = await ipage.locator("#passkey-off-note").innerText().catch(() => "");
  check("#122: at an HTTP address the settled line stands under the form, with the HTTPS link",
    offLine.includes("This site is not encrypted. A password typed here can be read on this network.") &&
      offLine.includes("How to give this site HTTPS") &&
      (await ipage.locator("#view-switch").count()) === 0,
    offLine.slice(0, 110));
  await ipage.screenshot({ path: join(OUT, "login-http-1280.png") });
  // The password door works at the same address.
  await ipage.check('input[name="name"][value="' + NAME + '"]');
  await ipage.fill('input[name="password"]', PASSWORD);
  await ipage.click('button[type="submit"]');
  await ipage.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  check("#113: the password signs in at the HTTP address", true, ipage.url());
  // Issue #124 at the same door: the renamed surface
  // behaves identically where passkeys cannot run — the
  // administrator's list carries the Admin entry, standing
  // last, and the Admin page opens and renders there.
  await ipage.click("#settings-open");
  await ipage.waitForSelector("#settings-people-btn:not([hidden])", { timeout: 10000 }).catch(() => {});
  const httpSettings = await ipage.evaluate(() => {
    const btn = document.getElementById("settings-people-btn");
    const visible = Array.from(document.querySelectorAll("#settings-list .settings-list-btn"))
      .filter((b) => !b.hidden)
      .map((b) => (b.querySelector("span") || {}).textContent || "");
    return { btnShown: !!btn && !btn.hidden, visible };
  });
  check("#124: at the HTTP address the administrator's list carries the Admin entry, standing last",
    httpSettings.btnShown && httpSettings.visible[httpSettings.visible.length - 1] === "Admin",
    httpSettings.visible.join(" / "));
  await ipage.screenshot({ path: join(OUT, "settings-list-admin-http-1280.png") });
  await ipage.click("#settings-people-btn");
  await ipage.waitForSelector("#people-list .board-manage-row", { timeout: 10000 }).catch(() => {});
  const httpAdmin = await ipage.evaluate(() => ({
    rows: (document.getElementById("people-list") || {}).innerText || "",
    inviteStands: !!document.getElementById("people-invite-btn"),
  }));
  check("#124: the Admin page opens and renders at the HTTP address — roster and invite act stand",
    httpAdmin.rows.includes(NAME) && httpAdmin.inviteStands,
    httpAdmin.rows.replace(/\s+/g, " ").slice(0, 90));
  await ipage.click("#settings-close").catch(() => {});
  // And with the people read refused at the same door, the
  // entry never stands — the non-administrator's list,
  // exactly as at the secure address.
  {
    const hctx = await browser.newContext({
      viewport: { width: 1280, height: 900 }, serviceWorkers: "block",
    });
    const hpage = await hctx.newPage();
    await hpage.goto(INSECURE + "/login", { waitUntil: "domcontentloaded" });
    await hpage.check('input[name="name"][value="' + NAME + '"]');
    await hpage.fill('input[name="password"]', PASSWORD);
    await hpage.click('button[type="submit"]');
    await hpage.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
    await hpage.route("**/api/auth/people", (route) => route.fulfill({
      status: 403, contentType: "application/json",
      body: JSON.stringify({ error: "Administrators only." }),
    }));
    const httpRead = hpage.waitForRequest(
      (req) => req.url().includes("/api/auth/people"), { timeout: 10000 }).catch(() => null);
    await hpage.reload({ waitUntil: "domcontentloaded" });
    await hpage.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
    await hpage.click("#settings-open");
    await httpRead;
    const httpNonAdmin = await hpage.evaluate(() => {
      const btn = document.getElementById("settings-people-btn");
      const visible = Array.from(document.querySelectorAll("#settings-list .settings-list-btn"))
        .filter((b) => !b.hidden)
        .map((b) => (b.querySelector("span") || {}).textContent || "");
      return { btnHidden: !btn || btn.hidden, visible };
    });
    check("#124: at the HTTP address a non-administrator's list carries no Admin entry",
      httpNonAdmin.btnHidden && !httpNonAdmin.visible.includes("Admin"),
      httpNonAdmin.visible.join(" / "));
    check("#125: at the HTTP address the Admin entry is not rendered for a non-administrator",
      !(await hpage.locator("#settings-people-btn").isVisible()), "");
    await hctx.close();
  }
  // Make a passkey at the secure address — the same account,
  // this context's other origin — so the Account page at the
  // HTTP address has one standing in its list.
  await ipage.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await ipage.check('input[name="name"][value="' + NAME + '"]');
  await showPasswordView(ipage);
  await ipage.fill('input[name="password"]', PASSWORD);
  await ipage.click('button[type="submit"]');
  await ipage.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  // Passkeys another drill enrolled on this account (the
  // full harness runs the API drill first) stand between
  // this walk and a first enrolment, and this device holds
  // none of their keys: remove them through their own
  // route, as the hosted walk below does, so the enrolments
  // here are this device's own from the first one on.
  await ipage.evaluate(async () => {
    const meRes = await fetch("/api/auth/me");
    const me = await meRes.json().catch(() => null);
    for (const pk of (me && me.passkeys) || []) {
      await fetch("/api/auth/passkeys/" + encodeURIComponent(pk.id),
        { method: "DELETE" });
    }
  });
  await ipage.click("#settings-open");
  await ipage.click('[data-settings-page="settings-account"]');
  await ipage.waitForSelector("#account-passkey-add", { timeout: 10000 });
  // One enrolment through the Account page's own acts. A
  // fresh proof may be asked first: the panel opens, the
  // named proof answers it, and the act runs again on its
  // own. Returns whether the panel asked, and how.
  const enrolAtSecure = async (nickname, proof) => {
    await ipage.fill("#account-passkey-nickname", nickname);
    await ipage.click("#account-passkey-add");
    const panelOpened = await ipage.waitForSelector(
      "#account-proof-panel:not([hidden])", { timeout: 6000 })
      .then(() => true).catch(() => false);
    let askedFor = "";
    if (panelOpened) {
      askedFor = await ipage.locator("#account-proof-password-btn").isVisible()
        .catch(() => false) ? "password" : "passkey";
      if (proof === "passkey") {
        await ipage.click("#account-proof-passkey-btn");
      } else if (proof === "password") {
        await ipage.fill("#account-proof-password", PASSWORD);
        await ipage.click("#account-proof-password-btn");
      }
    }
    await ipage.waitForFunction(
      (name) => (document.getElementById("account-passkeys-list") || { textContent: "" })
        .textContent.includes(name), nickname, { timeout: 15000 }).catch(() => {});
    return askedFor;
  };
  // The walk's own proof passkey first, against the fresh
  // proof the password sign-in itself gave (or the panel's
  // password proof, if the server asks).
  await enrolAtSecure("HTTP walk proof key", "password");
  // The named passkey: a passkey now stands, so the rules
  // ask for a passkey proof — the panel hides its password
  // button — and this device's own passkey answers it. The
  // proof is what the tap proves: the session's proof reads
  // "passkey" once the tap lands. And the enrolment behind
  // the tap completes on this same device (issue #132):
  // before that fix the ceremony was refused by the
  // authenticator itself, because the enrolment options
  // named the standing credential as one to exclude, and
  // the named passkey never stood.
  await ipage.fill("#account-passkey-nickname", "HTTP walk passkey");
  await ipage.click("#account-passkey-add");
  const panelOpened = await ipage.waitForSelector(
    "#account-proof-panel:not([hidden])", { timeout: 10000 })
    .then(() => true).catch(() => false);
  const askedFor = panelOpened &&
    !(await ipage.locator("#account-proof-password-btn").isVisible()
      .catch(() => false)) ? "passkey" : "";
  if (panelOpened) await ipage.click("#account-proof-passkey-btn");
  let proofVia = null;
  for (let i = 0; i < 30 && proofVia !== "passkey"; i++) {
    proofVia = await ipage.evaluate(async () => {
      const r = await fetch("/api/auth/me");
      const me = await r.json().catch(() => null);
      return me && me.proofVia;
    }).catch(() => null);
    if (proofVia !== "passkey") await ipage.waitForTimeout(500);
  }
  check("#113: adding a further passkey asks for a passkey proof, answered by the device's own",
    askedFor === "passkey" && proofVia === "passkey",
    "asked for " + (askedFor || "nothing") + ", proof via " + proofVia);
  await ipage.waitForFunction(
    () => (document.getElementById("account-passkeys-list") || { textContent: "" })
      .textContent.includes("HTTP walk passkey"), undefined, { timeout: 15000 }).catch(() => {});
  const secureList = await ipage.locator("#account-passkeys-list").innerText();
  check("#113: the passkey enrols at the secure address",
    secureList.includes("HTTP walk passkey"), secureList.slice(0, 80));
  // Back at the HTTP address — that origin's session still
  // stands — the Account page: the passkey lists, the add act
  // is not offered, and the line stands in its place.
  await ipage.goto(INSECURE + "/", { waitUntil: "domcontentloaded" });
  await ipage.waitForSelector("#board-ui:not([hidden])", { timeout: 15000 });
  await ipage.click("#settings-open");
  await ipage.click('[data-settings-page="settings-account"]');
  await ipage.waitForSelector("#account-passkeys-list", { timeout: 10000 });
  await ipage.waitForFunction(
    () => (document.getElementById("account-passkeys-list") || { textContent: "" })
      .textContent.includes("HTTP walk passkey"), undefined, { timeout: 10000 }).catch(() => {});
  const httpList = await ipage.locator("#account-passkeys-list").innerText();
  check("#113: the passkey still lists at the HTTP address",
    httpList.includes("HTTP walk passkey"), httpList.slice(0, 80));
  check("#113: the add act is not offered at the HTTP address",
    !(await ipage.locator("#account-passkey-add").isVisible().catch(() => false)) &&
      !(await ipage.locator("#account-passkey-nickname").isVisible().catch(() => false)), "");
  const acctOff = await ipage.locator("#account-passkey-off").innerText().catch(() => "");
  check("#113: the line stands in the add act's place on the Account page",
    acctOff.includes("Passkeys need a secure address (HTTPS)") &&
      acctOff.includes("Your password works as usual."), acctOff.slice(0, 90));
  await ipage.screenshot({ path: join(OUT, "account-http-1280.png") });
  // Removal asks first now (issue #136) — the walk
  // confirms in the dialog — and the removal itself is a
  // plain call, not a ceremony: it still works at this
  // address. The walk removes its own named passkey by its
  // row — the proof key stands beside it, so the list is
  // not expected to empty; the check is that the named
  // passkey is gone from it.
  await ipage.locator("#account-passkeys-list .board-manage-row",
    { hasText: "HTTP walk passkey" })
    .locator("button", { hasText: "Remove" }).click();
  await ipage.waitForSelector("#own-passkey-remove-backdrop:not([hidden])",
    { timeout: 10000 });
  await ipage.click("#own-passkey-remove-confirm");
  await ipage.waitForFunction(
    () => !(document.getElementById("account-passkeys-list") || { textContent: "" })
      .textContent.includes("HTTP walk passkey"), undefined, { timeout: 10000 }).catch(() => {});
  const afterRemove = await ipage.locator("#account-passkeys-list").innerText();
  check("#113: the passkey can still be removed at the HTTP address",
    !afterRemove.includes("HTTP walk passkey"), afterRemove.slice(0, 80));
  await ictx.close();
  // The phone-width frame of the gated sign-in page gets its
  // own context — a page in an existing context keeps that
  // context's width.
  const ictxPhone = await browser.newContext({
    viewport: { width: 390, height: 844 }, serviceWorkers: "block",
  });
  const ipagePhone = await ictxPhone.newPage();
  await ipagePhone.goto(INSECURE + "/login", { waitUntil: "domcontentloaded" });
  const phoneLine = await ipagePhone.locator("#passkey-off-note").innerText().catch(() => "");
  check("#122: at phone width the settled line stands, with its link, and no switch",
    (await ipagePhone.locator("#passkey-button").count()) === 0 &&
      (await ipagePhone.locator("#view-switch").count()) === 0 &&
      phoneLine.includes("This site is not encrypted. A password typed here can be read on this network.") &&
      phoneLine.includes("How to give this site HTTPS"), phoneLine.slice(0, 60));
  await ipagePhone.screenshot({ path: join(OUT, "login-http-390.png") });
  await ictxPhone.close();
}

// --- Removing the other person, so the erasure below can run (issue #107) -----------
// This sign-in is the instance's only administrator, and the
// guard refuses the only administrator's self-erasure while
// other accounts stand — so first the administrator removes
// Drill B from the Admin page, behind its dialog. That also
// leaves this account the last one standing, which is what
// lets the walk below proceed.
await phone.click("#settings-open");
await phone.waitForSelector("#settings-people-btn:not([hidden])", { timeout: 10000 })
  .catch(() => {});
await phone.click("#settings-people-btn");
await phone.waitForSelector("#people-list .board-manage-row", { timeout: 10000 });
const peopleRowsText = await phone.locator("#people-list").innerText();
check("#107: the Admin page lists both accounts for the administrator",
  peopleRowsText.includes("Drill A") && peopleRowsText.includes("Drill B"),
  peopleRowsText.replace(/\s+/g, " ").slice(0, 90));
check("#109: each row shows the account's posture — password set, passkeys held",
  peopleRowsText.includes("password set") && peopleRowsText.includes("no passkey"),
  peopleRowsText.replace(/\s+/g, " ").slice(0, 120));
const rowB = phone.locator("#people-list .board-manage-row", { hasText: "Drill B" });
await rowB.locator("button.btn-danger").click();
await phone.waitForSelector("#person-delete-backdrop:not([hidden])", { timeout: 10000 });
await phone.click("#person-delete-confirm");
await phone.waitForFunction(
  () => !(document.getElementById("people-list") || { innerText: "" }).innerText.includes("Drill B"),
  undefined, { timeout: 10000 }).catch(() => {});
const rowsAfterRemove = await phone.locator("#people-list").innerText();
check("#107: removing a person on the Admin page takes them off the list",
  !rowsAfterRemove.includes("Drill B") && rowsAfterRemove.includes("Drill A"),
  rowsAfterRemove.replace(/\s+/g, " ").slice(0, 90));
// The API drill leaves further accounts standing on this
// shared harness instance (the claim family's Drill C, the
// hash family's scratch account). Remove every row that is
// not the administrator's own: the account-deletion walk
// below needs one account standing, because the only
// administrator cannot erase their own account while other
// accounts stand.
for (let round = 0; round < 6; round++) {
  // Person rows are the ones carrying the danger Remove;
  // passkey sub-rows share the row class but hold a quiet
  // "Remove passkey" instead.
  const rows = await phone.locator("#people-list .board-manage-row",
    { has: phone.locator("button.btn-danger") }).all();
  let other = null;
  for (const row of rows) {
    const text = await row.innerText();
    if (!text.includes("(you)")) { other = row; break; }
  }
  if (!other) break;
  await other.locator("button.btn-danger").click();
  await phone.waitForSelector("#person-delete-backdrop:not([hidden])", { timeout: 10000 });
  await phone.click("#person-delete-confirm");
  await phone.waitForTimeout(600);
}
const rowsAlone = await phone.locator("#people-list").innerText();
check("#109: the administrator stands alone before the deletion walk",
  rowsAlone.includes("Drill A") && !rowsAlone.includes("Scratch") &&
    !rowsAlone.includes("Drill C"),
  rowsAlone.replace(/\s+/g, " ").slice(0, 90));
await phone.click("#settings-close").catch(() => {});

// --- Deleting the account, for real (issue #57) -------------------------------------
// The last walk of the run: the person deletes their own
// boards and account from the account page, at phone width.
// The act lands them on the sign-in page, and the key minted
// earlier in this run is dead — the erasure took it with
// everything else.
await phone.click("#settings-open");
await phone.click('[data-settings-page="settings-account"]');
await phone.waitForSelector("#account-delete-btn", { timeout: 10000 });
await phone.click("#account-delete-btn");
await phone.waitForSelector("#account-delete-backdrop:not([hidden])", { timeout: 10000 });
await phone.screenshot({ path: join(OUT, "account-delete-390.png") });
await phone.fill("#account-delete-type", "DELETE");
await phone.click("#account-delete-confirm-btn");
await phone.waitForURL(/\/login/, { timeout: 15000 });
check("#57: deleting the account lands on the sign-in page",
  phone.url().includes("/login"), phone.url());
const deadKeyRes = await fetch(BASE + "/api/v1/state", {
  headers: { Authorization: "Bearer " + mintedKey },
});
check("#57: the key minted in this run is dead after the erasure",
  deadKeyRes.status === 401, "status " + deadKeyRes.status);

// --- The hosted sign-in page in a browser (issue #112) ------------------------------
// Only with --hosted-base (the Worker rig, whose drill
// accounts the API drill made): the typed-name page. A CDP
// virtual authenticator stands in for a device passkey. The
// walk: the conditional offer starts as the page loads and a
// password sign-in is undisturbed by it; a passkey enrols in
// the app and then signs in from the page's own button; the
// remembered name fills the field and clears on untick.
if (HOSTED) {
  const hctx = await browser.newContext({
    viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true,
  });
  const hpage = await hctx.newPage();
  const cdp = await hctx.newCDPSession(hpage);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  let optionsCalls = 0;
  hpage.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/login/passkey/options")) {
      optionsCalls += 1;
    }
  });
  await hpage.goto(HOSTED + "/login", { waitUntil: "domcontentloaded" });
  check("#112 hosted: the typed field carries the webauthn autofill word",
    (await hpage.getAttribute("#login-name", "autocomplete")) === "username webauthn",
    await hpage.getAttribute("#login-name", "autocomplete"));
  check("#112 hosted: the remember box stands ticked",
    await hpage.isChecked("#remember-name"), "");
  check("#122 hosted: a fresh device opens on the passkey view — the button stands, the password field waits behind the switch",
    (await hpage.locator("#passkey-button").isVisible()) &&
      (await hpage.locator('input[name="password"]').isHidden()) &&
      (await hpage.locator("#view-switch").innerText()).includes("Use a password instead"),
    "");
  // The conditional offer starts on its own: an options call
  // with no click anywhere is its footprint.
  for (let i = 0; i < 16 && optionsCalls === 0; i++) {
    await hpage.waitForTimeout(500);
  }
  const mediation = await hpage.evaluate(() =>
    window.PublicKeyCredential && window.PublicKeyCredential.isConditionalMediationAvailable
      ? window.PublicKeyCredential.isConditionalMediationAvailable()
      : Promise.resolve(false)).catch(() => false);
  check("#112 hosted: the conditional passkey offer starts as the page loads",
    optionsCalls >= 1, "options calls " + optionsCalls + " mediation " + mediation);
  // The password door, with the offer standing: fill and
  // submit — the offer disturbed nothing and printed
  // nothing. The rig serves no front end (the Worker answers
  // the root with its API note; in a real deployment the
  // static site serves the app there), so a landed sign-in
  // is proven by the session itself: /api/auth/me names the
  // account on the far side of the redirect.
  const meAfterPassword = async () => hpage.evaluate(async () => {
    const res = await fetch("/api/auth/me");
    return { status: res.status, body: await res.json().catch(() => null) };
  });
  await hpage.fill("#login-name", HOSTED_NAME);
  await showPasswordView(hpage);
  await hpage.fill('input[name="password"]', HOSTED_PASSWORD);
  await hpage.click('button[type="submit"]');
  await hpage.waitForURL(HOSTED + "/", { timeout: 15000 }).catch(() => {});
  const landed = await meAfterPassword();
  check("#112 hosted: a password sign-in lands with the conditional offer standing",
    landed.status === 200 && !!landed.body && landed.body.name === HOSTED_NAME,
    "status " + landed.status + " url " + hpage.url());
  // Enrol the drill device's passkey, behind the fresh proof
  // the sign-in itself gave. The rig has no front end, so
  // the ceremony runs from this page through the Account
  // page's own calls — the same options, the browser's own
  // create, the same answer posted back. The API drill's
  // software authenticators already stand on this account;
  // remove them through their own route first, so this is a
  // first passkey — a further one would ask for a passkey
  // proof the drill's device cannot give for credentials it
  // does not hold.
  const enrolResult = await hpage.evaluate(async (nickname) => {
    const b64uToBytes = (text) => {
      const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      const bin = atob(padded);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    };
    const bytesToB64u = (buf) => {
      const view = new Uint8Array(buf);
      let bin = "";
      for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const call = async (method, path, body) => {
      const res = await fetch(path, {
        method,
        headers: body != null ? { "Content-Type": "application/json" } : {},
        body: body != null ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const me = await call("GET", "/api/auth/me");
    for (const pk of (me.json && me.json.passkeys) || []) {
      await call("DELETE", "/api/auth/passkeys/" + encodeURIComponent(pk.id));
    }
    const opts = await call("POST", "/api/auth/passkeys/options", {});
    if (opts.status !== 200) return { step: "options", status: opts.status };
    const o = opts.json;
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: b64uToBytes(o.challenge),
      rp: o.rp,
      user: { id: b64uToBytes(o.user.id), name: o.user.name, displayName: o.user.displayName },
      pubKeyCredParams: o.pubKeyCredParams,
      authenticatorSelection: o.authenticatorSelection,
      attestation: "none",
      timeout: o.timeout,
      excludeCredentials: (o.excludeCredentials || []).map((c) => ({ id: b64uToBytes(c.id), type: c.type })),
    } });
    const created = await call("POST", "/api/auth/passkeys", {
      response: {
        id: bytesToB64u(cred.rawId), type: cred.type,
        response: {
          clientDataJSON: bytesToB64u(cred.response.clientDataJSON),
          attestationObject: bytesToB64u(cred.response.attestationObject),
          transports: cred.response.getTransports ? cred.response.getTransports() : [],
        },
      },
      nickname,
    });
    if (created.status !== 201) return { step: "create", status: created.status };
    const after = await call("GET", "/api/auth/me");
    return {
      step: "done", status: created.status,
      names: ((after.json && after.json.passkeys) || []).map((p) => p.nickname),
    };
  }, "Hosted drill passkey");
  check("#112 hosted: the passkey enrols against the fresh proof",
    enrolResult.step === "done" && enrolResult.names.includes("Hosted drill passkey"),
    JSON.stringify(enrolResult).slice(0, 120));
  // Sign out: the page now remembers the name (the password
  // sign-in stood the cookie), and the button signs in. The
  // device now holds a passkey, so this visit's conditional
  // offer could complete on its own given time — the walk
  // holds the offer's first call back briefly (a network
  // delay on the options route), so the button's own
  // ceremony is the one that runs: the click stands the
  // offer down before its ceremony ever begins.
  await hpage.route("**/login/passkey/options", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await hpage.goto(HOSTED + "/logout", { waitUntil: "domcontentloaded" });
  await hpage.waitForURL(/\/login/, { timeout: 10000 }).catch(() => {});
  check("#112 hosted: the remembered name fills the field on the next visit",
    (await hpage.inputValue("#login-name")) === HOSTED_NAME,
    await hpage.inputValue("#login-name"));
  check("#122 hosted: the device remembered the password view from the earlier sign-in",
    (await hpage.locator('input[name="password"]').isVisible()) &&
      (await hpage.locator("#view-switch").innerText()).includes("Use a passkey instead"),
    "");
  await hpage.screenshot({ path: join(OUT, "login-hosted-1280.png") });
  await hpage.click("#view-switch");
  await hpage.locator("#passkey-button").waitFor({ state: "visible", timeout: 5000 });
  await hpage.click("#passkey-button");
  await hpage.waitForURL(HOSTED + "/", { timeout: 15000 }).catch(() => {});
  const tapLanded = await meAfterPassword();
  check("#112 hosted: the page's own passkey button signs in",
    tapLanded.status === 200 && !!tapLanded.body && tapLanded.body.proofVia === "passkey",
    "status " + tapLanded.status + " via " + (tapLanded.body && tapLanded.body.proofVia));
  await hpage.unroute("**/login/passkey/options");
  // The phone-width frame of the same page, in a throwaway
  // context carrying only the remembered-name cookie: it
  // holds no authenticator, so no offer can disturb the
  // portrait.
  {
    const jar = await hctx.cookies(HOSTED + "/login");
    const nameCookie = jar.find((c) => c.name === "ts_name");
    const pctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true,
    });
    if (nameCookie) await pctx.addCookies([nameCookie]);
    const portrait = await pctx.newPage();
    await portrait.goto(HOSTED + "/login", { waitUntil: "domcontentloaded" });
    await portrait.waitForTimeout(600);
    await portrait.screenshot({ path: join(OUT, "login-hosted-390.png") });
    await pctx.close();
  }
  // Untick, and the memory goes: at once on the page, and
  // for the next visit after an unticked sign-in. The offer
  // is held back across this walk the same way — the device
  // holds the passkey, and an offer completing mid-walk
  // would sign the page in out from under the form.
  await hpage.route("**/login/passkey/options", async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    await route.continue();
  });
  await hpage.goto(HOSTED + "/logout", { waitUntil: "domcontentloaded" });
  await hpage.waitForURL(/\/login/, { timeout: 10000 }).catch(() => {});
  await hpage.uncheck("#remember-name");
  const hostedCookie = await hpage.evaluate(() => document.cookie);
  check("#112 hosted: unticking clears the remembered name at once",
    !hostedCookie.includes("ts_name="), hostedCookie.slice(0, 60));
  await showPasswordView(hpage);
  await hpage.fill('input[name="password"]', HOSTED_PASSWORD);
  await hpage.click('button[type="submit"]');
  await hpage.waitForURL(HOSTED + "/", { timeout: 15000 }).catch(() => {});
  await hpage.goto(HOSTED + "/logout", { waitUntil: "domcontentloaded" });
  await hpage.waitForURL(/\/login/, { timeout: 10000 }).catch(() => {});
  // The durable fact is the store, not the live field: the
  // device holds a passkey, so this visit's own offer may
  // fill the field from the authenticator (and sign in) at
  // any moment — that is the offer working, not a memory.
  // What the unticked sign-in had to leave behind is no
  // cookie in the jar and a page served with an empty field.
  const jarAfter = await hctx.cookies(HOSTED + "/login");
  // The served value: the field's tag, and its value word
  // when it carries one — an empty field is served with no
  // value word at all, which reads as "" here; null means
  // the field itself was not in the page.
  const servedFillOf = (html) => {
    const tag = /<input[^>]*id="login-name"[^>]*>/.exec(html);
    if (!tag) return null;
    const value = /value="([^"]*)"/.exec(tag[0]);
    return value ? value[1] : "";
  };
  let servedFill = servedFillOf(await hpage.evaluate(async () => {
    const res = await fetch("/login");
    return await res.text();
  }).catch(() => ""));
  if (servedFill === null) {
    // The offer may have signed the page in mid-fetch; the
    // served page is the same read from the far side.
    await hpage.waitForTimeout(800);
    servedFill = servedFillOf(await hpage.evaluate(async () => {
      const res = await fetch("/login");
      return await res.text();
    }).catch(() => ""));
  }
  check("#112 hosted: after an unticked sign-in the name stands nowhere — no cookie, and the page is served empty",
    !jarAfter.some((c) => c.name === "ts_name") && servedFill === "",
    "cookie " + jarAfter.some((c) => c.name === "ts_name")
      + " served value " + JSON.stringify(servedFill));
  await hpage.unroute("**/login/passkey/options");
  await hctx.close();
}

await browser.close();
console.log(count + " checks, " + failures + " failures");
process.exit(failures === 0 ? 0 : 1);
