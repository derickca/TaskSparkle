"use strict";

// TaskSparkle's Cloudflare entry: a thin wrapper around the
// shared API core in worker/core.js. Everything the routes do
// lives in the core; what stands in this file is only what is
// Cloudflare's own:
//
// - the plain-HTTP redirect for the two real doors, answered
//   before any credential is read;
// - the sign-in pages themselves (worker/auth.js): the login,
//   setup and invite pages the hosted door serves, since the
//   Google sign-in was switched off (issue #109);
// - the transition door's adapter, which verifies the
//   Cloudflare Access token (JWT) in full — the signing keys from
//   the team domain, the RS256 signature, the audience, the
//   expiry — and answers the person's email and name, or nothing;
//   it stands only for migration, resolving rows that already
//   stand, and the cutover removes it;
// - the push adapters, which speak to the OwnerPush Durable
//   Object at the end of this file: notify it when a change
//   lands, and hand it a live-updates socket to hold.
//
// The self-host server (server/) wraps the same core with its
// own adapters instead; the two deployments share every route,
// check and word of the directions.

import { createApiHandler, browserHost, agentHost } from "./core.js";
import { createAuthHandlers, sha256Hex } from "./auth.js";

// --- Cloudflare Access token (JWT) verification ---

function base64UrlToBytes(text) {
  var b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlToText(text) {
  var bytes = base64UrlToBytes(text);
  return new TextDecoder().decode(bytes);
}

var accessKeysCache = { fetchedAt: 0, keys: [] };

async function accessSigningKeys(env) {
  var now = Date.now();
  if (accessKeysCache.keys.length && now - accessKeysCache.fetchedAt < 60 * 60 * 1000) {
    return accessKeysCache.keys;
  }
  var res = await fetch(env.ACCESS_TEAM_DOMAIN + "/cdn-cgi/access/certs");
  if (!res.ok) throw new Error("Could not fetch Access signing keys.");
  var body = await res.json();
  accessKeysCache = { fetchedAt: now, keys: body.keys || [] };
  return accessKeysCache.keys;
}

// Returns the token payload when the Access token is genuine, minted
// for this app and unexpired. Returns null for anything else.
async function verifyAccessToken(token, env) {
  try {
    var parts = token.split(".");
    if (parts.length !== 3) return null;
    var header = JSON.parse(base64UrlToText(parts[0]));
    var payload = JSON.parse(base64UrlToText(parts[1]));
    if (header.alg !== "RS256" || !header.kid) return null;

    var audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (audiences.indexOf(env.ACCESS_AUD) === -1) return null;
    // The issuer must be the team domain the signing keys came
    // from. Signature and audience already pin the token to this
    // team and this app; this is the last standard claim, checked
    // because it costs one comparison.
    var teamDomain = String(env.ACCESS_TEAM_DOMAIN || "").replace(/\/+$/, "");
    if (!payload.iss || String(payload.iss).replace(/\/+$/, "") !== teamDomain) return null;
    if (!payload.exp || payload.exp * 1000 <= Date.now()) return null;
    if (payload.nbf && payload.nbf * 1000 > Date.now()) return null;

    var keys = await accessSigningKeys(env);
    var jwk = null;
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].kid === header.kid) jwk = keys[i];
    }
    if (!jwk) return null;

    var key = await crypto.subtle.importKey(
      "jwk", jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false, ["verify"]
    );
    var signed = new TextEncoder().encode(parts[0] + "." + parts[1]);
    var ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, base64UrlToBytes(parts[2]), signed
    );
    if (!ok) return null;
    if (!payload.email) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// Tells the owner's push object that a new version exists, so it can
