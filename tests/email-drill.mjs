// TaskSparkle email drill: sign-in and joining by an emailed
// link, on the hosted shape.
//
//     node tests/email-drill.mjs --mode worker \
//         --base https://localhost:8792 \
//         --setup-code rig-setup-code --rig-dir <the rig folder>
//
// Worker mode only: the flow lives on the hosted copy, so the
// drill runs against a FRESH Worker rig (tests/README.md, the
// rig run book), where the country gate stands at Canada and
// the United States, the bot check is answered by the rig's
// own stub verifier, and the mail path points at this drill's
// capture server (tests/rig/mail-capture.mjs) — the rig's
// stand-in for the shared mail service, close enough to read
// a sent link out of the message and spend it. The drill makes
// the first account itself, through the setup page, and flips
// the joining switch the operator's way: a stored value in
// the rig's local auth database, written with wrangler.
//
// What the drill proves:
//
// - the hosted sign-in page is the page as designed: the
//   email field and the link button, the passkey button, and
//   no password field and no name field anywhere on it.
// - at invite-only (the switch's default), a new address's
//   ask is answered with the check-your-inbox page and NO
//   message is sent, while an address holding an account is
//   sent its link and signs in by spending it — signing in is
//   never gated, and recovery is that same spend.
// - open, a new person's whole journey: ask, read the link
//   out of the captured message, land on the joining page
//   (name field, the Terms tick unticked, the bot check's
//   widget), be refused without the tick and without the
//   bot check's token — the link unspent both times — then
//   join, land on the passkey offer, enrol a passkey there,
//   sign out, and come back with the one tap alone.
// - a returning person by link: spending it signs out their
//   other sign-ins; a link spent twice is refused the second
//   time; an expired link is refused.
// - the switch and the gate judged at the spend: a link
//   asked while open cannot join once the switch stands
//   closed (and the refused press leaves it unspent), and a
//   link asked from Canada cannot join from a refused
//   country — while the United States joins, and an account
//   signs in from anywhere.
// - names are display only for an email account: two people
//   can carry the same name, and a rename never re-keys.
// - the pace: five links in an hour to one address are sent;
//   the sixth ask is answered exactly the same and sends
//   nothing. And nothing leaks: the ask's answer is the same
//   redirect for a known address, an unknown one, and a
//   gated one.
// - the invite machinery stands untouched: an admin-minted
//   invite still makes its account the password way.
import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { encodeCBOR } from "../worker/auth.js";
import { startMailCapture, capturedMessages, clearCaptured } from "./rig/mail-capture.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
}
const BASE = args.base || "";
const SETUP_CODE = args["setup-code"] || "";
const RIG_DIR = args["rig-dir"] || "";
if (!BASE || !SETUP_CODE || !RIG_DIR) {
  console.error("usage: --base, --setup-code and --rig-dir are all required; see the header");
  process.exit(2);
}
const MAIL_PORT = 8795;
const PW = "email-drill-password";