// pass the number to the owner's open browsers. Best effort by
// design: the version itself is the truth, held in the database,
// and a browser that misses a push catches up from the version
// endpoint when its socket reconnects or the tab returns.
function notifyOwnerPush(env, ctx, ownerId, version) {
  if (!env || !env.PUSH) return;
  try {
    var stub = env.PUSH.get(env.PUSH.idFromName(ownerId));
    var sent = stub.fetch("https://owner-push/broadcast", {
      method: "POST",
      body: String(version)
    });
    var settled = Promise.resolve(sent).then(function () {}, function () {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(settled);
  } catch (e) { /* push is a courtesy; the version still tells the truth */ }
}

// SIGNUP_COUNTRIES names the countries joining is open to, as
// the edge reports them ("CA,US"). Unset, it stands at the
// hosted service's pair — Canada and the United States — so
// the gate survives an operator forgetting the setting; a copy
// that wants no gate sets it empty.
function signupCountriesOf(env) {
  if (!env || env.SIGNUP_COUNTRIES === undefined || env.SIGNUP_COUNTRIES === null) {
    return ["CA", "US"];
  }
  return String(env.SIGNUP_COUNTRIES).split(",")
    .map(function (code) { return code.trim().toUpperCase(); })
    .filter(Boolean);
}

// The bot check's server-side half: posts the person's token
// to the verification address with the deployment's secret and
// answers whether it stood. Unconfigured, it answers false —
// the check fails closed wherever a site key stands.
async function verifyTurnstile(env, token, source) {
  if (!env || !env.TURNSTILE_SECRET_KEY) return false;
  try {
    var res = await fetch(env.TURNSTILE_VERIFY_URL || "https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY, response: token,
        remoteip: source || "",
      }),
    });
    if (!res.ok) return false;
    var data = await res.json();
    return !!(data && data.success);
  } catch (e) {
    return false;
  }
}

async function sha256HexText(text) {
  var digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  var bytes = new Uint8Array(digest);
  var hex = "";
  for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

// The hosted copy's mail path: one message through the shared
// mail service, under this app's own credential — scoped
// service-side to this app's sender addresses and kinds, so
// the key can only ever send as TaskSparkle. Two shapes stand:
// the service binding, where the deployment bound the mail
// service's Worker (the host in a binding call is never read —
// the binding routes the call itself — so a plain name stands
// there), and a plain signed call to MAIL_SEND_URL, the shape
// a caller off this platform uses. Neither configured, nothing
// sends: the ask was still answered the same, and the
// operator's wiring completes it.
async function sendViaMailService(env, message) {
  var body = JSON.stringify({
    from: (env && env.MAIL_FROM) || "noreply@tasksparkle.com",
    from_name: "TaskSparkle",
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    kind: message.kind,
    idempotency_key: message.idempotencyKey,
  });
  try {
    if (env && env.MAIL_SERVICE && env.MAIL_SERVICE.fetch) {
      var bound = await env.MAIL_SERVICE.fetch("https://mail-service/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mail-app": "tasksparkle",
          "authorization": "Bearer " + (env.MAIL_APP_KEY || ""),
        },
        body: body,
      });
      return bound.status === 202 || bound.status === 200;
    }
    if (env && env.MAIL_SEND_URL && env.MAIL_APP_KEY) {
      var timestamp = String(Math.floor(Date.now() / 1000));
      var nonceBytes = new Uint8Array(16);
      crypto.getRandomValues(nonceBytes);
      var nonce = "";
      for (var i = 0; i < nonceBytes.length; i++) {
        nonce += nonceBytes[i].toString(16).padStart(2, "0");
      }
      var bodyHash = await sha256HexText(body);
      var signed = "POST\n/send\n" + timestamp + "\n" + nonce + "\n" + bodyHash;
      var key = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(env.MAIL_APP_KEY),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      var signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
      var sigBytes = new Uint8Array(signature);
      var signatureHex = "";
      for (var j = 0; j < sigBytes.length; j++) {
        signatureHex += sigBytes[j].toString(16).padStart(2, "0");
      }
      var called = await fetch(env.MAIL_SEND_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mail-app": "tasksparkle",
          "x-mail-key": env.MAIL_APP_KEY,
          "x-mail-timestamp": timestamp,
          "x-mail-nonce": nonce,
          "x-mail-signature": signatureHex,
        },
        body: body,
      });
      return called.status === 202 || called.status === 200;
    }
    return false;
  } catch (e) {
    return false;
  }
}

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var host = url.hostname;

    // Neither door answers over plain HTTP. The people's door is
    // served over HTTPS by its host, but the agents' door once
    // answered an http:// request directly, ready to take a key
    // sent unencrypted by a client pointed at the wrong spelling.
    // A permanent redirect sends the caller to the same address
    // over HTTPS before any credential is read. Local rigs answer
    // under other hostnames and are not redirected.
    if ((host === browserHost(env) || host === agentHost(env)) && url.protocol === "http:") {
      return Response.redirect("https://" + url.host + url.pathname + url.search, 308);
    }

    var store = env && env.DB ? env.DB : null;
    var authStore = env && env.AUTH_DB ? env.AUTH_DB : store;

    // The sign-in pages (issue #109): the Worker serves them
    // itself on the people's door — the login page, the setup
    // page, the invite pages and the sign-out. The hosted door
    // takes a typed name, never a list, and the setup page
    // asks for the deployment's one-time setup code. The
    // agents' door serves none of them.
    if (host !== agentHost(env)) {
      var authPages = createAuthHandlers({
        authDb: authStore,
        cfg: {
          hosted: true,
          listNames: false,
          requireSetupCode: true,
          setupCodeHash: async function () {
            return env && env.SETUP_CODE ? sha256Hex(String(env.SETUP_CODE)) : null;
          },
          sourceOf: function (req) {
            // The placing proxy's own source header, never a
            // client-settable one.
            return req.headers.get("CF-Connecting-IP") || "unknown";
          },
          sourceCapMs: 15 * 60 * 1000,
          cookieSecure: function () { return true; },
          // The joining gates and the mail path, this
          // deployment's own seams (see worker/auth.js): the
          // country comes from the edge's own header, and a
          // missing header reads as no country at all.
          signupCountries: signupCountriesOf(env),
          countryOf: function (req) {
            return req.headers.get("CF-IPCountry") || null;
          },
          turnstileSiteKey: (env && env.TURNSTILE_SITE_KEY) || null,
          turnstileVerify: function (token, source) {
            return verifyTurnstile(env, token, source);
          },
          mailSend: function (message) {
            return sendViaMailService(env, message);
          }
        }
      });
      var pageAnswer = await authPages(request);
      if (pageAnswer) return pageAnswer;
    }

    var handler = createApiHandler({
      db: store,
      authDb: authStore,
      env: env || {},
      sessionCookieName: "CF_Authorization",
      auth: {
        accessIdentity: async function (req) {
          var jwt = req.headers.get("Cf-Access-Jwt-Assertion");
          if (!jwt) return null;
          var payload = await verifyAccessToken(jwt, env);
          if (!payload) return null;
          return { email: payload.email, name: payload.name || null };
        },
        sourceOf: function (req) {
          return req.headers.get("CF-Connecting-IP") || "unknown";
        },
        sourceCapMs: 15 * 60 * 1000,
        publicBase: "https://" + browserHost(env)
      },
      pushNotify: function (ownerId, version) {
        notifyOwnerPush(env, ctx, ownerId, version);
      },
      acceptPush: env && env.PUSH ? async function (req, owner) {
        var stub = env.PUSH.get(env.PUSH.idFromName(owner.id));
        return stub.fetch(req);
      } : null,
      // An erasure on the hosted copy has no deployment state
      // outside the shared tables to clear.
      onOwnerDeleted: null
    });
    return handler(request);
  }
};

// --- The push object ---
//
// One Durable Object per owner holds that owner's open browser
// sockets. It stores nothing and knows no state: the Worker hands
// it a new version number after a change lands, and it passes the
// number — the number and nothing else — to every socket it holds.
// A browser that hears a number higher than the one it shows knows
// its board is behind and fetches the state again. Sockets are
// held with the hibernation API, so an idle socket costs nothing
// and a socket whose browser went away is simply gone the next
// time a broadcast walks the list.
export class OwnerPush {
  constructor(ctx, env) {
    this.ctx = ctx;
  }

  async fetch(request) {
    var url = new URL(request.url);
    if (url.pathname === "/broadcast" && request.method === "POST") {
      var version = await request.text();
      var sockets = this.ctx.getWebSockets();
      for (var i = 0; i < sockets.length; i++) {
        try { sockets[i].send(version); } catch (e) { /* a gone socket is skipped */ }
      }
      return new Response("ok", { status: 200 });
    }
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      var pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("Not found", { status: 404 });
  }

  // A browser never sends anything the object needs. Messages are
  // accepted and ignored, so a client that pings to keep its socket
  // warm is harmless.
  async webSocketMessage(ws, message) {}

  async webSocketClose(ws, code, reason, wasClean) {
    try { ws.close(code, "closed"); } catch (e) { /* already gone */ }
  }

  async webSocketError(ws, error) {
    try { ws.close(1011, "error"); } catch (e) { /* already gone */ }
  }
}