let failures = 0;
let count = 0;
function check(name, cond, detail) {
  count += 1;
  if (!cond) failures += 1;
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail ? "  — " + detail : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- HTTP helpers (the door drill's raw shape) --------------

function raw(base, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const lib = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = lib(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: body != null
          ? { ...headers, "Content-Length": Buffer.byteLength(body) }
          : headers,
        rejectUnauthorized: false,
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(text); } catch (e) { /* plain-text answers exist */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

const sessionCookieOf = (res) => {
  const found = (res.headers["set-cookie"] || [])
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("ts_session=") && c.length > "ts_session=".length);
  return found || null;
};

function jar() {
  let cookie = null;
  return {
    absorb(res) {
      const found = sessionCookieOf(res);
      if (found) cookie = found;
      return cookie;
    },
    get cookie() { return cookie; },
    headers() { return cookie ? { Cookie: cookie } : {}; },
  };
}

const formPost = (base, path, fields, opts) => {
  opts = opts || {};
  return raw(base, "POST", path, {
    "Content-Type": "application/x-www-form-urlencoded",
    ...(opts.jar ? opts.jar.headers() : {}),
    ...(opts.headers || {}),
  }, new URLSearchParams(fields).toString());
};
const jsonPost = (base, path, body, opts) => {
  opts = opts || {};
  return raw(base, "POST", path, {
    "Content-Type": "application/json",
    ...(opts.jar ? opts.jar.headers() : {}),
    ...(opts.headers || {}),
  }, JSON.stringify(body || {}));
};
const jsonPatch = (base, path, body, opts) => {
  opts = opts || {};
  return raw(base, "PATCH", path, {
    "Content-Type": "application/json",
    ...(opts.jar ? opts.jar.headers() : {}),
    ...(opts.headers || {}),
  }, JSON.stringify(body || {}));
};
const getPage = (base, path, opts) => {
  opts = opts || {};
  return raw(base, "GET", path, {
    ...(opts.jar ? opts.jar.headers() : {}),
    ...(opts.headers || {}),
  }, null);
};

async function boardsStand(base, j) {
  const res = await raw(base, "GET", "/api/v1/state", j.headers(), null);
  return res.status === 200 && !!res.json && Array.isArray(res.json.boards) &&
    res.json.boards.some((b) => b.name === "Personal");
}

// --- The rig's auth database, the operator's way ------------

function rigSql(sql) {
  execFileSync("npx",
    ["--yes", "wrangler@4.153.0", "d1", "execute", "tasksparkle-rig-auth",
     "--local", "--command", sql],
    { cwd: RIG_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const flipDoorRig = (value) => rigSql(
  "INSERT INTO auth_meta (key, value) VALUES ('door', " + value + ") " +
  "ON CONFLICT(key) DO UPDATE SET value = excluded.value");

// --- The captured mail ---------------------------------------

async function messagesTo(email) {
  const all = await capturedMessages(MAIL_PORT);
  return all.filter((m) => m.body && m.body.to === email);
}

// The link a message carries, as the path a browser would
// open on this rig: the code out of the message's own text.
function linkPathOf(message) {
  if (!message || !message.body) return null;
  const text = (message.body.text || "") + " " + (message.body.html || "");
  const match = /\/link\/([A-Za-z0-9_-]+)/.exec(text);
  return match ? "/link/" + match[1] : null;
}

async function askForLink(email, opts) {
  return formPost(BASE, "/login/email", { email }, opts);
}

// --- A software authenticator (the API drill's shape) --------

const b64uDrill = (buf) => Buffer.from(buf).toString("base64url");
const b64uDrillToBuf = (text) => Buffer.from(text, "base64url");
function makeAuthenticator() {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const credId = randomBytes(16);
  let counter = 0;
  const cose = encodeCBOR(new Map([
    [1, 2], [3, -7], [-1, 1], [-2, b64uDrillToBuf(jwk.x)], [-3, b64uDrillToBuf(jwk.y)],
  ]));
  const url = new URL(BASE);
  const rpHash = createHash("sha256").update(url.hostname).digest();
  const clientData = (type, challenge) => Buffer.from(JSON.stringify({
    type, challenge, origin: url.origin, crossOrigin: false,
  }));
  function attestation(challenge) {
    counter += 1;
    const flags = 0x01 | 0x04 | 0x40;
    const countBuf = Buffer.alloc(4); countBuf.writeUInt32BE(counter);
    const lenBuf = Buffer.alloc(2); lenBuf.writeUInt16BE(credId.length);
    const authData = Buffer.concat([rpHash, Buffer.from([flags]), countBuf,
      Buffer.alloc(16), lenBuf, credId, cose]);
    const attObj = encodeCBOR(new Map([
      ["fmt", "none"], ["attStmt", new Map()], ["authData", authData],
    ]));
    return {
      id: b64uDrill(credId), type: "public-key",
      response: {
        clientDataJSON: b64uDrill(clientData("webauthn.create", challenge)),
        attestationObject: b64uDrill(attObj),
        transports: ["internal"],
      },
    };
  }
  function assertion(challenge, userHandle) {
    counter += 1;
    const flags = 0x01 | 0x04;
    const countBuf = Buffer.alloc(4); countBuf.writeUInt32BE(counter);
    const authData = Buffer.concat([rpHash, Buffer.from([flags]), countBuf]);
    const cd = clientData("webauthn.get", challenge);
    const signed = Buffer.concat([authData, createHash("sha256").update(cd).digest()]);
    const signer = createSign("SHA256");
    signer.update(signed);
    const signature = signer.sign({ key: pair.privateKey });
    return {
      id: b64uDrill(credId), type: "public-key",
      response: {
        clientDataJSON: b64uDrill(cd),
        authenticatorData: b64uDrill(authData),
        signature: b64uDrill(signature),
        userHandle: userHandle == null ? null : b64uDrill(userHandle),
      },
    };
  }
  return { credIdB64u: b64uDrill(credId), attestation, assertion };
}

// --- The walk -------------------------------------------------

const CA = { headers: { "CF-IPCountry": "CA" } };
const US = { headers: { "CF-IPCountry": "US" } };
const FR = { headers: { "CF-IPCountry": "FR" } };
const PASS = { "cf-turnstile-response": "pass-token" };

const capture = await startMailCapture(MAIL_PORT);
try {
  // The operator first, the setup page's own way.
  const admin = jar();
  admin.absorb(await formPost(BASE, "/setup",
    { name: "Email Admin", password: PW, confirm: PW, code: SETUP_CODE }));
  check("email: the setup page made the first account on the fresh rig",
    !!admin.cookie && (await boardsStand(BASE, admin)));
  // The operator step from the runbook, done the database
  // way here: the standing account gains its address.
  rigSql("UPDATE accounts SET email = 'operator@example.test' WHERE key = 'email admin'");

  // The hosted sign-in page, as designed.
  const login = await getPage(BASE, "/login");
  check("email: the sign-in page is the designed page — the email field, " +
      "the link button, the passkey button, and the settled words",
    login.status === 200 &&
      login.text.includes('name="email"') &&
      login.text.includes('id="login-name"') &&
      login.text.includes('autocomplete="username webauthn"') &&
      login.text.includes("Email me a link") &&
      login.text.includes("New here or coming back") &&
      login.text.includes("No password, ever.") &&
      login.text.includes("Been here on this device before?") &&
      login.text.includes("Sign in with a passkey") &&
      login.text.includes("One tap. Nothing to type.") &&
      login.text.includes("expires in 15 minutes"),
    "status " + login.status);
  check("email: and it carries no password field, no name field, " +
      "no remember box and no creation entry",
    !login.text.includes('<input type="password"') &&
      !login.text.includes('name="password"') &&
      !login.text.includes('name="name"') &&
      !login.text.includes("login-remember") &&
      !login.text.includes("/signup"),
    "status " + login.status);

  // Invite-only, the switch's default: a new address is sent
  // nothing, and the answer is the same page either way.
  const askNew = await askForLink("newperson@example.test", CA);
  check("email: at invite-only a new address's ask is answered with the sent page",
    askNew.status === 302 && (askNew.headers.location || "") === "/login/sent",
    "status " + askNew.status + " location " + askNew.headers.location);
  await sleep(150);
  check("email: and no message was sent to it",
    (await messagesTo("newperson@example.test")).length === 0);
  const sent = await getPage(BASE, "/login/sent");
  check("email: the check-your-inbox page stands in the settled words",
    sent.status === 200 && sent.text.includes("Check your inbox") &&
      sent.text.includes("expires in 15 minutes"),
    "status " + sent.status);

  // An address with an account is sent its link even at
  // invite-only, and spending it is the way back in.
  const askOp = await askForLink("operator@example.test", CA);
  check("email: the operator's ask is answered the same way",
    askOp.status === 302 && (askOp.headers.location || "") === "/login/sent");
  await sleep(150);
  const opMail = await messagesTo("operator@example.test");
  check("email: and its link was sent — one message, the sign-in kind, " +
      "from the rig's own sender",
    opMail.length === 1 && !!opMail[0].body &&
      opMail[0].body.kind === "sign-in-link" &&
      opMail[0].body.from === "noreply@rig.example.test" &&
      opMail[0].body.subject === "Your TaskSparkle sign-in link" &&
      !!linkPathOf(opMail[0]),
    "messages " + opMail.length);
  const opLink = linkPathOf(opMail[0]);
  const opLanding = await getPage(BASE, opLink);
  check("email: the link's landing names the account it signs in",
    opLanding.status === 200 &&
      opLanding.text.includes("This link signs in Email Admin."),
    "status " + opLanding.status);
  const opJar = jar();
  opJar.absorb(await formPost(BASE, opLink, {}));
  check("email: spending it signs the operator in, on their boards — " +
      "the recovery, the same act",
    !!opJar.cookie && (await boardsStand(BASE, opJar)));

  // Open: the new person's whole journey.
  flipDoorRig(1);
  await askForLink("newperson@example.test", CA);
  await sleep(150);
  const npMail = await messagesTo("newperson@example.test");
  check("email: open, the new address is sent its link",
    npMail.length === 1 && !!linkPathOf(npMail[0]),
    "messages " + npMail.length);
  const npLink = linkPathOf(npMail[0]);
  const joinPage = await getPage(BASE, npLink, CA);
  check("email: the joining page stands — a name field, the Terms tick " +
      "unticked, the boards line, the bot check's widget and its policy",
    joinPage.status === 200 &&
      joinPage.text.includes('name="name"') &&
      joinPage.text.includes('name="terms"') &&
      joinPage.text.includes("Make my boards") &&
      joinPage.text.includes("You get your own boards") &&
      joinPage.text.includes("cf-turnstile") &&
      joinPage.text.includes('data-sitekey="rig-site-key"') &&
      (joinPage.headers["content-security-policy"] || "").includes("challenges.cloudflare.com"),
    "status " + joinPage.status);
  const noTick = await formPost(BASE, npLink,
    { name: "New Person", ...PASS }, CA);
  check("email: a press without the Terms tick is refused back to the page",
    noTick.status === 302 &&
      (noTick.headers.location || "") === npLink + "?error=terms" &&
      !sessionCookieOf(noTick),
    "status " + noTick.status + " location " + noTick.headers.location);
  const noBot = await formPost(BASE, npLink,
    { name: "New Person", terms: "1" }, CA);
  check("email: a press without the bot check's token is refused the same way",
    noBot.status === 302 &&
      (noBot.headers.location || "") === npLink + "?error=bot",
    "status " + noBot.status + " location " + noBot.headers.location);
  const stillJoin = await getPage(BASE, npLink, CA);
  check("email: and both refused presses left the link unspent — " +
      "the joining page stands again, no account made",
    stillJoin.status === 200 && stillJoin.text.includes("Make my boards"),
    "status " + stillJoin.status);
  const npJar = jar();
  const joined = await formPost(BASE, npLink,
    { name: "New Person", terms: "1", ...PASS }, { ...CA, jar: npJar });
  npJar.absorb(joined);
  check("email: the full press joins — a session, the passkey offer next, " +
      "and boards standing",
    joined.status === 302 &&
      (joined.headers.location || "") === "/add-passkey" &&
      !!npJar.cookie && (await boardsStand(BASE, npJar)),
    "status " + joined.status + " location " + joined.headers.location);
  const offer = await getPage(BASE, "/add-passkey", { jar: npJar });
  check("email: the passkey offer stands in its words, with a way past it",
    offer.status === 200 && offer.text.includes("Make this device one tap") &&
      offer.text.includes("Add a passkey") && offer.text.includes("Not now"),
    "status " + offer.status);
  const meBefore = await raw(BASE, "GET", "/api/auth/me", npJar.headers(), null);
  check("email: the new account carries its address, and its name is the name given",
    meBefore.status === 200 && !!meBefore.json &&
      meBefore.json.email === "newperson@example.test" &&
      meBefore.json.name === "New Person" &&
      meBefore.json.key === "newperson@example.test",
    "status " + meBefore.status);
  // Enrol the passkey the offer's own ceremony uses.
  const authNP = makeAuthenticator();
  const enrolOpts = await jsonPost(BASE, "/api/auth/passkeys/options", {}, { jar: npJar });
  check("email: the enrolment options answer inside the first session",
    enrolOpts.status === 200 && !!enrolOpts.json && !!enrolOpts.json.challenge,
    "status " + enrolOpts.status);
  const enrol = await jsonPost(BASE, "/api/auth/passkeys",
    { response: authNP.attestation(enrolOpts.json.challenge) }, { jar: npJar });
  check("email: the passkey enrols",
    enrol.status === 201, "status " + enrol.status);
  // Out, and back with the one tap alone.
  await getPage(BASE, "/logout", { jar: npJar });
  const tapOpts = await jsonPost(BASE, "/login/passkey/options", {});
  const handleNP = b64uDrillToBuf(enrolOpts.json.user.id);
  const tapJar = jar();
  const tap = await jsonPost(BASE, "/login/passkey/verify",
    authNP.assertion(tapOpts.json.challenge, handleNP));
  tapJar.absorb(tap);
  check("email: signed out, the passkey alone signs back in — one tap, nothing typed",
    tap.status === 200 && !!tapJar.cookie && (await boardsStand(BASE, tapJar)),
    "status " + tap.status);

  // A rename never re-keys an email account, and a second
  // person may carry the same name.
  const renamed = await jsonPatch(BASE, "/api/me", { name: "Renamed Person" }, { jar: tapJar });
  const meAfter = await raw(BASE, "GET", "/api/auth/me", tapJar.headers(), null);
  check("email: a rename renames in place — the key stays the address",
    renamed.status === 200 && !!meAfter.json &&
      meAfter.json.name === "Renamed Person" &&
      meAfter.json.key === "newperson@example.test",
    "patch " + renamed.status);
  await jsonPatch(BASE, "/api/me", { name: "New Person" }, { jar: tapJar });

  // Returning by link: the spend signs out the other sign-ins.
  await askForLink("newperson@example.test", CA);
  await sleep(150);
  const npMail2 = await messagesTo("newperson@example.test");
  const npLink2 = linkPathOf(npMail2[npMail2.length - 1]);
  const backLanding = await getPage(BASE, npLink2);
  check("email: a returning person's link lands on the sign-in press",
    backLanding.status === 200 &&
      backLanding.text.includes("This link signs in New Person."),
    "status " + backLanding.status);
  const backJar = jar();
  backJar.absorb(await formPost(BASE, npLink2, {}));
  check("email: spending it signs in",
    !!backJar.cookie && (await boardsStand(BASE, backJar)));
  const oldMe = await raw(BASE, "GET", "/api/auth/me", tapJar.headers(), null);
  check("email: and the earlier session is revoked by the spend",
    oldMe.status === 401, "status " + oldMe.status);
  const spentAgain = await formPost(BASE, npLink2, {});
  const refusedPage = await getPage(BASE, npLink2);
  check("email: a link spent twice is refused — its page says so",
    spentAgain.status === 302 &&
      refusedPage.status === 200 &&
      refusedPage.text.includes("This link does not work."),
    "spend " + spentAgain.status + " page " + refusedPage.status);

  // An expired link is refused.
  await askForLink("newperson@example.test", CA);
  await sleep(150);
  const npMail3 = await messagesTo("newperson@example.test");
  const npLink3 = linkPathOf(npMail3[npMail3.length - 1]);
  rigSql("UPDATE email_links SET expires = 1 WHERE email = 'newperson@example.test' AND used_at IS NULL");
  const expiredPage = await getPage(BASE, npLink3);
  check("email: an expired link is refused",
    expiredPage.status === 200 &&
      expiredPage.text.includes("This link does not work."),
    "status " + expiredPage.status);

  // Closed: joining stops, signing in does not, and a link
  // asked while open cannot join once closed — nor is it
  // spent by the refused press.
  await askForLink("latejoiner@example.test", CA);
  await sleep(150);
  const ljMail = await messagesTo("latejoiner@example.test");
  const ljLink = linkPathOf(ljMail[ljMail.length - 1]);
  flipDoorRig(2);
  const closedAsk = await askForLink("closedperson@example.test", CA);
  await sleep(150);
  check("email: closed, a new address is sent nothing",
    closedAsk.status === 302 &&
      (await messagesTo("closedperson@example.test")).length === 0);
  const closedPage = await getPage(BASE, ljLink, CA);
  check("email: closed, the link's landing is the closed refusal",
    closedPage.status === 200 &&
      closedPage.text.includes("Joining is closed on this copy."),
    "status " + closedPage.status);
  const closedPress = await formPost(BASE, ljLink,
    { name: "Late Joiner", terms: "1", ...PASS }, CA);
  check("email: closed, a joining press makes no account",
    closedPress.status === 302 && !sessionCookieOf(closedPress),
    "status " + closedPress.status);
  await askForLink("newperson@example.test", CA);
  await sleep(150);
  const npMail4 = await messagesTo("newperson@example.test");
  check("email: closed, an account's link is still sent — signing in is never gated",
    npMail4.length >= 4 && !!linkPathOf(npMail4[npMail4.length - 1]),
    "messages " + npMail4.length);
  flipDoorRig(1);
  const reopened = await getPage(BASE, ljLink, CA);
  check("email: open again, the refused press's link still stands — it was never spent",
    reopened.status === 200 && reopened.text.includes("Make my boards"),
    "status " + reopened.status);
  const ljJar = jar();
  const ljJoined = await formPost(BASE, ljLink,
    { name: "Late Joiner", terms: "1", ...PASS }, { ...CA, jar: ljJar });
  ljJar.absorb(ljJoined);
  check("email: and it joins now",
    ljJoined.status === 302 &&
      (ljJoined.headers.location || "") === "/add-passkey" && !!ljJar.cookie,
    "status " + ljJoined.status + " location " + ljJoined.headers.location);

  // The country gate, at the ask and at the spend.
  const frAsk = await askForLink("france@example.test", FR);
  await sleep(150);
  check("email: an ask from a refused country is answered the same and sends nothing",
    frAsk.status === 302 && (frAsk.headers.location || "") === "/login/sent" &&
      (await messagesTo("france@example.test")).length === 0);
  await askForLink("traveller@example.test", CA);
  await sleep(150);
  const trMail = await messagesTo("traveller@example.test");
  const trLink = linkPathOf(trMail[trMail.length - 1]);
  const trGate = await getPage(BASE, trLink, FR);
  check("email: a link asked from Canada cannot join from a refused country — " +
      "the gate's page stands, in the ruled words",
    trGate.status === 200 &&
      trGate.text.includes("Joining is open to Canada and the United States for now."),
    "status " + trGate.status);
  const trPress = await formPost(BASE, trLink,
    { name: "Traveller", terms: "1", ...PASS }, FR);
  const trStill = await getPage(BASE, trLink, CA);
  check("email: the gated press spends nothing — the joining page stands from Canada",
    trPress.status === 302 && !sessionCookieOf(trPress) &&
      trStill.status === 200 && trStill.text.includes("Make my boards"),
    "press " + trPress.status + " page " + trStill.status);
  await askForLink("states@example.test", US);
  await sleep(150);
  const stMail = await messagesTo("states@example.test");
  const stLink = linkPathOf(stMail[stMail.length - 1]);
  const stJar = jar();
  const stJoined = await formPost(BASE, stLink,
    { name: "States Person", terms: "1", ...PASS }, { ...US, jar: stJar });
  stJar.absorb(stJoined);
  check("email: the United States joins, on its own boards",
    stJoined.status === 302 && !!stJar.cookie && (await boardsStand(BASE, stJar)),
    "status " + stJoined.status);

  // A second person with the very same name.
  await askForLink("samename@example.test", CA);
  await sleep(150);
  const snMail = await messagesTo("samename@example.test");
  const snLink = linkPathOf(snMail[snMail.length - 1]);
  const snJar = jar();
  const snJoined = await formPost(BASE, snLink,
    { name: "New Person", terms: "1", ...PASS }, { ...CA, jar: snJar });
  snJar.absorb(snJoined);
  check("email: a second person may carry the same name — names are not keys",
    snJoined.status === 302 && !!snJar.cookie && (await boardsStand(BASE, snJar)),
    "status " + snJoined.status);

  // The pace: five to one address in the hour send; the
  // sixth ask is answered identically and sends nothing.
  for (let i = 0; i < 5; i++) await askForLink("flood@example.test", CA);
  await sleep(150);
  const floodCount = (await messagesTo("flood@example.test")).length;
  const sixthAsk = await askForLink("flood@example.test", CA);
  await sleep(150);
  check("email: the link pace — five sent in the hour, the sixth ask " +
      "answered the same and nothing more sent",
    floodCount === 5 && sixthAsk.status === 302 &&
      (sixthAsk.headers.location || "") === "/login/sent" &&
      (await messagesTo("flood@example.test")).length === 5,
    "sent " + floodCount);

  // Nothing leaks: known, unknown and gated asks all answer
  // with the one redirect.
  const leakKnown = await askForLink("operator@example.test", CA);
  const leakUnknown = await askForLink("never-seen@example.test", CA);
  const leakGated = await askForLink("another-france@example.test", FR);
  check("email: nothing leaks — a known, an unknown and a gated address " +
      "are all answered with the same redirect",
    leakKnown.status === 302 && leakUnknown.status === 302 && leakGated.status === 302 &&
      leakKnown.headers.location === "/login/sent" &&
      leakUnknown.headers.location === leakKnown.headers.location &&
      leakGated.headers.location === leakKnown.headers.location);

  // The invites stand untouched by all of it. The minting
  // session is a fresh password sign-in: the operator's
  // setup session was revoked by their own link spend along
  // the way, as the model says it must be.
  const adminAgain = jar();
  adminAgain.absorb(await formPost(BASE, "/login",
    { name: "Email Admin", password: PW }));
  const minted = await jsonPost(BASE, "/api/auth/invites",
    { name: "Invited Person" }, { jar: adminAgain });
  const inviteJar = jar();
  inviteJar.absorb(await formPost(BASE, "/invite/" + (minted.json && minted.json.code),
    { name: "Invited Person", password: PW, confirm: PW }));
  check("email: an admin-minted invite still makes its account the password way",
    !!inviteJar.cookie && (await boardsStand(BASE, inviteJar)),
    "mint " + minted.status);
} finally {
  capture.close();
}

console.log("\nEmail drill: " + count + " checks, " + failures + " failures.");
process.exit(failures ? 1 : 0);
