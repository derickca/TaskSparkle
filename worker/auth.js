"use strict";

// TaskSparkle's shared sign-in: accounts, passwords, passkeys,
// invites, sessions, throttling and the pages that carry them.
//
// This file is the one account system the design names (issue
// #109): the same code runs in the Cloudflare Worker (through
// worker/worker.js) and in the self-host server (server/), the
// way worker/core.js already serves both homes. What differs by
// home arrives as the config the wrappers hand in: whether the
// login page lists names or takes a typed one, whether setup
// asks for a setup code, how long a source lockout may last, and
// where a request's source address is read from.
//
// The tables this file works live in worker/schema.sql (the
// accounts, invites, passkeys, auth_challenges, sessions,
// auth_audit, auth_throttle and auth_meta tables). On a home
// copy they sit in the same SQLite file as the boards; on the
// hosted copy they sit in the deployment's second D1 database
// when one is bound (the authDb adapter), so a flood of sign-in
// defence writes can never spend the boards' write quota. The
// store functions below take that adapter as their first
// argument and speak the same D1 shape the core speaks.
//
// Passwords rest as scrypt through node:crypto (see the
// passwords section below): the same standard-library scheme
// in both homes, at OWASP's listed parameters, stored in PHC
// string format. Older stored forms — the chained-PBKDF2 form
// this build carried before the scrypt amendment, and the
// legacy scrypt form the self-host copy wrote before the
// sign-in tables were shared — still verify, and each is
// rehashed to the PHC form at its next successful proof.

import { COMMON_PASSWORDS } from "./common-passwords.js";
import { scrypt, timingSafeEqual } from "node:crypto";

// --- Small byte and text helpers ---------------------------------------------

export function b64uEncode(bytes) {
  var bin = "";
  var view = new Uint8Array(bytes);
  for (var i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(text) {
  var b64 = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function b64Encode(bytes) {
  var bin = "";
  var view = new Uint8Array(bytes);
  for (var i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return btoa(bin);
}

export function b64Decode(text) {
  var bin = atob(String(text || ""));
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function randomBytes(count) {
  var bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  return bytes;
}

export async function sha256Bytes(value) {
  var bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  var digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

export async function sha256Hex(value) {
  var digest = await sha256Bytes(value);
  return Array.from(digest).map(function (b) {
    return b.toString(16).padStart(2, "0");
  }).join("");
}

// Compares two byte strings in fixed time: the loop always runs
// the full length, so its timing says nothing about where a
// difference stood. The Worker has no exported constant-time
// compare; Node's exists, but one shared shape keeps the two
// homes honest in the same words.
export function bytesEqual(a, b) {
  var x = new Uint8Array(a);
  var y = new Uint8Array(b);
  if (x.length !== y.length) return false;
  var diff = 0;
  for (var i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function nowMs() {
  return Date.now();
}

export function newAccountId() {
  return "acct-" + crypto.randomUUID();
}

// --- Names ---------------------------------------------------------------------
// A sign-in name, in its two forms: the display form is the name
// as typed, trimmed; the key form folds it to lower case, and
// accounts are matched and stored by the key, so "Robin" and
// "robin" are one account everywhere. A name is a name, never an
// address: an "@" in one is refused wherever a name is taken in.

export function nameKey(name) {
  return String(name || "").trim().toLowerCase();
}

export function nameProblem(name) {
  var display = String(name || "").trim();
  if (!display) return "No name was given.";
  if (display.length > 120) return "That name is over 120 characters.";
  if (display.indexOf("@") !== -1) {
    return "That is an address, not a name. A name is what people call the person.";
  }
  return null;
}

// --- Passwords: scrypt through node:crypto --------------------------------------
//
// New hashes are scrypt at OWASP's listed parameters —
// N=32768 (2^15), r=8, p=3, a 32-byte key — stored in PHC
// string format, the parameters carried in the string:
//
//   $scrypt$ln=15,r=8,p=3$<salt base64>$<hash base64>
//
// node:crypto carries the scheme in both runtimes: Node's
// standard library on the home copy, and the hosted runtime's
// node:crypto compatibility layer, which Cloudflare supports
// in full except Argon2 (the probe record stands in the
// design's appendix B, and the review's amendment nod beside
// it). maxmem is set explicitly, above the configuration's
// 32 MiB footprint: both runtimes default it at the edge of
// these parameters and refuse the call without the raise.
//
// Verification dispatches on the stored form's FULL prefix:
//
//   $scrypt$        the current PHC form, above.
//   pbkdf2-sha256$  the chained-PBKDF2 form this build carried
//                   before the scrypt amendment — the recorded
//                   fallback. It verifies, and ages out at the
//                   proof that verifies it.
//   scrypt$         the legacy form the self-host copy wrote
//                   before the sign-in tables were shared:
//                   Node's default parameters (N=16384, r=8,
//                   p=1) and a 64-byte key. The hosted copy
//                   never held such rows.
//
// The leading $ is the whole difference between the PHC form
// and the legacy form, so the dispatch keys on the full
// prefix, never on a bare "scrypt" substring. A row that
// verifies and is not in the current form is rehashed to the
// PHC form at that same proof (checkPassword and its core
// twin do it), so older forms age out account by account
// instead of by flag day. A stored row whose parameters are
// zero or absurd is refused rather than honoured, in every
// form: stored parameters are trusted only within sane
// bounds. No intermediate derivation value is ever logged,
// stored or returned; only the final bytes rest.

export var SCRYPT_LN = 15;
export var SCRYPT_R = 8;
export var SCRYPT_P = 3;
export var MIN_PASSWORD_LENGTH = 12;

var SCRYPT_KEYLEN = 32;
var SCRYPT_MAXMEM = 128 * 1024 * 1024;

// Stored-parameter bounds for the PHC form. The work cap is
// the hosted runtime's own scrypt cost guard, N·r·p ≤ 2^20, so
// a row one home would refuse can never verify on the other.
var MAX_SCRYPT_LN = 20;
var MAX_SCRYPT_R = 32;
var MAX_SCRYPT_P = 16;
var MAX_SCRYPT_WORK = 1048576;

// The dummy hash: a fixed salt and a fixed password's scrypt
// derivation at the current parameters, precomputed. A name
// with no account, and an account with no password yet, are
// checked against this, so a refusal costs the same derivation
// as a wrong guess and neither the wording nor the timing says
// which case it was.
export var DUMMY_STORED =
  "$scrypt$ln=15,r=8,p=3$dGFza3NwYXJrbGUtZHVtbQ==$wdTDPJyB/h1c6t5UxYfVF5DHFkz9Ng40eZwqbrSEqmc=";

function scryptDerive(password, saltBytes, keylen, N, r, p) {
  return new Promise(function (resolve, reject) {
    scrypt(String(password == null ? "" : password), saltBytes, keylen,
      { N: N, r: r, p: p, maxmem: SCRYPT_MAXMEM },
      function (err, key) {
        if (err) reject(err);
        else resolve(new Uint8Array(key));
      });
  });
}

// The constant-time comparison node:crypto carries in both
// homes; a length difference answers false before it runs.
function hashEqual(a, b) {
  var x = Buffer.from(new Uint8Array(a));
  var y = Buffer.from(new Uint8Array(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

// Parses a PHC scrypt row. Answers null for anything that is
// not a well-formed PHC row with sane parameters.
export function parseScryptPhc(stored) {
  var parts = String(stored || "").split("$");
  if (parts.length !== 5 || parts[0] !== "" || parts[1] !== "scrypt") return null;
  var m = /^ln=(\d+),r=(\d+),p=(\d+)$/.exec(parts[2]);
  if (!m) return null;
  var ln = Number(m[1]);
  var r = Number(m[2]);
  var p = Number(m[3]);
  if (!ln || ln > MAX_SCRYPT_LN) return null;
  if (!r || r > MAX_SCRYPT_R) return null;
  if (!p || p > MAX_SCRYPT_P) return null;
  var N = Math.pow(2, ln);
  if (N * r * p > MAX_SCRYPT_WORK) return null;
  var salt, hash;
  try {
    salt = b64Decode(parts[3]);
    hash = b64Decode(parts[4]);
  } catch (e) {
    return null;
  }
  if (salt.length < 8 || salt.length > 64) return null;
  if (hash.length < 16 || hash.length > 64) return null;
  return { ln: ln, N: N, r: r, p: p, salt: salt, hash: hash };
}

// Parses a legacy scrypt row, the "scrypt$<salt>$<hash>" form
// the self-host copy wrote before the tables were shared. Its
// parameters are not in the string: they are Node's defaults
// of the day (N=16384, r=8, p=1) and a 64-byte key, which the
// verifier supplies.
function parseLegacyScrypt(stored) {
  var parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return null;
  var salt, hash;
  try {
    salt = b64Decode(parts[1]);
    hash = b64Decode(parts[2]);
  } catch (e) {
    return null;
  }
  if (salt.length < 8 || salt.length > 64) return null;
  if (hash.length !== 64) return null;
  return { salt: salt, hash: hash };
}

export async function hashPassword(password) {
  var salt = randomBytes(16);
  var derived = await scryptDerive(password, salt, SCRYPT_KEYLEN,
    Math.pow(2, SCRYPT_LN), SCRYPT_R, SCRYPT_P);
  return "$scrypt$ln=" + SCRYPT_LN + ",r=" + SCRYPT_R + ",p=" + SCRYPT_P + "$" +
    b64Encode(salt) + "$" + b64Encode(derived);
}

// --- The recorded fallback: chained PBKDF2-HMAC-SHA256 ---------------------------
//
// The construction this build carried between the PBKDF2 probe
// and the scrypt amendment (design appendix B): 100,000 rounds
// per WebCrypto call — the hosted runtime's per-call cap — the
// output fed back as the next call's input under the same
// salt, six calls. No new hash is written in this form; the
// code stays so a row written in it, if the fallback was ever
// live, still verifies and is rehashed to the PHC form at that
// proof. The chain marker is always present — one grammar,
// never a bare integer — and zero or absurd parameters are
// refused, as in every form. No intermediate chain value is
// ever logged, stored or returned.

export var PBKDF2_ROUNDS = 100000;
export var PBKDF2_CHAIN = 6;

var MAX_ROUNDS_PER_CALL = 1000000;
var MAX_CHAIN = 64;
var MAX_TOTAL_ROUNDS = 4000000;

async function pbkdf2Stage(passwordBytes, saltBytes, rounds, previous) {
  var input = previous || passwordBytes;
  var key = await crypto.subtle.importKey("raw", input, "PBKDF2", false, ["deriveBits"]);
  var out = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: rounds },
    key, 256
  );
  return new Uint8Array(out);
}

// Runs the chain the stored form names. The first call derives
// from the password itself; each later call derives from the
// previous call's full 256-bit output, under the same salt.
export async function pbkdf2Chain(password, saltBytes, rounds, chain) {
  var passwordBytes = new TextEncoder().encode(String(password || ""));
  var current = null;
  for (var i = 0; i < chain; i++) {
    current = await pbkdf2Stage(passwordBytes, saltBytes, rounds, current);
  }
  return current;
}

// Parses a stored hash string. Answers null for anything that
// is not a well-formed chained-PBKDF2 row with sane parameters.
export function parsePbkdf2(stored) {
  var parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return null;
  var m = /^(\d+)x(\d+)$/.exec(parts[1]);
  if (!m) return null;
  var rounds = Number(m[1]);
  var chain = Number(m[2]);
  if (!rounds || !chain) return null;
  if (rounds > MAX_ROUNDS_PER_CALL || chain > MAX_CHAIN) return null;
  if (rounds * chain > MAX_TOTAL_ROUNDS) return null;
  var salt, hash;
  try {
    salt = b64Decode(parts[2]);
    hash = b64Decode(parts[3]);
  } catch (e) {
    return null;
  }
  if (salt.length < 8 || salt.length > 64) return null;
  if (hash.length < 16 || hash.length > 64) return null;
  return { rounds: rounds, chain: chain, salt: salt, hash: hash };
}

// Verifies a password against a stored row, dispatching on
// the row's full prefix (see the section head). Answers
// { ok, legacy }: legacy is true when the row is a legacy
// scrypt row (the caller rehashes on any successful proof of a
// non-current form). A row in no known shape — including one
// whose parameters were refused — costs the dummy derivation
// and answers false, so its timing matches every other
// refusal; a derivation that errors is a refusal too, never a
// server error.
export async function verifyPassword(stored, password) {
  var text = typeof stored === "string" ? stored : "";
  try {
    if (text.indexOf("$scrypt$") === 0) {
      var phc = parseScryptPhc(text);
      if (phc) {
        var derived = await scryptDerive(password, phc.salt, phc.hash.length,
          phc.N, phc.r, phc.p);
        return { ok: hashEqual(derived, phc.hash), legacy: false };
      }
    } else if (text.indexOf("pbkdf2-sha256$") === 0) {
      var pb = parsePbkdf2(text);
      if (pb) {
        var chainDerived = await pbkdf2Chain(password, pb.salt, pb.rounds, pb.chain);
        return { ok: hashEqual(chainDerived, pb.hash), legacy: false };
      }
    } else if (text.indexOf("scrypt$") === 0) {
      var legacy = parseLegacyScrypt(text);
      if (legacy) {
        var legacyDerived = await scryptDerive(password, legacy.salt,
          legacy.hash.length, 16384, 8, 1);
        return { ok: hashEqual(legacyDerived, legacy.hash), legacy: true };
      }
    }
  } catch (e) {
    // A derivation the runtime refuses is a failed proof.
  }
  var dummy = parseScryptPhc(DUMMY_STORED);
  var dummyDerived = await scryptDerive(password, dummy.salt, dummy.hash.length,
    dummy.N, dummy.r, dummy.p);
  hashEqual(dummyDerived, dummy.hash); // the result is discarded; the cost is the point
  return { ok: false, legacy: false };
}

// Whether a stored row already carries the current form at
// the current parameters. A row that verifies in any other
// form is rehashed at that proof.
export function isCurrentHash(stored) {
  var parsed = parseScryptPhc(stored);
  return !!parsed && parsed.ln === SCRYPT_LN &&
    parsed.r === SCRYPT_R && parsed.p === SCRYPT_P;
}

// The rules a new password must pass, in one place so setup,
// invites, resets and the change flow all judge the same way.
// Answers the refusal's words, or null when the password stands.
export function passwordProblem(password, accountName) {
  var value = String(password || "");
  if (value.length < MIN_PASSWORD_LENGTH) {
    return "The password needs at least " + MIN_PASSWORD_LENGTH + " characters.";
  }
  if (COMMON_PASSWORDS.has(value.toLowerCase())) {
    return "That password is on the list of passwords people use most. Pick a less common one.";
  }
  if (accountName && value.toLowerCase() === String(accountName).toLowerCase()) {
    return "The password cannot be your own name.";
  }
  return null;
}

// The same judgement as a key, for the doors that carry the
// refusal through a redirect (issue #147): the setup and
// invite pages hold passwordProblem's exact sentences under
// these keys, so a spend refusal names its actual reason —
// the two passwords apart, too short, too common, or the
// person's own name — instead of one line that covers all of
// them and can mislead both ways. Null when the pair stands.
export function passwordRefusalKey(password, confirm, accountName) {
  if (String(password || "") !== String(confirm || "")) return "pwmismatch";
  var value = String(password || "");
  if (value.length < MIN_PASSWORD_LENGTH) return "pwlength";
  if (COMMON_PASSWORDS.has(value.toLowerCase())) return "pwcommon";
  if (accountName && value.toLowerCase() === String(accountName).toLowerCase()) {
    return "pwname";
  }
  return null;
}

// The spend pages' refusal lines for a password pair, keyed
// by passwordRefusalKey: passwordProblem's sentences word for
// word, plus the mismatch line the pair check adds.
var PASSWORD_REFUSAL_MESSAGES = {
  pwmismatch: "The two passwords did not match.",
  pwlength: "The password needs at least " + MIN_PASSWORD_LENGTH + " characters.",
  pwcommon: "That password is on the list of passwords people use most. Pick a less common one.",
  pwname: "The password cannot be your own name.",
};

// --- CBOR, the subset WebAuthn's structures use ---------------------------------
//
// Attested credential data and the COSE public key inside it
// are CBOR. This decoder covers only the subset those
// structures use — unsigned and negative integers, byte
// strings, text strings, arrays, maps and the simple values
// true, false and null — and refuses anything outside it
// (indefinite lengths, tags, floats) rather than guessing.
// It is the bug-densest component in this build, and the
// drills reach it first, with the ceremony vectors.

export function decodeCBOR(bytes, offset) {
  var view = new Uint8Array(bytes);
  var pos = offset || 0;

  function readLength(info) {
    if (info < 24) return info;
    if (info === 24) { var v8 = view[pos]; pos += 1; return v8; }
    if (info === 25) {
      var v16 = (view[pos] << 8) | view[pos + 1]; pos += 2; return v16;
    }
    if (info === 26) {
      var v32 = ((view[pos] << 24) | (view[pos + 1] << 16) | (view[pos + 2] << 8) | view[pos + 3]) >>> 0;
      pos += 4; return v32;
    }
    throw new Error("CBOR length outside the supported subset.");
  }

  function readValue() {
    if (pos >= view.length) throw new Error("CBOR ran past its end.");
    var initial = view[pos]; pos += 1;
    var major = initial >> 5;
    var info = initial & 31;
    if (major === 0) return readLength(info);
    if (major === 1) return -1 - readLength(info);
    if (major === 2) {
      var len2 = readLength(info);
      var out2 = view.slice(pos, pos + len2);
      if (out2.length !== len2) throw new Error("CBOR byte string ran past its end.");
      pos += len2;
      return out2;
    }
    if (major === 3) {
      var len3 = readLength(info);
      var out3 = view.slice(pos, pos + len3);
      if (out3.length !== len3) throw new Error("CBOR text string ran past its end.");
      pos += len3;
      return new TextDecoder().decode(out3);
    }
    if (major === 4) {
      var len4 = readLength(info);
      var arr = [];
      for (var i = 0; i < len4; i++) arr.push(readValue());
      return arr;
    }
    if (major === 5) {
      var len5 = readLength(info);
      var map = new Map();
      for (var j = 0; j < len5; j++) {
        var k = readValue();
        map.set(k, readValue());
      }
      return map;
    }
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new Error("CBOR simple value outside the supported subset.");
    }
    throw new Error("CBOR major type outside the supported subset.");
  }

  var value = readValue();
  return { value: value, next: pos };
}

// Encodes the small CBOR shapes the drill's software
// authenticator and any future test need. The product code
// only decodes; this stands here so the decoder's one home
// carries its mirror, and the drills import it from here
// rather than growing a second CBOR in the tests.
export function encodeCBOR(value) {
  var chunks = [];
  function head(major, n) {
    if (n < 24) chunks.push(new Uint8Array([(major << 5) | n]));
    else if (n < 256) chunks.push(new Uint8Array([(major << 5) | 24, n]));
    else if (n < 65536) chunks.push(new Uint8Array([(major << 5) | 25, (n >> 8) & 255, n & 255]));
    else chunks.push(new Uint8Array([(major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]));
  }
  function write(v) {
    if (v === null) { chunks.push(new Uint8Array([0xf6])); return; }
    if (v === true) { chunks.push(new Uint8Array([0xf5])); return; }
    if (v === false) { chunks.push(new Uint8Array([0xf4])); return; }
    if (typeof v === "number") {
      if (v >= 0) { head(0, v); return; }
      head(1, -1 - v); return;
    }
    if (typeof v === "string") {
      var text = new TextEncoder().encode(v);
      head(3, text.length); chunks.push(text); return;
    }
    if (v instanceof Uint8Array) { head(2, v.length); chunks.push(v); return; }
    if (Array.isArray(v)) {
      head(4, v.length);
      v.forEach(write); return;
    }
    if (v instanceof Map) {
      head(5, v.size);
      v.forEach(function (val, key) { write(key); write(val); });
      return;
    }
    throw new Error("CBOR encode: unsupported value.");
  }
  write(value);
  var total = chunks.reduce(function (sum, c) { return sum + c.length; }, 0);
  var out = new Uint8Array(total);
  var at = 0;
  chunks.forEach(function (c) { out.set(c, at); at += c.length; });
  return out;
}

// --- WebAuthn verification ---------------------------------------------------------
//
// The two ceremonies, verified by hand against WebCrypto — the
// design accepts the hand-roll because the surface is small
// (two ceremonies, three signature schemes) and pins it with
// the drill vectors. The duties, from the design's appendix C:
// the challenge matches an unspent challenge of the right kind;
// the client data's type is exactly webauthn.create or
// webauthn.get; the origin matches exactly; the RP ID hash
// names the configured relying party; user presence AND user
// verification flags are set; a returned user handle that names
// a different account than the credential's is a refusal.

export var WEBAUTHN_ALGS = { ES256: -7, EDDSA: -8, RS256: -257 };

function parseAuthData(authData) {
  var bytes = new Uint8Array(authData);
  if (bytes.length < 37) throw new Error("Authenticator data is too short.");
  var rpIdHash = bytes.slice(0, 32);
  var flags = bytes[32];
  var signCount = ((bytes[33] << 24) | (bytes[34] << 16) | (bytes[35] << 8) | bytes[36]) >>> 0;
  var parsed = {
    rpIdHash: rpIdHash,
    flags: flags,
    userPresent: !!(flags & 1),
    userVerified: !!(flags & 4),
    backedUpEligible: !!(flags & 8),
    backedUp: !!(flags & 16),
    hasAttested: !!(flags & 64),
    signCount: signCount,
    attested: null,
  };
  if (parsed.hasAttested) {
    if (bytes.length < 55) throw new Error("Attested credential data is too short.");
    var aaguid = bytes.slice(37, 53);
    var credLen = (bytes[53] << 8) | bytes[54];
    var credentialId = bytes.slice(55, 55 + credLen);
    if (credentialId.length !== credLen) throw new Error("Credential id ran past its end.");
    var coseStart = 55 + credLen;
    var decoded = decodeCBOR(bytes, coseStart);
    parsed.attested = {
      aaguid: aaguid,
      credentialId: credentialId,
      cosePublicKey: decoded.value,
      coseBytes: bytes.slice(coseStart, decoded.next),
    };
  }
  return parsed;
}

async function checkRpAndFlags(authData, expectedRpId) {
  var expectedHash = await sha256Bytes(expectedRpId);
  if (!bytesEqual(authData.rpIdHash, expectedHash)) {
    throw new Error("The relying party does not match.");
  }
  if (!authData.userPresent) throw new Error("The user-presence flag is not set.");
  if (!authData.userVerified) throw new Error("The user-verification flag is not set.");
}

function checkClientData(clientDataBytes, expectedType, expectedChallengeB64u, expectedOrigin) {
  var data;
  try {
    data = JSON.parse(new TextDecoder().decode(clientDataBytes));
  } catch (e) {
    throw new Error("The client data is not readable.");
  }
  if (!data || data.type !== expectedType) {
    throw new Error("The client data names the wrong ceremony.");
  }
  if (data.challenge !== expectedChallengeB64u) {
    throw new Error("The challenge does not match.");
  }
  if (data.origin !== expectedOrigin) {
    throw new Error("The origin does not match.");
  }
  return data;
}

// Lifts a COSE public key into a WebCrypto key the verify call
// can use. A credential whose algorithm is none of the three is
// refused here, at enrolment, never discovered at sign-in.
export async function importCoseKey(cose) {
  if (!(cose instanceof Map)) throw new Error("The public key is not a COSE map.");
  var kty = cose.get(1);
  var alg = cose.get(3);
  if (kty === 2 && alg === WEBAUTHN_ALGS.ES256) {
    var crv = cose.get(-1);
    var x = cose.get(-2);
    var y = cose.get(-3);
    if (crv !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
      throw new Error("The ES256 key is incomplete.");
    }
    var jwk = { kty: "EC", crv: "P-256", x: b64uEncode(x), y: b64uEncode(y) };
    var key = await crypto.subtle.importKey("jwk", jwk,
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return { key: key, alg: alg };
  }
  if (kty === 1 && alg === WEBAUTHN_ALGS.EDDSA) {
    var raw = cose.get(-2);
    if (!(raw instanceof Uint8Array)) throw new Error("The EdDSA key is incomplete.");
    var edKey = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    return { key: edKey, alg: alg };
  }
  if (kty === 3 && alg === WEBAUTHN_ALGS.RS256) {
    var n = cose.get(-1);
    var e = cose.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) {
      throw new Error("The RS256 key is incomplete.");
    }
    var rsaJwk = { kty: "RSA", n: b64uEncode(n), e: b64uEncode(e) };
    var rsaKey = await crypto.subtle.importKey("jwk", rsaJwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return { key: rsaKey, alg: alg };
  }
  throw new Error("The credential's algorithm is not one this app verifies.");
}

// An ECDSA signature from an authenticator is DER-encoded;
// WebCrypto wants the raw R||S pair. Converts, padding each
// half to the curve's size.
function derToRawEcdsa(der, size) {
  var bytes = new Uint8Array(der);
  var pos = 0;
  function fail() { throw new Error("The signature is not readable."); }
  if (bytes[pos++] !== 0x30) fail();
  var seqLen = bytes[pos++];
  if (seqLen & 0x80) {
    var nLen = seqLen & 0x7f;
    if (nLen < 1 || nLen > 2) fail();
    seqLen = 0;
    for (var i = 0; i < nLen; i++) seqLen = (seqLen << 8) | bytes[pos++];
  }
  function readInt() {
    if (bytes[pos++] !== 0x02) fail();
    var len = bytes[pos++];
    if (len & 0x80) fail();
    var value = bytes.slice(pos, pos + len);
    pos += len;
    while (value.length > 0 && value[0] === 0) value = value.slice(1);
    if (value.length > size) fail();
    var out = new Uint8Array(size);
    out.set(value, size - value.length);
    return out;
  }
  var r = readInt();
  var s = readInt();
  var raw = new Uint8Array(size * 2);
  raw.set(r, 0);
  raw.set(s, size);
  return raw;
}

async function verifySignatureWith(coseBytes, signature, data) {
  var decoded = decodeCBOR(coseBytes, 0);
  var imported = await importCoseKey(decoded.value);
  var sig = new Uint8Array(signature);
  if (imported.alg === WEBAUTHN_ALGS.ES256) {
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" },
      imported.key, derToRawEcdsa(sig, 32), data);
  }
  if (imported.alg === WEBAUTHN_ALGS.EDDSA) {
    return crypto.subtle.verify({ name: "Ed25519" }, imported.key, sig, data);
  }
  return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, imported.key, sig, data);
}

// Verifies a registration (enrolment) response. The response is
// the browser's serialized PublicKeyCredential:
// { id, rawId, type, response: { clientDataJSON, attestationObject, transports? } }
// (base64url strings). expected: { challengeB64u, origin, rpId }.
// Attestation is accepted without verification ('none' is what
// the options ask for): the credential's public key is what the
// account keeps, whatever made it.
export async function verifyRegistration(response, expected) {
  if (!response || !response.response) throw new Error("The enrolment answer is incomplete.");
  var clientDataBytes = b64uDecode(response.response.clientDataJSON || "");
  checkClientData(clientDataBytes, "webauthn.create",
    expected.challengeB64u, expected.origin);
  var attestationBytes = b64uDecode(response.response.attestationObject || "");
  var attestation = decodeCBOR(attestationBytes, 0).value;
  if (!(attestation instanceof Map)) throw new Error("The attestation is not readable.");
  var authData = parseAuthData(attestation.get("authData"));
  await checkRpAndFlags(authData, expected.rpId);
  if (!authData.attested) throw new Error("The enrolment carries no credential data.");
  // The key must import before it is stored: an algorithm this
  // app cannot verify is refused at enrolment (appendix C).
  await importCoseKey(authData.attested.cosePublicKey);
  var credentialId = b64uEncode(authData.attested.credentialId);
  if (response.id && response.id !== credentialId) {
    throw new Error("The credential id does not match its data.");
  }
  return {
    credentialId: credentialId,
    coseBytes: authData.attested.coseBytes,
    signCount: authData.signCount,
    backedUp: authData.backedUp,
    transports: Array.isArray(response.response.transports)
      ? response.response.transports.join(",") : "",
  };
}

// Verifies an assertion (sign-in or step-up) response against
// the stored credential row. expected: { challengeB64u, origin,
// rpId, userHandle } — the account's stored random handle; a
// returned handle that is present and different is a refusal.
// Answers the presented signature counter; the caller records
// the maximum and never refuses on it.
export async function verifyAssertion(response, passkeyRow, expected) {
  if (!response || !response.response) throw new Error("The sign-in answer is incomplete.");
  var clientDataBytes = b64uDecode(response.response.clientDataJSON || "");
  checkClientData(clientDataBytes, "webauthn.get",
    expected.challengeB64u, expected.origin);
  var authDataBytes = b64uDecode(response.response.authenticatorData || "");
  var authData = parseAuthData(authDataBytes);
  await checkRpAndFlags(authData, expected.rpId);
  var returnedHandle = response.response.userHandle;
  if (returnedHandle) {
    var handleBytes = b64uDecode(returnedHandle);
    if (!bytesEqual(handleBytes, b64uDecode(expected.userHandle || ""))) {
      throw new Error("The answer names a different account than the credential's.");
    }
  }
  var clientHash = await sha256Bytes(clientDataBytes);
  var signed = new Uint8Array(authDataBytes.length + clientHash.length);
  signed.set(new Uint8Array(authDataBytes), 0);
  signed.set(clientHash, authDataBytes.length);
  var signature = b64uDecode(response.response.signature || "");
  var ok = await verifySignatureWith(b64uDecode(passkeyRow.public_key), signature, signed);
  if (!ok) throw new Error("The signature does not verify.");
  return { signCount: authData.signCount };
}

// --- The store: accounts, invites, passkeys, challenges, sessions ---------------
//
// Every function takes the auth store (the D1-shaped adapter)
// first. Timestamps are milliseconds since the epoch, as
// integers: the arithmetic the throttle and the expiries do is
// plainer in one unit, and both runtimes read them the same.

export var INVITE_MS = 7 * 24 * 60 * 60 * 1000; // seven days
export var SESSION_MS = 30 * 24 * 60 * 60 * 1000; // thirty days
export var CHALLENGE_MS = 5 * 60 * 1000; // five minutes
export var PROOF_FRESH_MS = 10 * 60 * 1000; // the step-up window

// --- Accounts ---

export async function getAccount(authDb, key) {
  if (!key) return null;
  return authDb.prepare("SELECT * FROM accounts WHERE key = ?").bind(key).first();
}

// Renames an account (issue #131): the account's key IS its
// sign-in name in key form, and the passkey, session,
// challenge and invite rows all point at the account by
// that key — so a rename re-keys every one of them in the
// same act, and the name is then true everywhere at once:
// the sign-in list, the Admin roster and every account
// read. An account whose stored name and sign-in name had
// already drifted apart (a rename from before this fix)
// heals the same way: the rename compares against the
// account's own name, so saving the name the person goes by
// re-keys the account to it. Answers false, having written
// nothing, when another account already holds the new name.
export async function renameAccount(authDb, account, newName) {
  var display = String(newName || "").trim();
  var newKey = nameKey(display);
  if (newKey === account.key) {
    if (display !== account.name) {
      await authDb.prepare("UPDATE accounts SET name = ? WHERE key = ?")
        .bind(display, account.key).run();
    }
    return true;
  }
  if (await getAccount(authDb, newKey)) return false;
  var oldKey = account.key;
  await authDb.prepare("UPDATE passkeys SET account_key = ? WHERE account_key = ?")
    .bind(newKey, oldKey).run();
  await authDb.prepare("UPDATE sessions SET account_key = ? WHERE account_key = ?")
    .bind(newKey, oldKey).run();
  await authDb.prepare("UPDATE auth_challenges SET account_key = ? WHERE account_key = ?")
    .bind(newKey, oldKey).run();
  await authDb.prepare("UPDATE invites SET key = ? WHERE key = ?")
    .bind(newKey, oldKey).run();
  await authDb.prepare("UPDATE accounts SET key = ?, name = ? WHERE key = ?")
    .bind(newKey, display, oldKey).run();
  return true;
}

export async function listAccounts(authDb) {
  var result = await authDb.prepare("SELECT * FROM accounts ORDER BY name").all();
  return result.results;
}

export async function countAccounts(authDb) {
  var row = await authDb.prepare("SELECT COUNT(*) AS n FROM accounts").first();
  return Number((row && row.n) || 0);
}

export async function countAdmins(authDb) {
  var row = await authDb.prepare("SELECT COUNT(*) AS n FROM accounts WHERE admin <> 0").first();
  return Number((row && row.n) || 0);
}

// Makes an account row. The password hash must already be in
// its stored form. The WebAuthn user handle is minted here:
// a random value the authenticators carry, never the person's
// sign-in name. The one exception is the passkey-first spend
// (amendment A.6): its ceremony runs before the account
// exists, so the handle is minted at the ceremony's issuance
// and carried in the challenge's payload record, and the
// account is created under that handle as given — fields
// .userHandle, on that one path only.
export async function createAccount(authDb, fields) {
  var stamp = nowMs();
  await authDb.prepare(
    "INSERT INTO accounts (key, id, name, password_hash, admin, owner_id, user_handle, created_at, email) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    fields.key, newAccountId(), fields.name, fields.passwordHash || null,
    fields.admin ? 1 : 0, fields.ownerId || null,
    fields.userHandle || b64uEncode(randomBytes(32)), stamp,
    fields.email ? emailKey(fields.email) : null
  ).run();
  return getAccount(authDb, fields.key);
}

// --- Email addresses ---
// The hosted copy's sign-in turns on one address per
// account, carried on the account row. An address is folded
// the one way — trimmed and lowered — everywhere it is read
// or written, so the fold is the comparison. emailProblem
// judges the shape an address must have to be written at
// all: the loose shape of an address, nothing stricter —
// the proof an address is real is never its spelling but
// the link round-trip it answers.

export function emailKey(email) {
  return String(email || "").trim().toLowerCase();
}

export function emailProblem(email) {
  var folded = emailKey(email);
  if (!folded || folded.length > 254) return true;
  return !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(folded);
}

export async function getAccountByEmail(authDb, email) {
  var folded = emailKey(email);
  if (!folded) return null;
  return authDb.prepare("SELECT * FROM accounts WHERE email = ?").bind(folded).first();
}

// While accounts stand, one of them is the administrator: if
// accounts stand and none is flagged, the earliest account
// standing takes the flag. That covers a data file carried
// over from a setup whose accounts predate the flag, and an
// install grown through recovery-minted invites alone. The
// guards then keep at least one administrator among standing
// accounts.
export async function ensureAdminStanding(authDb) {
  var any = await countAccounts(authDb);
  if (!any) return;
  if ((await countAdmins(authDb)) > 0) return;
  var earliest = await authDb.prepare(
    "SELECT key FROM accounts ORDER BY created_at, rowid LIMIT 1"
  ).first();
  if (earliest) {
    await authDb.prepare("UPDATE accounts SET admin = 1 WHERE key = ?")
      .bind(earliest.key).run();
  }
}

// The only-administrator guard, in the words the product
// already uses: the only administrator cannot be removed,
// unflagged or self-erased while other accounts stand, and the
// refusal names the way out.
export var ONLY_ADMIN_MESSAGE =
  "This account is the only administrator, and other accounts stand. " +
  "Make another person an administrator first.";

export async function onlyAdminBlocked(authDb, account) {
  return !!account && !!account.admin &&
    (await countAdmins(authDb)) <= 1 && (await countAccounts(authDb)) > 1;
}

// --- Invites ---
// An invite rests only as the SHA-256 hash of a 24-byte random
// code, carries a name and nothing else, and lives seven days.
// Looking at its page never spends it; the spend is one
// conditional update a second press cannot also win.

export async function mintInvite(authDb, name) {
  var display = String(name || "").trim();
  var key = nameKey(display);
  var code = b64uEncode(randomBytes(24));
  var codeHash = await sha256Hex(code);
  var stamp = nowMs();
  // A fresh invite for a name retires that name's earlier
  // unused ones, as the product has always done.
  await authDb.prepare("DELETE FROM invites WHERE key = ? AND used_at IS NULL")
    .bind(key).run();
  await authDb.prepare(
    "INSERT INTO invites (code_hash, key, name, created, expires, used_at) VALUES (?, ?, ?, ?, ?, NULL)"
  ).bind(codeHash, key, display, stamp, stamp + INVITE_MS).run();
  return { code: code, name: display, key: key, expires: stamp + INVITE_MS };
}

export async function findInvite(authDb, code) {
  if (!code) return null;
  var codeHash = await sha256Hex(code);
  return authDb.prepare("SELECT * FROM invites WHERE code_hash = ?")
    .bind(codeHash).first();
}

export function inviteUsable(row) {
  return !!row && !row.used_at && Number(row.expires) > nowMs();
}

// Spends the invite in one conditional update. Answers true
// when this press won the spend; a second press gets false.
export async function spendInvite(authDb, code) {
  var codeHash = await sha256Hex(code);
  var result = await authDb.prepare(
    "UPDATE invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires > ?"
  ).bind(nowMs(), codeHash, nowMs()).run();
  return !!(result && result.meta && Number(result.meta.changes) === 1);
}

// Hands a spend back when the act it guarded failed after the
// mark was taken (the name was won by another spend in the same
// moment): the invite stands unspent again, as if refused.
export async function unspendInvite(authDb, code) {
  var codeHash = await sha256Hex(code);
  await authDb.prepare("UPDATE invites SET used_at = NULL WHERE code_hash = ?")
    .bind(codeHash).run();
}

// --- Emailed sign-in links ---
// The hosted copy's way in: a person asks for a link, the
// service emails it, and spending it signs them in — or, when
// no account stands for the address, makes the account, so
// joining and signing in are one act and recovery is the same
// act again. A link rests only as the SHA-256 hash of a
// 24-byte random code, carries the folded address it was sent
// to, and lives fifteen minutes. One live link per address:
// minting a fresh one retires the address's earlier unused
// ones, as a fresh invite retires a name's.

export var EMAIL_LINK_MS = 15 * 60 * 1000; // fifteen minutes

export async function mintEmailLink(authDb, email) {
  var folded = emailKey(email);
  var code = b64uEncode(randomBytes(24));
  var codeHash = await sha256Hex(code);
  var stamp = nowMs();
  await authDb.prepare("DELETE FROM email_links WHERE email = ? AND used_at IS NULL")
    .bind(folded).run();
  await authDb.prepare(
    "INSERT INTO email_links (code_hash, email, created, expires, used_at) VALUES (?, ?, ?, ?, NULL)"
  ).bind(codeHash, folded, stamp, stamp + EMAIL_LINK_MS).run();
  return { code: code, codeHash: codeHash, email: folded, expires: stamp + EMAIL_LINK_MS };
}

export async function findEmailLink(authDb, code) {
  if (!code) return null;
  var codeHash = await sha256Hex(code);
  return authDb.prepare("SELECT * FROM email_links WHERE code_hash = ?")
    .bind(codeHash).first();
}

export function emailLinkUsable(row) {
  return !!row && !row.used_at && Number(row.expires) > nowMs();
}

// Spends the link in one conditional update, the invite
// discipline: a second press cannot also win.
export async function spendEmailLink(authDb, code) {
  var codeHash = await sha256Hex(code);
  var result = await authDb.prepare(
    "UPDATE email_links SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires > ?"
  ).bind(nowMs(), codeHash, nowMs()).run();
  return !!(result && result.meta && Number(result.meta.changes) === 1);
}

// Hands a spend back when the act it guarded failed after
// the mark was taken: the link stands unspent again.
export async function unspendEmailLink(authDb, code) {
  var codeHash = await sha256Hex(code);
  await authDb.prepare("UPDATE email_links SET used_at = NULL WHERE code_hash = ?")
    .bind(codeHash).run();
}

// --- The link requests' pace ---
// Link requests are counted apart from the sign-in throttle,
// in the creation pace's window shape: a count per watched
// key inside its own window, spent by the request itself. A
// source address may ask sixty times in an hour; one email
// address may be asked for five times in an hour and ten
// times in a day, so no inbox can be flooded through this
// page — not from one address, and not from many at once.
// The passkey stays the standing way in all the while; the
// link is the way back, and its pace is priced for that.

export var LINK_SOURCE_MAX = 60;
export var LINK_EMAIL_HOUR_MAX = 5;
export var LINK_EMAIL_DAY_MAX = 10;
export var LINK_HOUR_MS = 60 * 60 * 1000;
export var LINK_DAY_MS = 24 * 60 * 60 * 1000;

async function linkRequestCount(authDb, key, windowMs) {
  var row = await authDb.prepare(
    "SELECT * FROM link_requests WHERE key = ?"
  ).bind(key).first();
  if (!row) return 0;
  if (nowMs() - Number(row.window_start) >= windowMs) return 0;
  return Number(row.attempts) || 0;
}

async function noteLinkRequestKey(authDb, key, windowMs) {
  var stamp = nowMs();
  var row = await authDb.prepare(
    "SELECT * FROM link_requests WHERE key = ?"
  ).bind(key).first();
  if (!row || stamp - Number(row.window_start) >= windowMs) {
    await authDb.prepare(
      "INSERT INTO link_requests (key, window_start, attempts) VALUES (?, ?, 1) " +
      "ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, attempts = 1"
    ).bind(key, stamp).run();
    return;
  }
  await authDb.prepare(
    "UPDATE link_requests SET attempts = attempts + 1 WHERE key = ?"
  ).bind(key).run();
}

// True when any of the request's three counts already stands
// at its cap: the ask is answered the same and nothing sends.
export async function linkPaceCapped(authDb, source, email) {
  if ((await linkRequestCount(authDb, "src:" + source, LINK_HOUR_MS)) >= LINK_SOURCE_MAX) {
    return true;
  }
  if ((await linkRequestCount(authDb, "em:" + email, LINK_HOUR_MS)) >= LINK_EMAIL_HOUR_MAX) {
    return true;
  }
  if ((await linkRequestCount(authDb, "emd:" + email, LINK_DAY_MS)) >= LINK_EMAIL_DAY_MAX) {
    return true;
  }
  return false;
}

export async function noteLinkRequest(authDb, source, email) {
  await noteLinkRequestKey(authDb, "src:" + source, LINK_HOUR_MS);
  await noteLinkRequestKey(authDb, "em:" + email, LINK_HOUR_MS);
  await noteLinkRequestKey(authDb, "emd:" + email, LINK_DAY_MS);
}

// --- Passkeys ---

export async function listPasskeys(authDb, accountKey) {
  var result = await authDb.prepare(
    "SELECT * FROM passkeys WHERE account_key = ? ORDER BY created_at, rowid"
  ).bind(accountKey).all();
  return result.results;
}

export async function countPasskeys(authDb, accountKey) {
  var row = await authDb.prepare(
    "SELECT COUNT(*) AS n, MAX(created_at) AS last_at FROM passkeys WHERE account_key = ?"
  ).bind(accountKey).first();
  return { count: Number((row && row.n) || 0), lastAt: row ? row.last_at : null };
}

// The canonical form of a credential id: the id's bytes,
// re-encoded as unpadded base64url — the form enrolment
// stores. A client that sends the id padded (or in the
// standard alphabet) names the same credential; normalizing
// before the lookup means padding alone can never refuse a
// sign-in (the fragility issue #111's root cause recorded).
// An id that does not decode answers null, and the lookup
// refuses it the plain way.
export function normalizeCredentialId(credentialId) {
  try {
    return b64uEncode(b64uDecode(String(credentialId || "")));
  } catch (e) {
    return null;
  }
}

export async function getPasskey(authDb, credentialId) {
  if (!credentialId) return null;
  var canonical = normalizeCredentialId(credentialId);
  if (canonical === null) return null;
  return authDb.prepare("SELECT * FROM passkeys WHERE credential_id = ?")
    .bind(canonical).first();
}

export async function addPasskey(authDb, fields) {
  await authDb.prepare(
    "INSERT INTO passkeys (credential_id, account_key, public_key, sign_count, transports, " +
    "backed_up, nickname, rp_home, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)"
  ).bind(
    fields.credentialId, fields.accountKey, b64uEncode(fields.coseBytes),
    Number(fields.signCount) || 0, fields.transports || "",
    fields.backedUp ? 1 : 0, fields.nickname || "", fields.rpHome || "", nowMs()
  ).run();
}

export async function removePasskey(authDb, credentialId, accountKey) {
  var sql = "DELETE FROM passkeys WHERE credential_id = ?";
  var binds = [credentialId];
  if (accountKey) { sql += " AND account_key = ?"; binds.push(accountKey); }
  var stmt = authDb.prepare(sql);
  var result = await stmt.bind(...binds).run();
  return !!(result && result.meta && Number(result.meta.changes) === 1);
}

// Records an assertion's counter: the stored value rises to
// the highest seen and is kept as a record. A counter that
// stands still or steps back is never a refusal (design
// section 4: synced passkeys legitimately report zero forever).
export async function notePasskeyUse(authDb, credentialId, signCount) {
  await authDb.prepare(
    "UPDATE passkeys SET sign_count = MAX(sign_count, ?), last_used_at = ? WHERE credential_id = ?"
  ).bind(Number(signCount) || 0, nowMs(), credentialId).run();
}

// --- Challenges ---
// A challenge is 32 random bytes, held by its hash, with its
// kind, the account it belongs to when one is known, a
// five-minute expiry and a used stamp. A spend ceremony's
// challenge also carries a payload — the pending record of
// amendment A.6 (the handle minted for the spend, the invite
// or setup attempt it answers to, the name as the page gave
// it) — in the row's one nullable payload column; every other
// kind leaves it NULL. Spending is one
// conditional update — the invite discipline — and a spent,
// expired or unknown challenge is one refusal. Issuance writes
// exactly one row (the design's write budget, section 7).

export async function issueChallenge(authDb, kind, accountKey, payload) {
  var challenge = randomBytes(32);
  var challengeHash = await sha256Hex(challenge);
  var stamp = nowMs();
  await authDb.prepare(
    "INSERT INTO auth_challenges (id, challenge_hash, kind, account_key, expires, used_at, payload) " +
    "VALUES (?, ?, ?, ?, ?, NULL, ?)"
  ).bind(
    "chal-" + crypto.randomUUID(), challengeHash, kind,
    accountKey || null, stamp + CHALLENGE_MS,
    payload ? JSON.stringify(payload) : null
  ).run();
  return { challengeB64u: b64uEncode(challenge) };
}

// Reads a challenge row back without spending it — the
// passkey-first spend's verify reads its pending record (the
// payload the issuance stored) before it decides to spend.
// Answers the row, or null when the challenge is unknown,
// spent or expired: the same refusals the spend itself gives,
// read-only.
export async function findChallenge(authDb, challengeB64u, kind, accountKey) {
  var challenge;
  try { challenge = b64uDecode(challengeB64u || ""); } catch (e) { return null; }
  if (challenge.length !== 32) return null;
  var challengeHash = await sha256Hex(challenge);
  var sql = "SELECT * FROM auth_challenges WHERE challenge_hash = ? AND kind = ? " +
    "AND used_at IS NULL AND expires > ?";
  var binds = [challengeHash, kind, nowMs()];
  if (accountKey) { sql += " AND account_key = ?"; binds.push(accountKey); }
  else { sql += " AND account_key IS NULL"; }
  var row = await authDb.prepare(sql).bind(...binds).first();
  if (!row) return null;
  var payload = null;
  if (row.payload) {
    try { payload = JSON.parse(row.payload); } catch (e) { payload = null; }
  }
  return { row: row, payload: payload };
}

// Spends the challenge the client data names, atomically.
// For a discoverable sign-in the challenge was issued with no
// account; the spend then accepts the row whatever account the
// credential turns out to belong to, and the caller binds the
// answer to that account through the credential and its user
// handle. For enrolment and step-up the challenge names its
// account and the spend requires it.
export async function spendChallenge(authDb, challengeB64u, kind, accountKey) {
  var challenge;
  try { challenge = b64uDecode(challengeB64u || ""); } catch (e) { return false; }
  if (challenge.length !== 32) return false;
  var challengeHash = await sha256Hex(challenge);
  var sql = "UPDATE auth_challenges SET used_at = ? WHERE challenge_hash = ? AND kind = ? " +
    "AND used_at IS NULL AND expires > ?";
  var binds = [nowMs(), challengeHash, kind, nowMs()];
  if (accountKey) { sql += " AND account_key = ?"; binds.push(accountKey); }
  else { sql += " AND account_key IS NULL"; }
  var stmt = authDb.prepare(sql);
  var result = await stmt.bind(...binds).run();
  return !!(result && result.meta && Number(result.meta.changes) === 1);
}

// --- Sessions ---
// A session is a row: a random token of 32 bytes (only its
// SHA-256 hash is stored), the account, when it was made, when
// it was last seen, when it expires, when its last full proof
// was and what kind that proof was, and how it began. The
// cookie carries the token and nothing else.

export var SESSION_COOKIE = "ts_session";

export async function createSession(authDb, accountKey, via, proofVia) {
  var token = b64uEncode(randomBytes(32));
  var tokenHash = await sha256Hex(token);
  var stamp = nowMs();
  await authDb.prepare(
    "INSERT INTO sessions (token_hash, account_key, created_at, last_seen_at, expires_at, proof_at, proof_via, via) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(tokenHash, accountKey, stamp, stamp, stamp + SESSION_MS, stamp,
    proofVia || via, via).run();
  return { token: token, tokenHash: tokenHash };
}

export async function sessionByToken(authDb, token) {
  if (!token) return null;
  var tokenHash = await sha256Hex(token);
  var row = await authDb.prepare("SELECT * FROM sessions WHERE token_hash = ?")
    .bind(tokenHash).first();
  if (!row) return null;
  if (Number(row.expires_at) <= nowMs()) {
    // Expired rows are deleted on encounter (the budget's
    // cleanup rule), so the table holds only live sessions.
    await authDb.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(tokenHash).run();
    return null;
  }
  return row;
}

// Stamps last-seen at most hourly, so an active session is not
// a write per request.
export async function touchSession(authDb, row) {
  var stamp = nowMs();
  if (stamp - Number(row.last_seen_at || 0) < 60 * 60 * 1000) return;
  await authDb.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
    .bind(stamp, row.token_hash).run();
}

// Rotates the session's token: the old row goes, a fresh token
// stands in its place with the same birth and a proof stamped
// now. Rotation happens at every privilege change — a password
// change, a passkey enrolment, an administrator flag change —
// so a stolen token has a short useful life after any security
// event on the account.
export async function rotateSession(authDb, row, proofVia) {
  var token = b64uEncode(randomBytes(32));
  var tokenHash = await sha256Hex(token);
  var stamp = nowMs();
  await authDb.prepare(
    "INSERT INTO sessions (token_hash, account_key, created_at, last_seen_at, expires_at, proof_at, proof_via, via) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    tokenHash, row.account_key, Number(row.created_at) || stamp, stamp,
    stamp + SESSION_MS, stamp, proofVia || row.proof_via || row.via, row.via
  ).run();
  await authDb.prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(row.token_hash).run();
  return { token: token, tokenHash: tokenHash };
}

// Stamps a fresh full proof on the standing session (the
// step-up endpoints' whole act) and rotates its token with it:
// a proof is a privilege event.
export async function stampProof(authDb, row, proofVia) {
  return rotateSession(authDb, row, proofVia);
}

export async function revokeSession(authDb, tokenHash) {
  await authDb.prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(tokenHash).run();
}

// Revokes every session an account holds, except the one named
// (the changer's own, on a password change; nobody's, on a
// reset or an administrator's sign-out-everywhere).
export async function revokeAccountSessions(authDb, accountKey, exceptTokenHash) {
  if (exceptTokenHash) {
    await authDb.prepare(
      "DELETE FROM sessions WHERE account_key = ? AND token_hash <> ?"
    ).bind(accountKey, exceptTokenHash).run();
  } else {
    await authDb.prepare("DELETE FROM sessions WHERE account_key = ?")
      .bind(accountKey).run();
  }
}

// Reads the session a request carries, from its cookie. The
// cookie's name is the one both homes use.
export function sessionTokenFromRequest(request) {
  var header = request.headers.get("Cookie") || "";
  var pairs = header.split(";");
  for (var i = 0; i < pairs.length; i++) {
    var trimmed = pairs[i].trim();
    if (trimmed.indexOf(SESSION_COOKIE + "=") === 0) {
      var value = trimmed.slice(SESSION_COOKIE.length + 1);
      try { return decodeURIComponent(value); } catch (e) { return value; }
    }
  }
  return null;
}

export async function sessionFromRequest(authDb, request) {
  var token = sessionTokenFromRequest(request);
  if (!token) return null;
  var row = await sessionByToken(authDb, token);
  if (!row) return null;
  var account = await getAccount(authDb, row.account_key);
  if (!account) {
    await revokeSession(authDb, row.token_hash);
    return null;
  }
  return { session: row, account: account, token: token };
}

// The Set-Cookie value that stands a session up, in the shape
// both homes use: HttpOnly, SameSite=Lax, Path=/, thirty days.
// Secure rides when the caller says the request arrived over
// HTTPS — always on the hosted copy; on a home copy, when it
// did (a Secure cookie over plain HTTP would never come back,
// and the household could not sign in at all).
export function sessionCookieValue(token, secure) {
  var value = SESSION_COOKIE + "=" + token + "; Path=/; Max-Age=" +
    Math.floor(SESSION_MS / 1000) + "; HttpOnly; SameSite=Lax";
  if (secure) value += "; Secure";
  return value;
}

export function expiredSessionCookieValue(secure) {
  var value = SESSION_COOKIE + "=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax";
  if (secure) value += "; Secure";
  return value;
}

// --- The remembered name (issue #112) ------------------------------------------
//
// After a successful sign-in the door stands a second, far
// longer cookie on the device: the person's sign-in name,
// nothing more. The sign-in page reads it back and fills the
// name in — typed into the hosted page's field, pre-picked on
// the home page's list — so the page never opens blank for a
// person it knows. The cookie is NOT HttpOnly, on purpose:
// the sign-in page's own script clears it the moment the
// person unticks "Remember my name on this device", before
// anything is submitted. It is not a credential and proves
// nothing: on a home copy the name stands in the page's list
// in the open anyway.
export var REMEMBER_COOKIE = "ts_name";
export var REMEMBER_MS = 365 * 24 * 60 * 60 * 1000; // a year

function cookieValueFromRequest(request, name) {
  var header = request.headers.get("Cookie") || "";
  var pairs = header.split(";");
  for (var i = 0; i < pairs.length; i++) {
    var trimmed = pairs[i].trim();
    if (trimmed.indexOf(name + "=") === 0) {
      var value = trimmed.slice(name.length + 1);
      try { return decodeURIComponent(value); } catch (e) { return value; }
    }
  }
  return null;
}

export function rememberedNameFromRequest(request) {
  return cookieValueFromRequest(request, REMEMBER_COOKIE);
}

export function rememberedNameCookieValue(name, secure) {
  var value = REMEMBER_COOKIE + "=" + encodeURIComponent(String(name || "")) +
    "; Path=/; Max-Age=" + Math.floor(REMEMBER_MS / 1000) + "; SameSite=Lax";
  if (secure) value += "; Secure";
  return value;
}

export function expiredRememberedNameCookieValue(secure) {
  var value = REMEMBER_COOKIE + "=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; SameSite=Lax";
  if (secure) value += "; Secure";
  return value;
}

// --- The remembered sign-in view (issue #122, amendment A.8) -------------------
//
// Beside the remembered name's cookie stands a second one of
// the same shape — same lifetime, same flags — recording
// which of the sign-in page's two views this device last
// used: "passkey" or "password". The page's own script writes
// it when the person flips the switch, the way it clears the
// remembered name on an untick; a successful passkey
// enrolment writes it too, server-side, at the spend and in
// the app (issue #141). The server otherwise only reads it,
// and a device holding neither cookie opens on the passkey
// view.
// It is a convenience on a device, never a credential, and it
// says nothing about what any account holds.
export var VIEW_COOKIE = "ts_view";

export function rememberedViewFromRequest(request) {
  return cookieValueFromRequest(request, VIEW_COOKIE) === "password"
    ? "password" : "passkey";
}

// The Set-Cookie value that stands a remembered view up, in
// the same shape the page's own script writes when the
// person flips the switch — a year, Path=/, SameSite=Lax,
// Secure over HTTPS. The enrolment acts write it server-side
// (issue #141): a person who has just given a device a
// passkey has made the newest choice that device knows, so
// the passkey becomes its sign-in view.
export function viewCookieValue(view, secure) {
  var value = VIEW_COOKIE + "=" + view + "; Path=/; Max-Age=31536000; SameSite=Lax";
  if (secure) value += "; Secure";
  return value;
}

// --- The attempted name (issue #143) ------------------------------------------
//
// A failed sign-in used to hand the page back with the name
// field empty: the password clears (rightly), and the name
// went with it unless the device remembered it. The failure
// redirect now carries the typed name in a one-shot cookie —
// ten minutes, HttpOnly, read by no script — and the sign-in
// page stands it in the field (or pre-picks it on the list)
// for that one rendering and expires the cookie in the same
// answer. It is not the remembered name: a failed sign-in
// moves the remembered name neither way (issue #112's rule),
// and this cookie never survives the page it was carried to.
export var ATTEMPT_COOKIE = "ts_attempt";
export var ATTEMPT_MS = 10 * 60 * 1000;

export function attemptedNameFromRequest(request) {
  return cookieValueFromRequest(request, ATTEMPT_COOKIE);
}

export function attemptCookieValue(name, secure) {
  var value = ATTEMPT_COOKIE + "=" + encodeURIComponent(String(name || "")) +
    "; Path=/; Max-Age=" + Math.floor(ATTEMPT_MS / 1000) + "; HttpOnly; SameSite=Lax";
  if (secure) value += "; Secure";
  return value;
}

export function expiredAttemptCookieValue(secure) {
  var value = ATTEMPT_COOKIE + "=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax";
  if (secure) value += "; Secure";
  return value;
}

// --- The audit trail ---
// Rows name accounts only by their opaque accounts.id, never
// by sign-in name, and detail never carries a name, a board
// title or any credential material. Names are resolved at read
// time, from accounts that still stand; an id whose account is
// gone reads as "a removed account". Erasure deletes the
// account's credential rows in the act and never edits audit
// rows, so the id-to-name mapping dies with the account row
// and the tombstones that remain name nobody.

export async function writeAudit(authDb, actorAccount, act, targetAccount, detail) {
  await authDb.prepare(
    "INSERT INTO auth_audit (id, at, actor_id, act, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(
    "audit-" + crypto.randomUUID(), nowMs(),
    actorAccount ? actorAccount.id : null, act,
    targetAccount ? targetAccount.id : null, detail || ""
  ).run();
}

export async function recentAudit(authDb, limit) {
  var result = await authDb.prepare(
    "SELECT * FROM auth_audit ORDER BY at DESC, rowid DESC LIMIT ?"
  ).bind(Math.max(1, Math.min(200, Number(limit) || 50))).all();
  return result.results;
}

// --- Throttling ---
// One scheme, both copies (design section 7). Per source
// address: five failures start a lockout — 10 seconds, doubling
// on each new lockout, to a ceiling the home sets (fifteen
// minutes hosted; one minute at home, where the source may be
// the household's own gateway). Per source-and-account pair:
// three failures start the same doubling lockouts for that
// pair, ceiling fifteen minutes everywhere — the curve that
// still aims behind a gateway. Never an account-wide lock: no
// count of failures, from anywhere, ever disables an account
// as such. A success clears the address's and the pair's rows.
//
// The write budget is structural here: checking a lock is a
// read and writes nothing; a failure upserts at most the two
// rows (source and pair); a refusal under a standing lock is
// answered from the check alone, so a locked source cannot
// keep spending writes by knocking.

export var THROTTLE_SOURCE_THRESHOLD = 5;
export var THROTTLE_PAIR_THRESHOLD = 3;
export var THROTTLE_FIRST_LOCK_MS = 10 * 1000;
export var THROTTLE_PAIR_CAP_MS = 15 * 60 * 1000;

function lockMs(lockouts, capMs) {
  var ms = THROTTLE_FIRST_LOCK_MS * Math.pow(2, Math.max(0, lockouts - 1));
  return Math.min(capMs, ms);
}

async function throttleRow(authDb, scope, key) {
  return authDb.prepare(
    "SELECT * FROM auth_throttle WHERE scope = ? AND key = ?"
  ).bind(scope, key).first();
}

// Read-only: is this source (or this source-and-account pair)
// standing locked right now?
export async function throttleLocked(authDb, source, accountKey) {
  var stamp = nowMs();
  var sourceRow = await throttleRow(authDb, "source", source);
  if (sourceRow && Number(sourceRow.locked_until) > stamp) return true;
  if (accountKey) {
    var pairRow = await throttleRow(authDb, "pair", source + "\n" + accountKey);
    if (pairRow && Number(pairRow.locked_until) > stamp) return true;
  }
  return false;
}

async function noteFailureRow(authDb, scope, key, threshold, capMs) {
  var stamp = nowMs();
  var row = await throttleRow(authDb, scope, key);
  // A failure counted while a lock stands should not happen —
  // callers check first and refuse read-only — but if one
  // arrives, it does not extend the lock or spend more than
  // the one row it already has.
  if (row && Number(row.locked_until) > stamp) return;
  var failures = (row ? Number(row.failures) || 0 : 0) + 1;
  var lockouts = row ? Number(row.lockouts) || 0 : 0;
  var lockedUntil = row ? Number(row.locked_until) || 0 : 0;
  if (failures >= threshold) {
    failures = 0;
    lockouts += 1;
    lockedUntil = stamp + lockMs(lockouts, capMs);
  }
  await authDb.prepare(
    "INSERT INTO auth_throttle (scope, key, failures, lockouts, locked_until) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(scope, key) DO UPDATE SET failures = excluded.failures, " +
    "lockouts = excluded.lockouts, locked_until = excluded.locked_until"
  ).bind(scope, key, failures, lockouts, lockedUntil).run();
}

// Counts one failure against the source and, when an account
// is named, against the pair. Two row writes at most.
export async function noteThrottleFailure(authDb, source, accountKey, sourceCapMs) {
  await noteFailureRow(authDb, "source", source, THROTTLE_SOURCE_THRESHOLD, sourceCapMs);
  if (accountKey) {
    await noteFailureRow(authDb, "pair", source + "\n" + accountKey,
      THROTTLE_PAIR_THRESHOLD, THROTTLE_PAIR_CAP_MS);
  }
}

// A success clears the address's record and the pair's — the
// two deletes are half of the sign-in success's write budget.
export async function clearThrottle(authDb, source, accountKey) {
  await authDb.prepare("DELETE FROM auth_throttle WHERE scope = 'source' AND key = ?")
    .bind(source).run();
  if (accountKey) {
    await authDb.prepare("DELETE FROM auth_throttle WHERE scope = 'pair' AND key = ?")
      .bind(source + "\n" + accountKey).run();
  }
}

// --- The joining switch and its gates ---
// Whether a stranger may join stands in the auth store's own
// bookkeeping (auth_meta, key 'door'), read on every request
// that could lead to an account, so the operator flips it
// with one stored value and no redeploy: 1 open, 2 closed,
// and 0 — or no row at all — invite-only, the default on
// every copy. The switch governs joining only: signing in is
// never gated by it, and invites keep working in every state,
// exactly as they always have.

export var DOOR_INVITE_ONLY = 0;
export var DOOR_OPEN = 1;
export var DOOR_CLOSED = 2;

export async function doorState(authDb) {
  var row = await authDb.prepare(
    "SELECT value FROM auth_meta WHERE key = 'door'"
  ).first();
  var value = row ? Number(row.value) : DOOR_INVITE_ONLY;
  return value === DOOR_OPEN || value === DOOR_CLOSED ? value : DOOR_INVITE_ONLY;
}

// The country gate, read from the deployment's own seam
// (cfg.signupCountries names the countries joining is open
// to; cfg.countryOf reads the request's country as the
// deployment's edge reports it). No list stands, no gate
// stands. The gate judges joining only — never sign-in.
export function countryAllowed(cfg, request) {
  if (!cfg.signupCountries || !cfg.signupCountries.length) return true;
  var country = cfg.countryOf ? cfg.countryOf(request) : null;
  if (!country) return false;
  return cfg.signupCountries.indexOf(String(country).toUpperCase()) !== -1;
}

// The country gate's sentence, built from this copy's own
// list: the ruled words on the hosted copy, and the true
// words on any other list.
export function countryLine(cfg) {
  var names = (cfg.signupCountries || []).map(function (code) {
    if (code === "CA") return "Canada";
    if (code === "US") return "the United States";
    return code;
  });
  var list = names.length > 1
    ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1]
    : (names[0] || "");
  return "Joining is open to " + list + " for now.";
}

// --- The cleanup sweep ---
// Expired challenge, throttle and session rows are deleted on
// encounter where a lookup meets its own; the rest are kept
// from accumulating by this bounded sweep: piggybacked on an
// auth request at most once an hour (its stamp is one meta
// row), deleting at most 500 expired rows per run. Nothing in
// the auth tables grows without an expiry and a named deleter.

export async function sweepAuth(authDb) {
  var stamp = nowMs();
  var meta = await authDb.prepare(
    "SELECT value FROM auth_meta WHERE key = 'sweep_at'"
  ).first();
  if (meta && stamp - Number(meta.value || 0) < 60 * 60 * 1000) return false;
  await authDb.prepare(
    "INSERT INTO auth_meta (key, value) VALUES ('sweep_at', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(stamp).run();
  var budget = 500;
  var tables = [
    ["auth_challenges", "expires"],
    ["sessions", "expires_at"],
    ["auth_throttle", "locked_until"],
    ["email_links", "expires"],
    ["link_requests", "window_start"],
  ];
  for (var i = 0; i < tables.length && budget > 0; i++) {
    // Throttle rows whose lock has passed and whose failure
    // count stands at zero carry nothing forward; a row still
    // counting failures inside its window is kept by the
    // locked_until comparison only once it has locked — rows
    // that never locked read locked_until 0 and would all be
    // swept, so the throttle sweep takes only rows whose
    // lockouts have begun and fully passed.
    var where = tables[i][0] === "auth_throttle"
      ? "locked_until > 0 AND locked_until < ?"
      : tables[i][1] + " < ?";
    // A link-pace row is dead once its longest window — the
    // email's day — has fully passed, so its sweep binds the
    // stamp a day back.
    var bindStamp = tables[i][0] === "link_requests"
      ? stamp - LINK_DAY_MS : stamp;
    var result = await authDb.prepare(
      "DELETE FROM " + tables[i][0] + " WHERE rowid IN " +
      "(SELECT rowid FROM " + tables[i][0] + " WHERE " + where + " LIMIT ?)"
    ).bind(bindStamp, budget).run();
    budget -= Number((result && result.meta && result.meta.changes) || 0);
  }
  return true;
}

// --- Erasure of one account's credentials ---
// Deletes the account's rows in the auth store: its passkeys,
// sessions, challenges and invites, and the account row
// itself. The boards' owner row is the caller's act (the core
// deletes it, or the wrapper's erasure door does), because the
// owner lives in the boards' store on the hosted copy. Audit
// rows are never edited (see the audit section above).

export async function eraseAccountCredentials(authDb, accountKey) {
  await authDb.batch([
    authDb.prepare("DELETE FROM passkeys WHERE account_key = ?").bind(accountKey),
    authDb.prepare("DELETE FROM sessions WHERE account_key = ?").bind(accountKey),
    authDb.prepare("DELETE FROM auth_challenges WHERE account_key = ?").bind(accountKey),
    authDb.prepare("DELETE FROM invites WHERE key = ?").bind(accountKey),
    authDb.prepare("DELETE FROM accounts WHERE key = ?").bind(accountKey),
  ]);
}

// --- The pages ----------------------------------------------------------------------
//
// One set of pages, both homes: sign-in, setup, invite and the
// invite refusal. The words are the ones the self-host copy
// already uses; the two homes differ only where the design's
// list says they may — the login page lists names at home and
// takes a typed name on the hosted copy, the hosted setup page
// asks for the setup code, and the "runs on a machine in your
// home" line stands only where it is true.
//
// The sign-in page also carries the passkey button — where
// the address can run a ceremony. The server knows its own
// address: at a secure one the button stands and the browser's
// feature-detect unhides it; at an ordinary HTTP address the
// page leaves the button out and prints the reason in its
// place (issue #113), and the password door carries the page,
// exactly as the design directs.

var PAGE_STYLE = [
  ":root { color-scheme: light dark; }",
  "body { font-family: system-ui, -apple-system, \"Segoe UI\", sans-serif;",
  "  margin: 0; min-height: 100vh; display: grid; place-items: center;",
  "  background: Canvas; color: CanvasText; }",
  "main { width: min(22rem, calc(100vw - 3rem)); padding: 1.5rem 0 3rem; }",
  /* The wordmark: the name at the top of these pages is set in
     Comfortaa Bold, the brand's face, from the same subset the
     app shell loads (only the letters of "TaskSparkle"; its
     licence stands beside it in /fonts/OFL.txt). The pages'
     policy below names font-src 'self' for it. */
  "@font-face { font-family: \"Comfortaa\";",
  "  src: url(\"/fonts/comfortaa-bold.woff2\") format(\"woff2\");",
  "  font-weight: 700; font-style: normal; font-display: swap; }",
  "h1 { font-family: \"Comfortaa\", system-ui, sans-serif; font-weight: 700;",
  "  font-size: 1.4rem; margin: 0 0 0.25rem; }",
  "p.sub { margin: 0 0 1.5rem; opacity: 0.75; }",
  "label.field { display: block; font-weight: 600; margin-bottom: 1rem; }",
  "fieldset.names { border: 0; padding: 0; margin: 0 0 1rem; }",
  "fieldset.names legend { font-weight: 600; margin-bottom: 0.5rem; }",
  "label.person { display: block; padding: 0.55rem 0.8rem; margin-bottom: 0.4rem;",
  "  border: 1px solid color-mix(in srgb, CanvasText 30%, transparent);",
  "  border-radius: 0.5rem; cursor: pointer; font-size: 1rem; }",
  "label.person input { margin-right: 0.5rem; }",
  "input[type=\"text\"], input[type=\"password\"] {",
  "  display: block; width: 100%; box-sizing: border-box; margin-top: 0.4rem;",
  "  padding: 0.65rem 0.8rem; font-size: 1rem; border-radius: 0.5rem;",
  "  border: 1px solid color-mix(in srgb, CanvasText 35%, transparent);",
  "  background: Canvas; color: CanvasText; font-weight: 400; }",
  "button { width: 100%; padding: 0.75rem; font-size: 1rem; font-weight: 600;",
  "  border-radius: 0.6rem; border: 0; cursor: pointer;",
  "  background: #4c7a4c; color: #fff; }",
  "button.secondary { background: transparent; color: inherit;",
  "  border: 1px solid color-mix(in srgb, CanvasText 40%, transparent); }",
  "p.error { border: 1px solid #b3261e; color: #b3261e; border-radius: 0.5rem;",
  "  padding: 0.6rem 0.8rem; margin: 0 0 1rem; }",
  "form.invite { margin-top: 2.25rem; border-top: 1px solid color-mix(in srgb, CanvasText 25%, transparent); padding-top: 1.25rem; }",
  "p.note { margin: 1rem 0 0; font-size: 0.9rem; opacity: 0.75; }",
  "#passkey-area { margin: 0 0 1rem; }",
  "#passkey-area p.error { margin: 1rem 0 0; }",
  "#spend-passkey { margin: 0 0 1rem; }",
  "#spend-passkey p.error { margin: 1rem 0 0; }",
  "p.or { text-align: center; margin: 0 0 1rem; opacity: 0.75; }",
  "label.remember { display: block; font-weight: 400; margin: 0 0 1rem; cursor: pointer; }",
  "label.remember input { margin-right: 0.5rem; }",
  "p.switch { margin: 1rem 0 0; font-size: 0.95rem; }",
  "p.switch a { color: inherit; }",
].join("\n");

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function pageHtml(title, body) {
  return "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n" +
    "<title>" + escapeHtml(title) + "</title>\n" +
    "<link rel=\"icon\" type=\"image/svg+xml\" href=\"/icons/icon.svg\">\n" +
    "<link rel=\"icon\" type=\"image/png\" sizes=\"64x64\" href=\"/icons/icon-64.png\">\n" +
    "<style>\n" + PAGE_STYLE + "\n</style>\n" +
    "</head>\n<body>\n<main>\n" + body + "\n</main>\n</body>\n</html>\n";
}

// The sign-in page's script: the remembered name's untick,
// the passkey button, and the conditional passkey offer
// (issue #112). The conditional offer is the page's advance
// indicator that a passkey will work: the browser offers, in
// the name field itself, only a passkey it actually holds for
// this site. It starts as the page loads, on the typed-name
// page whose field can carry the offer; it stands down the
// moment the person chooses either door themselves (the
// password form's submit, or the button), and its failures —
// no passkey here, a dismissal, a stand-down — are silent by
// design: the password door is never disturbed by them.
var LOGIN_SCRIPT = [
  "<script>",
  "(function () {",
  "  var form = document.getElementById('login-form');",
  "  var rememberBox = document.getElementById('remember-name');",
  "  if (rememberBox) {",
  "    rememberBox.addEventListener('change', function () {",
  "      if (rememberBox.checked) return;",
  "      var clear = 'ts_name=; Path=/; Max-Age=0; SameSite=Lax';",
  "      if (window.location.protocol === 'https:') clear += '; Secure';",
  "      document.cookie = clear;",
  "    });",
  "  }",
  "  // The two views (issue #122): the switch flips which way",
  "  // stands first and the device remembers the choice in a",
  "  // cookie beside the remembered name's. The conditional",
  "  // offer stays armed in both views; in the passkey view",
  "  // the form itself never submits — the password field",
  "  // stands hidden there, and an Enter in the name field",
  "  // must not post an empty password.",
  "  var viewSwitch = document.getElementById('view-switch');",
  "  var viewPasskey = document.getElementById('view-passkey');",
  "  var viewPassword = document.getElementById('view-password');",
  "  if (viewSwitch && viewPasskey && viewPassword) {",
  "    viewSwitch.addEventListener('click', function (event) {",
  "      event.preventDefault();",
  "      var toPassword = viewSwitch.getAttribute('data-view') === 'password';",
  "      viewPasskey.hidden = toPassword;",
  "      viewPassword.hidden = !toPassword;",
  "      viewSwitch.setAttribute('data-view', toPassword ? 'passkey' : 'password');",
  "      viewSwitch.textContent = toPassword ? 'Use a passkey instead' : 'Use a password instead';",
  "      var view = 'ts_view=' + (toPassword ? 'password' : 'passkey') + '; Path=/; Max-Age=31536000; SameSite=Lax';",
  "      if (window.location.protocol === 'https:') view += '; Secure';",
  "      document.cookie = view;",
  "    });",
  "    if (form) {",
  "      form.addEventListener('submit', function (event) {",
  "        if (viewPassword.hidden) event.preventDefault();",
  "      });",
  "    }",
  "  }",
  "  if (!window.PublicKeyCredential || !window.isSecureContext) return;",
  "  var area = document.getElementById('passkey-area');",
  "  var button = document.getElementById('passkey-button');",
  "  var errorBox = document.getElementById('passkey-error');",
  "  if (!area || !button) return;",
  "  area.hidden = false;",
  "  function b64uToBytes(text) {",
  "    var b64 = text.replace(/-/g, '+').replace(/_/g, '/');",
  "    while (b64.length % 4) b64 += '=';",
  "    var bin = atob(b64);",
  "    var bytes = new Uint8Array(bin.length);",
  "    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);",
  "    return bytes;",
  "  }",
  "  function bytesToB64u(bytes) {",
  "    var bin = '';",
  "    var view = new Uint8Array(bytes);",
  "    for (var i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);",
  "    return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');",
  "  }",
  "  var conditional = null;",
  "  function abortConditional() {",
  "    if (conditional) { conditional.abort(); conditional = null; }",
  "  }",
  "  function attempt(signal, mediation) {",
  "    return fetch('/login/passkey/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })",
  "      .then(function (res) { if (!res.ok) throw new Error('refused'); return res.json(); })",
  "      .then(function (options) {",
  "        var getOptions = { publicKey: {",
  "          challenge: b64uToBytes(options.challenge),",
  "          rpId: options.rpId,",
  "          userVerification: 'required',",
  "          timeout: options.timeout || 300000,",
  "        } };",
  "        if (mediation) { getOptions.mediation = mediation; getOptions.signal = signal; }",
  "        return navigator.credentials.get(getOptions);",
  "      })",
  "      .then(function (cred) {",
  "        var body = {",
  "          id: cred.id, rawId: bytesToB64u(cred.rawId), type: cred.type,",
  "          remember: !rememberBox || rememberBox.checked,",
  "          response: {",
  "            clientDataJSON: bytesToB64u(cred.response.clientDataJSON),",
  "            authenticatorData: bytesToB64u(cred.response.authenticatorData),",
  "            signature: bytesToB64u(cred.response.signature),",
  "            userHandle: cred.response.userHandle ? bytesToB64u(cred.response.userHandle) : null,",
  "          },",
  "        };",
  "        return fetch('/login/passkey/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });",
  "      })",
  "      .then(function (res) { if (!res.ok) throw new Error('refused'); window.location = '/'; });",
  "  }",
  "  button.addEventListener('click', function () {",
  "    abortConditional();",
  "    errorBox.hidden = true;",
  "    attempt().catch(function () {",
  "      errorBox.textContent = 'That passkey did not sign you in. Try again, or use your password.';",
  "      errorBox.hidden = false;",
  "    });",
  "  });",
  "  if (form) form.addEventListener('submit', abortConditional);",
  "  var nameInput = document.getElementById('login-name');",
  "  if (nameInput && window.PublicKeyCredential.isConditionalMediationAvailable) {",
  "    window.PublicKeyCredential.isConditionalMediationAvailable().then(function (available) {",
  "      if (!available || typeof AbortController === 'undefined') return;",
  "      conditional = new AbortController();",
  "      attempt(conditional.signal, 'conditional').catch(function () { /* silent by design */ });",
  "    });",
  "  }",
  "})();",
  "</script>",
].join("\n");

function inviteCodeForm() {
  return [
    '<form method="post" action="/invite-code" class="invite">',
    '  <label class="field">Have an invite?',
    '    <input type="text" name="code" autocomplete="off" placeholder="Paste the code from your invite link">',
    "  </label>",
    '  <button type="submit" class="secondary">Use invite</button>',
    "</form>",
  ].join("\n");
}

// The line that stands where a passkey act would stand when
// the address cannot run one (issue #113). Passkeys need a
// secure context — HTTPS, or a localhost address, which
// browsers treat as secure. At an ordinary HTTP address the
// browser offers no passkey machinery at all, so the acts are
// not offered there; this line says why, in the product's
// voice, and the password door stands as it always did. The
// app prints the same line in the same places (public/app.js
// carries its own copy), and the spend pages print it too.
// The sign-in page itself carries Derick's settled words
// instead (amendment A.8), with the link below.
export var PASSKEY_OFF_LINE = "Passkeys need a secure address (HTTPS). " +
  "This copy is at an ordinary HTTP address, so passkeys are off here. " +
  "Your password works as usual.";

// Where "How to give this site HTTPS" goes: the self-hosting
// guide's HTTPS section, in the repo the code lives in.
var HTTPS_GUIDE_URL = "https://github.com/derickca/TaskSparkle/blob/main/docs/self-hosting.md#the-routes-to-https-ranked";

// The sign-in page. names is the account list to offer as a
// pick list, or null for the typed-name page. rememberedName
// is the name this device remembers (issue #112), or null: on
// the typed page it stands filled into the field; on the pick
// list it is the name pre-picked.
//
// At a secure address the page has two views (issue #122,
// amendment A.8): the passkey view — the name entry and the
// passkey button as the page's main act — and the password
// view, with a small switch below trading which stands first.
// The view the device last used stands when the page opens;
// a fresh device opens on the passkey view. The views are
// emphasis, not capability: the conditional offer in the
// name field stays armed in both, and nothing on the page
// says so. At an ordinary HTTP address there are no views:
// the password form stands, and under it the settled line
// and the HTTPS link. The page's shape never adapts to what
// the account holds. One refusal is the exception, and it is
// the server's, not the page's: a password posted on the
// name-listing door for an account that holds no password is
// refused with the case named (issue #144), because at an
// ordinary HTTP address that person would otherwise meet a
// password box that can never work, with no word why.
// attemptedName is the name a failed sign-in just carried
// back (issue #143): for this one rendering it stands where
// the remembered name would — typed into the field, or
// pre-picked on the list — and the remembered name resumes
// from the next visit.

// Whether a browser at this address sits in a secure context:
// HTTPS, or a localhost name — localhost, a *.localhost name,
// or a loopback address — which browsers treat as secure.
function secureAddress(url) {
  if (url.protocol === "https:") return true;
  var host = url.hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") ||
    host === "127.0.0.1" || host === "::1";
}

function loginPageHtml(cfg, error, names, rememberedName, secure, view, attemptedName) {
  var messages = {
    "1": "That name and password did not match. Check them and try again.",
    locked: "Too many tries. Wait a little, then try again.",
    taken: "The first account already stands. Sign in above, and the " +
      "administrator can invite you from Settings, then Admin.",
    // The passwordless refusal (issue #144): at a secure
    // address the way in stands on the page; at an ordinary
    // HTTP address the sentence says plainly that there is
    // no way in at this address, and why. No reset is offered
    // in either shape — a reset sets a password, and this
    // account's way in is not one.
    nopassword: secure
      ? "That account signs in with a passkey — it holds no password. Use the passkey button above."
      : "That account signs in with a passkey — it holds no password. " +
        "Passkeys need a secure address (HTTPS), so there is no way in at this address.",
  };
  // The headline names only what can run at this address
  // (issue #145): at an ordinary HTTP address no passkey can
  // run, so the passkey leaves the sentence.
  var sub = secure
    ? (cfg.listNames
      ? (cfg.hosted
        ? "Pick your name, then sign in with a passkey or a password."
        : "This copy of TaskSparkle runs on a machine in your home. Pick your name, then sign in with a passkey or a password.")
      : "Type your name, then sign in with a passkey or a password.")
    : (cfg.listNames
      ? (cfg.hosted
        ? "Pick your name, then sign in with your password."
        : "This copy of TaskSparkle runs on a machine in your home. Pick your name, then sign in with your password.")
      : "Type your name, then sign in with your password.");
  var standingName = attemptedName || rememberedName;
  var rememberedKey = standingName ? nameKey(standingName) : null;
  var nameEntry;
  if (cfg.listNames) {
    var people = (names || []).map(function (a) {
      return '      <label class="person"><input type="radio" name="name" value="' +
        escapeHtml(a.name) + '"' +
        (rememberedKey && nameKey(a.name) === rememberedKey ? " checked" : "") +
        " required> " + escapeHtml(a.name) + "</label>";
    }).join("\n");
    nameEntry = [
      '    <fieldset class="names">',
      "      <legend>Your name</legend>",
      people,
      "    </fieldset>",
    ].join("\n");
  } else {
    nameEntry = [
      '    <label class="field">Your name',
      '      <input type="text" id="login-name" name="name" required maxlength="120" autocomplete="username webauthn"' +
        (standingName ? ' value="' + escapeHtml(standingName) + '"' : "") + ">",
      "    </label>",
    ].join("\n");
  }
  var passwordDoor = [
    '    <label class="field">Your password',
    '      <input type="password" name="password" required autocomplete="current-password">',
    "    </label>",
    '    <button type="submit">Sign in</button>',
  ].join("\n");
  var doors;
  if (secure) {
    var passkeyFirst = view !== "password";
    doors = [
      passkeyFirst ? '    <div id="view-passkey">' : '    <div id="view-passkey" hidden>',
      '      <div id="passkey-area" hidden>',
      '        <button type="button" id="passkey-button">Use a passkey</button>',
      '        <p class="error" id="passkey-error" hidden></p>',
      "      </div>",
      "    </div>",
      passkeyFirst ? '    <div id="view-password" hidden>' : '    <div id="view-password">',
      passwordDoor,
      "    </div>",
      '    <p class="switch"><a href="#" id="view-switch" data-view="' +
        (passkeyFirst ? "password" : "passkey") + '">' +
        (passkeyFirst ? "Use a password instead" : "Use a passkey instead") +
        "</a></p>",
    ].join("\n");
  } else {
    doors = passwordDoor;
  }
  var body = [
    "<h1>TaskSparkle</h1>",
    '<p class="sub">' + escapeHtml(sub) + "</p>",
    messages[error] ? '<p class="error">' + messages[error] + "</p>" : "",
    '<form method="post" action="/login" id="login-form">',
    nameEntry,
    '    <label class="remember"><input type="checkbox" id="remember-name" name="remember" value="1" checked> Remember my name on this device</label>',
    doors,
    "  </form>",
    // At an ordinary HTTP address, Derick's settled words
    // stand under the form (amendment A.8), displacing the
    // #113 stand-in line on this page only.
    secure ? "" :
      '  <p class="note" id="passkey-off-note">This site is not encrypted. ' +
      "A password typed here can be read on this network. " +
      '<a href="' + HTTPS_GUIDE_URL + '">How to give this site HTTPS</a></p>',
    inviteCodeForm(),
    LOGIN_SCRIPT,
  ].join("\n");
  return pageHtml("Sign in — TaskSparkle", body);
}

// The spend pages' script (issue #122, amendment A.6): the
// passkey way on the setup and invite pages. Choosing it runs
// the enrolment ceremony on the page itself, against a
// challenge issued for the spend; the account comes into
// being only when a credential verifies, server-side. The
// script only carries the ceremony: the fields it sends are
// read from the page's own inputs at the press — the name,
// the setup code where the page asks for one, the start-fresh
// box on the recovery page. A failed or abandoned ceremony
// spends nothing and makes no account: the page can be
// reopened and the other way chosen instead.
// The two ways stand open together, the passkey first
// (issue #141): there is no switch, and nothing the press
// reads is ever hidden — the name and the setup code stand
// above both ways (issue #128: a switch once hid the whole
// form, so a press on empty hidden fields could only fail,
// and the failure never said why). A press with one of them
// empty names the missing one instead of sending an empty
// value to be refused.
function spendScript(optionsUrl, verifyUrl) {
  return [
    "<script>",
    "(function () {",
    "  if (!window.PublicKeyCredential || !window.isSecureContext) return;",
    "  var button = document.getElementById('spend-passkey-button');",
    "  var errorBox = document.getElementById('spend-error');",
    "  if (!button || !errorBox) return;",
    "  function b64uToBytes(text) {",
    "    var b64 = text.replace(/-/g, '+').replace(/_/g, '/');",
    "    while (b64.length % 4) b64 += '=';",
    "    var bin = atob(b64);",
    "    var bytes = new Uint8Array(bin.length);",
    "    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);",
    "    return bytes;",
    "  }",
    "  function bytesToB64u(bytes) {",
    "    var bin = '';",
    "    var view = new Uint8Array(bytes);",
    "    for (var i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);",
    "    return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');",
    "  }",
    "  function fieldValue(name) {",
    "    var el = document.querySelector('input[name=\"' + name + '\"]');",
    "    return el ? el.value : undefined;",
    "  }",
    "  button.addEventListener('click', function () {",
    "    errorBox.hidden = true;",
    "    var nameEl = document.getElementById('spend-name');",
    "    if (nameEl && !nameEl.value.trim()) {",
    "      errorBox.textContent = 'Add your name first.';",
    "      errorBox.hidden = false;",
    "      return;",
    "    }",
    "    var codeEl = document.getElementById('spend-code');",
    "    if (codeEl && !codeEl.value.trim()) {",
    "      errorBox.textContent = 'Add the setup code first.';",
    "      errorBox.hidden = false;",
    "      return;",
    "    }",
    "    var fields = {};",
    "    var name = fieldValue('name');",
    "    if (name !== undefined) fields.name = name;",
    "    var code = fieldValue('code');",
    "    if (code !== undefined) fields.code = code;",
    "    var fresh = document.getElementById('spend-start-fresh');",
    "    if (fresh) fields.startFresh = !!fresh.checked;",
    "    fetch('" + optionsUrl + "', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) })",
    "      .then(function (res) { if (!res.ok) throw new Error('refused'); return res.json(); })",
    "      .then(function (options) {",
    "        return navigator.credentials.create({ publicKey: {",
    "          challenge: b64uToBytes(options.challenge),",
    "          rp: options.rp,",
    "          user: { id: b64uToBytes(options.user.id), name: options.user.name, displayName: options.user.displayName || options.user.name },",
    "          pubKeyCredParams: options.pubKeyCredParams,",
    "          authenticatorSelection: options.authenticatorSelection,",
    "          attestation: options.attestation || 'none',",
    "          timeout: options.timeout || 300000,",
    "          excludeCredentials: (options.excludeCredentials || []).map(function (c) {",
    "            return { id: b64uToBytes(c.id), type: c.type };",
    "          }),",
    "        } });",
    "      })",
    "      .then(function (cred) {",
    "        var body = { response: {",
    "          id: cred.id, rawId: bytesToB64u(cred.rawId), type: cred.type,",
    "          response: {",
    "            clientDataJSON: bytesToB64u(cred.response.clientDataJSON),",
    "            attestationObject: bytesToB64u(cred.response.attestationObject),",
    "            transports: cred.response.getTransports ? cred.response.getTransports() : [],",
    "          },",
    "        } };",
    "        return fetch('" + verifyUrl + "', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });",
    "      })",
    "      .then(function (res) { if (!res.ok) throw new Error('refused'); window.location = '/'; })",
    "      .catch(function () {",
    "        errorBox.textContent = 'That passkey could not be enrolled. Try again, or use the other way.';",
    "        errorBox.hidden = false;",
    "      });",
    "  });",
    "})();",
    "</script>",
  ].join("\n");
}

// The reset form's own script (issue #133): with the
// start-fresh box ticked, the Set password press runs the
// enrolment ceremony instead of the plain form post, and
// the password typed into the form rides the ceremony's
// verify — so on the server the spend, the password
// change, the removal and the enrolment land in one act,
// and a failed or abandoned ceremony changes nothing.
// Unticked, or with the two passwords differing (the form's
// own refusal names that), the press is the plain form
// post: a plain reset, which removes nothing.
function spendResetScript(optionsUrl, verifyUrl) {
  return [
    "<script>",
    "(function () {",
    "  if (!window.PublicKeyCredential || !window.isSecureContext) return;",
    "  var form = document.getElementById('spend-form');",
    "  var fresh = document.getElementById('spend-start-fresh');",
    "  var errorBox = document.getElementById('spend-error');",
    "  if (!form || !fresh || !errorBox) return;",
    "  function b64uToBytes(text) {",
    "    var b64 = text.replace(/-/g, '+').replace(/_/g, '/');",
    "    while (b64.length % 4) b64 += '=';",
    "    var bin = atob(b64);",
    "    var bytes = new Uint8Array(bin.length);",
    "    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);",
    "    return bytes;",
    "  }",
    "  function bytesToB64u(bytes) {",
    "    var bin = '';",
    "    var view = new Uint8Array(bytes);",
    "    for (var i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);",
    "    return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');",
    "  }",
    "  function fieldValue(name) {",
    "    var el = form.querySelector('input[name=\"' + name + '\"]');",
    "    return el ? el.value : '';",
    "  }",
    "  function refusedWith(data) {",
    "    var err = new Error('refused');",
    "    err.server = data && data.error ? data.error : null;",
    "    return err;",
    "  }",
    "  function answered(res) {",
    "    return res.json().catch(function () { return null; }).then(function (data) {",
    "      if (!res.ok) throw refusedWith(data);",
    "      return data;",
    "    });",
    "  }",
    "  form.addEventListener('submit', function (event) {",
    "    if (!fresh.checked) return;",
    "    var password = fieldValue('password');",
    "    var confirm = fieldValue('confirm');",
    "    if (!password || password !== confirm) return;",
    "    event.preventDefault();",
    "    errorBox.hidden = true;",
    "    fetch('" + optionsUrl + "', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startFresh: true }) })",
    "      .then(answered)",
    "      .then(function (options) {",
    "        return navigator.credentials.create({ publicKey: {",
    "          challenge: b64uToBytes(options.challenge),",
    "          rp: options.rp,",
    "          user: { id: b64uToBytes(options.user.id), name: options.user.name, displayName: options.user.displayName || options.user.name },",
    "          pubKeyCredParams: options.pubKeyCredParams,",
    "          authenticatorSelection: options.authenticatorSelection,",
    "          attestation: options.attestation || 'none',",
    "          timeout: options.timeout || 300000,",
    "          excludeCredentials: (options.excludeCredentials || []).map(function (c) {",
    "            return { id: b64uToBytes(c.id), type: c.type };",
    "          }),",
    "        } });",
    "      })",
    "      .then(function (cred) {",
    "        var body = { response: {",
    "          id: cred.id, rawId: bytesToB64u(cred.rawId), type: cred.type,",
    "          response: {",
    "            clientDataJSON: bytesToB64u(cred.response.clientDataJSON),",
    "            attestationObject: bytesToB64u(cred.response.attestationObject),",
    "            transports: cred.response.getTransports ? cred.response.getTransports() : [],",
    "          },",
    "        }, password: password, confirm: confirm };",
    "        return fetch('" + verifyUrl + "', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });",
    "      })",
    "      .then(answered)",
    "      .then(function () { window.location = '/'; })",
    "      .catch(function (err) {",
    "        errorBox.textContent = (err && err.server) || 'That passkey could not be enrolled. Nothing was changed — your passkeys still stand. Try again, or untick the box and reset the password only.';",
    "        errorBox.hidden = false;",
    "      });",
    "  });",
    "})();",
    "</script>",
  ].join("\n");
}

// The passkey way's block on a spend page (issue #141): it
// stands open inside the form, listed before the password
// fields — the two ways carry equal standing and neither
// hides the other. It carries the ceremony's button and
// error line. The recovery page builds its own block: it
// has the start-fresh choice to carry and no password form
// to stand beside.
function spendPasskeyBlock(buttonText) {
  return [
    '    <div id="spend-passkey">',
    '      <button type="button" id="spend-passkey-button">' + buttonText + "</button>",
    '      <p class="error" id="spend-error" hidden></p>',
    "    </div>",
    '    <p class="or">or</p>',
  ].join("\n");
}

// The setup page, served at the sign-in address while no
// account stands: the first name added will be the
// administrator. The hosted copy asks for the setup code as
// well — one extra field, the design's named difference.
// At a secure address the page offers two ways with equal
// standing, the passkey way listed first (amendment A.6,
// issue #141); at an ordinary HTTP address the password way
// stands alone, with the line.
export function setupPageHtml(cfg, error, secure) {
  var messages = {
    // The password refusals name their actual reason (issue
    // #147): the shared keyed lines, word for word.
    pwmismatch: PASSWORD_REFUSAL_MESSAGES.pwmismatch,
    pwlength: PASSWORD_REFUSAL_MESSAGES.pwlength,
    pwcommon: PASSWORD_REFUSAL_MESSAGES.pwcommon,
    pwname: PASSWORD_REFUSAL_MESSAGES.pwname,
    name: "That name cannot be used. Pick another name and try again.",
    code: "That setup code did not match. Check it and try again.",
    // No code configured at all (issue #153): the refusal
    // says a code must be set first, instead of answering as
    // if the typed code were merely wrong.
    nocode: "No setup code is set on this copy yet. A setup code must be " +
      "set first — it lives in this copy's deployment settings.",
    locked: "Too many tries. Wait a little, then try again.",
  };
  var sub = cfg.hosted
    ? "Nobody has an account yet. Add the first name below. That person becomes the administrator: the one who can invite everyone else."
    : "This copy of TaskSparkle runs on a machine in your home, and nobody has an account yet. Add the first name below. That person becomes the administrator: the one who can invite everyone else.";
  var codeField = cfg.requireSetupCode ? [
    '    <label class="field">The setup code — from this copy\'s deployment settings',
    '      <input type="text" id="spend-code" name="code" required autocomplete="off">',
    "    </label>",
  ].join("\n") : "";
  var body = [
    "<h1>TaskSparkle</h1>",
    '<p class="sub">' + escapeHtml(sub) + "</p>",
    messages[error] ? '<p class="error">' + messages[error] + "</p>" : "",
    '<form method="post" action="/setup" id="spend-form">',
    '    <label class="field">Your name — the name you will sign in with',
    '      <input type="text" id="spend-name" name="name" required maxlength="120" autocomplete="username">',
    "    </label>",
    codeField,
    secure ? spendPasskeyBlock("Make the first account with a passkey") : "",
    '    <div id="spend-password">',
    '    <label class="field">A password — at least ' + MIN_PASSWORD_LENGTH + " characters",
    '      <input type="password" name="password" required autocomplete="new-password">',
    "    </label>",
    '    <label class="field">The same password again',
    '      <input type="password" name="confirm" required autocomplete="new-password">',
    "    </label>",
    "    </div>",
    '    <button type="submit" id="spend-submit">Make the first account</button>',
    "  </form>",
    secure ? "" : '  <p class="note" id="passkey-off-note">' + PASSKEY_OFF_LINE + "</p>",
    inviteCodeForm(),
    secure ? spendScript("/setup/passkey/options", "/setup/passkey/verify") : "",
  ].join("\n");
  return pageHtml("Set up — TaskSparkle", body);
}

// The invite page. It names whose invite this is, so a link
// opened by the wrong person is plainly not theirs. The page
// follows the account's own shape (amendment A.6): for a new
// account the name stands in an editable field, already
// filled in, and the passkey way stands first among two
// ways of equal standing at a secure address (issue #141);
// for an existing account holding
// a password the invite is a reset, the name stands fixed,
// and the form carries the start-fresh choice in the open —
// under the ruled displacement [B] a reset on its own never
// removes a passkey, and this choice is the one way it does:
// the ticked press runs the enrolment ceremony, and the
// removal lands inside its verify, beside the new passkey
// (issue #133). An existing account holding no password
// gets the recovery page below instead of a form.
export function invitePageHtml(cfg, row, code, isReset, error, secure) {
  var messages = {
    // The password refusals name their actual reason (issue
    // #147): the shared keyed lines, word for word.
    pwmismatch: PASSWORD_REFUSAL_MESSAGES.pwmismatch,
    pwlength: PASSWORD_REFUSAL_MESSAGES.pwlength,
    pwcommon: PASSWORD_REFUSAL_MESSAGES.pwcommon,
    pwname: PASSWORD_REFUSAL_MESSAGES.pwname,
    name: "That name is not available. Pick another name and try again.",
    locked: "Too many tries. Wait a little, then try again.",
  };
  var sub = cfg.hosted
    ? "You have an invite to this copy of TaskSparkle."
    : "You have an invite to this copy of TaskSparkle, which runs on a machine in your home.";
  var block = "<p>This invite is for <strong>" + escapeHtml(row.name) +
    "</strong>." + (isReset
      ? " Spending it sets a new password for that account."
      : " You get your own boards, and no one else's boards are shared with you.") +
    " If that is not you, do not go on — tell the person who sent you the link.</p>";
  var field = isReset ? "" : [
    '<label class="field">Your name — the name you will sign in with',
    '      <input type="text" id="spend-name" name="name" value="' + escapeHtml(row.name) +
      '" maxlength="120" autocomplete="username" required>',
    "    </label>",
  ].join("\n");
  // The start-fresh choice stands only at a secure address
  // (issue #133): the ticked press runs the enrolment
  // ceremony, and no passkey act is offered where the
  // ceremony cannot run (issue #113's rule). At an ordinary
  // HTTP address the form is a plain reset, which removes
  // nothing, and the note below says so.
  var startFresh = isReset && secure ? [
    '    <label class="remember"><input type="checkbox" name="start_fresh" id="spend-start-fresh" value="1"> ' +
      "Start fresh: remove my passkeys and enrol a new one</label>",
  ].join("\n") : "";
  var note = "Your password needs at least " + MIN_PASSWORD_LENGTH +
    " characters." + (isReset
      // A reset signs out every other sign-in: the form says
      // so before the act, in the recovery page's own words
      // (issue #146).
      ? " A reset on its own never removes a passkey. Spending this link " +
        "signs out every other sign-in for the account."
      // The closing note follows the door the person is on
      // (issue #155): a sign-in list exists only where names
      // are listed; on the typed door the name is typed.
      : (cfg.listNames
        ? " The name above is the one on the sign-in list from then on."
        : " The name above is the one you type to sign in with from then on.")) +
    " This link stops working the moment it is spent — looking at " +
    "this page does not use it up.";
  var optionsUrl = "/invite/" + encodeURIComponent(code) + "/passkey/options";
  var verifyUrl = "/invite/" + encodeURIComponent(code) + "/passkey/verify";
  var body = [
    "<h1>TaskSparkle</h1>",
    '<p class="sub">' + escapeHtml(sub) + "</p>",
    block,
    messages[error] ? '<p class="error">' + messages[error] + "</p>" : "",
    '<form method="post" action="/invite/' + encodeURIComponent(code) + '" id="spend-form">',
    field,
    !isReset && secure ? spendPasskeyBlock("Use a passkey") : "",
    '    <div id="spend-password">',
    '    <label class="field">Your new password',
    '      <input type="password" name="password" required autocomplete="new-password">',
    "    </label>",
    '    <label class="field">The same password again',
    '      <input type="password" name="confirm" required autocomplete="new-password">',
    "    </label>",
    "    </div>",
    startFresh,
    '    <button type="submit" id="spend-submit">Set password</button>',
    isReset ? '    <p class="error" id="spend-error" hidden></p>' : "",
    "  </form>",
    !isReset && !secure
      ? '  <p class="note" id="passkey-off-note">' + PASSKEY_OFF_LINE + "</p>"
      : "",
    '  <p class="note">' + escapeHtml(note) + "</p>",
    !isReset && secure ? spendScript(optionsUrl, verifyUrl) : "",
    isReset && secure ? spendResetScript(optionsUrl, verifyUrl) : "",
  ].join("\n");
  return pageHtml("Set your password — TaskSparkle", body);
}

// The recovery page: an invite spent on an account that
// holds no password (amendment A.6). There is no password to
// set — the account signs in with passkeys alone — so the
// spend's act is enrolling a fresh passkey by ceremony, the
// spend revoking every session as a reset does. Under [B]
// the standing passkeys remain through it, unless the
// spender picks the start-fresh choice the page carries in
// the open. At an ordinary HTTP address the ceremony cannot
// run: the page carries the standing line and the invite
// keeps, unspent, for a secure address.
export function recoveryPageHtml(cfg, row, code, error, secure) {
  var messages = {
    recovery: "This account signs in with passkeys alone, so there is no password to set. Enrol a new passkey instead.",
    locked: "Too many tries. Wait a little, then try again.",
  };
  var sub = cfg.hosted
    ? "You have an invite to this copy of TaskSparkle."
    : "You have an invite to this copy of TaskSparkle, which runs on a machine in your home.";
  var block = "<p>This invite is for <strong>" + escapeHtml(row.name) +
    "</strong>. That account signs in with passkeys, so this link enrols a new " +
    "passkey for it — there is no password to set. If that is not you, do not " +
    "go on — tell the person who sent you the link.</p>";
  var optionsUrl = "/invite/" + encodeURIComponent(code) + "/passkey/options";
  var verifyUrl = "/invite/" + encodeURIComponent(code) + "/passkey/verify";
  var ceremony = secure ? [
    '  <div id="spend-passkey">',
    '    <label class="remember"><input type="checkbox" id="spend-start-fresh" value="1"> ' +
      "Start fresh: remove my passkeys and enrol a new one</label>",
    '    <button type="button" id="spend-passkey-button">Enrol a new passkey</button>',
    '    <p class="error" id="spend-error" hidden></p>',
    "  </div>",
  ].join("\n") : [
    '  <p class="note" id="passkey-off-note">' + PASSKEY_OFF_LINE + "</p>",
    "  <p>This link enrols a passkey, and passkeys need a secure address. " +
      "Open this same link at this copy's secure address, or ask the person " +
      "who runs this copy for help. The link keeps until then.</p>",
  ].join("\n");
  var body = [
    "<h1>TaskSparkle</h1>",
    '<p class="sub">' + escapeHtml(sub) + "</p>",
    block,
    messages[error] ? '<p class="error">' + messages[error] + "</p>" : "",
    ceremony,
    '  <p class="note">Spending this link signs out every other sign-in for ' +
      "the account. Looking at this page does not use it up.</p>",
    secure ? spendScript(optionsUrl, verifyUrl) : "",
  ].join("\n");
  return pageHtml("Enrol a passkey — TaskSparkle", body);
}

// One refusal page for spent, expired and unknown codes alike.
export function inviteRefusedHtml() {
  var body = [
    "<h1>TaskSparkle</h1>",
    "<p>This invite link does not work.</p>",
    "<p>It may already have been used, or it may have expired. Ask the person who runs this copy for a fresh invite — a fresh link is also how a forgotten password gets replaced.</p>",
    '<p><a href="/login">Back to sign in</a></p>',
  ].join("\n");
  return pageHtml("Invite — TaskSparkle", body);
}

// --- The hosted sign-in pages ---
// The hosted copy's sign-in page, in the words Derick settled
// for it: one page for joining and coming back, an emailed
// link as the way through it, and a passkey for the device
// that holds one. No name is typed and no password is asked
// for — the address is the only thing a person types, and it
// is a claim the link itself proves, never a thing the page
// trusts. The script below is the sign-in script's own shape
// cut to this page: the passkey button, and the conditional
// offer armed in the email field (it carries the same
// autocomplete the name field carried), so a device holding
// a passkey offers it before anything is typed.

export function hostedLoginPageHtml(cfg, error) {
  var messages = {
    locked: "Too many tries. Wait a little, then try again.",
    taken: "The first account already stands. Sign in above, and the " +
      "administrator can invite you from Settings, then Admin.",
  };
  var body = [
    "<h1>TaskSparkle</h1>",
    '<p class="sub">New here or coming back, it\'s the same page. No password, ever.</p>',
    messages[error] ? '<p class="error">' + messages[error] + "</p>" : "",
    '<form method="post" action="/login/email" id="login-form">',
    '    <label class="field">Your email address',
    '      <input type="email" id="login-name" name="email" required maxlength="254" autocomplete="username webauthn">',
    "    </label>",
    '    <button type="submit">Email me a link</button>',
    "  </form>",
    '  <p class="note">Tap it and we\'ll email you a link. The link signs you in — it works once, and it expires in 15 minutes.</p>',
    '  <div id="passkey-area" hidden>',
    '    <p class="switch">Been here on this device before?</p>',
    '    <button type="button" id="passkey-button">Sign in with a passkey</button>',
    '    <p class="note">One tap. Nothing to type.</p>',
    '    <p class="error" id="passkey-error" hidden></p>',
    "  </div>",
    hostedLoginScript(),
  ].join("\n");
  return pageHtml("Sign in or join — TaskSparkle", body);
}

function hostedLoginScript() {
  return [
    "<script>",
    "(function () {",
    "  var form = document.getElementById('login-form');",
    "  if (!window.PublicKeyCredential || !window.isSecureContext) return;",
    "  var area = document.getElementById('passkey-area');",
    "  var button = document.getElementById('passkey-button');",
    "  var errorBox = document.getElementById('passkey-error');",
    "  if (!area || !button) return;",
    "  area.hidden = false;",
    "  function b64uToBytes(text) {",
    "    var b64 = text.replace(/-/g, '+').replace(/_/g, '/');",
    "    while (b64.length % 4) b64 += '=';",
    "    var bin = atob(b64);",
    "    var bytes = new Uint8Array(bin.length);",
    "    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);",
    "    return bytes;",
    "  }",
    "  function bytesToB64u(bytes) {",
    "    var bin = '';",
    "    var view = new Uint8Array(bytes);",
    "    for (var i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);",
    "    return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');",
    "  }",
    "  var conditional = null;",
    "  function abortConditional() {",
    "    if (conditional) { conditional.abort(); conditional = null; }",
    "  }",
    "  function attempt(signal, mediation) {",
    "    return fetch('/login/passkey/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })",
    "      .then(function (res) { if (!res.ok) throw new Error('refused'); return res.json(); })",
    "      .then(function (options) {",
    "        var getOptions = { publicKey: {",
    "          challenge: b64uToBytes(options.challenge),",
    "          rpId: options.rpId,",
    "          userVerification: 'required',",
    "          timeout: options.timeout || 300000,",
    "        } };",
    "        if (mediation) { getOptions.mediation = mediation; getOptions.signal = signal; }",
    "        return navigator.credentials.get(getOptions);",
    "      })",
    "      .then(function (cred) {",
    "        var body = {",
    "          id: cred.id, rawId: bytesToB64u(cred.rawId), type: cred.type,",
    "          response: {",
    "            clientDataJSON: bytesToB64u(cred.response.clientDataJSON),",
    "            authenticatorData: bytesToB64u(cred.response.authenticatorData),",
    "            signature: bytesToB64u(cred.response.signature),",
    "            userHandle: cred.response.userHandle ? bytesToB64u(cred.response.userHandle) : null,",
    "          },",
    "        };",
    "        return fetch('/login/passkey/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });",
    "      })",
    "      .then(function (res) { if (!res.ok) throw new Error('refused'); window.location = '/'; });",
    "  }",
    "  button.addEventListener('click', function () {",
    "    abortConditional();",
    "    errorBox.hidden = true;",
    "    attempt().catch(function () {",
    "      errorBox.textContent = 'That passkey did not sign you in. Try again, or ask for a link above.';",
    "      errorBox.hidden = false;",
    "    });",
    "  });",
    "  if (form) form.addEventListener('submit', abortConditional);",
    "  var emailInput = document.getElementById('login-name');",
    "  if (emailInput && window.PublicKeyCredential.isConditionalMediationAvailable) {",
    "    window.PublicKeyCredential.isConditionalMediationAvailable().then(function (available) {",
    "      if (!available || typeof AbortController === 'undefined') return;",
    "      conditional = new AbortController();",
    "      attempt(conditional.signal, 'conditional').catch(function () { /* silent by design */ });",
    "    });",
    "  }",
    "})();",
    "</script>",
  ].join("\n");
}

// The page a link request lands on. Its words are the same
// whatever the address holds or the switch says: nothing on
// it tells a stranger whether an account stands, whether
// joining is open, or whether anything was sent.
export function checkInboxPageHtml() {
  var body = [
    "<h1>TaskSparkle</h1>",
    '<p class="sub">Check your inbox.</p>',
    "<p>If that address can sign in or join, a link is on its way to it. The link works once, and it expires in 15 minutes.</p>",
    '<p><a href="/login">Back to sign in</a></p>',
  ].join("\n");
  return pageHtml("Check your inbox — TaskSparkle", body);
}

// A spent, expired or unknown link: the invite refusal's
// shape, in the link's own words.
export function linkRefusedPageHtml() {
  var body = [
    "<h1>TaskSparkle</h1>",
    "<p>This link does not work.</p>",
    "<p>It may already have been used, or it may have expired — a link works once, and only for 15 minutes. Ask for a fresh one on the sign-in page.</p>",
    '<p><a href="/login">Back to sign in</a></p>',
  ].join("\n");
  return pageHtml("Sign in — TaskSparkle", body);
}

// The link's landing page when an account stands: one press
// signs in. The press is the spend — looking never spends —
// so a mail scanner that follows the link cannot use it up.
export function linkSignInPageHtml(cfg, account, code) {
  var body = [
    "<h1>TaskSparkle</h1>",
    '<p class="sub">This link signs in ' + escapeHtml(account.name) + ".</p>",
    "<p>Spending it signs out your other sign-ins — it is also the way back in when you are shut out, so it takes the place of every other way in.</p>",
    '<form method="post" action="/link/' + escapeHtml(code) + '">',
    '    <button type="submit">Sign in</button>',
    "  </form>",
  ].join("\n");
  return pageHtml("Sign in — TaskSparkle", body);
}

// The link's landing page when no account stands: the whole
// of joining. A name (any name — it is only what the person
// is called here), the Terms tick standing unticked, and one
// button. The account is made only when the tick stands, at
// the press; the bot check's widget stands in the form where
// the deployment configured one.
export function linkJoinPageHtml(cfg, code, error, secure) {
  var messages = {
    name: "That name cannot be used. Pick another name and try again.",
    terms: "Tick the box to agree to the Terms first.",
    bot: "The bot check did not pass. Try again.",
    taken: "That address already has an account. Ask for a link on the sign-in page, and sign in instead.",
    locked: "Too many tries. Wait a little, then try again.",
  };
  var botCheck = cfg.turnstileSiteKey
    ? '    <div class="cf-turnstile" data-sitekey="' +
      escapeHtml(cfg.turnstileSiteKey) + '"></div>'
    : "";
  var body = [
    "<h1>TaskSparkle</h1>",
    '<p class="sub">Make your account on this copy of TaskSparkle.</p>',
    "<p>You get your own boards, and no one else's boards are shared with you.</p>",
    messages[error] ? '<p class="error">' + messages[error] + "</p>" : "",
    '<form method="post" action="/link/' + escapeHtml(code) + '">',
    '    <label class="field">Your name — what you will be called here',
    '      <input type="text" name="name" required maxlength="120" autocomplete="name">',
    "    </label>",
    '    <label class="remember"><input type="checkbox" name="terms" value="1"> I agree to the <a href="/terms">Terms</a></label>',
    botCheck,
    '    <button type="submit">Make my boards</button>',
    "  </form>",
    cfg.turnstileSiteKey
      ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
      : "",
  ].join("\n");
  return pageHtml("Join — TaskSparkle", body);
}

// The joining refusal at the link's landing, while the
// switch stands at invite-only or closed: plain words, and
// the invite path named, because invites keep working
// exactly as they do.
export function linkJoinRefusedPageHtml(closed) {
  var body = [
    "<h1>TaskSparkle</h1>",
    closed
      ? "<p>Joining is closed on this copy.</p>"
      : "<p>Joining is not open on this copy.</p>",
    closed
      ? "<p>No new accounts are being made here right now. If you were sent an invite, it still works — open its link.</p>"
      : "<p>New accounts here are made by invite. If you were sent an invite, open its link.</p>",
    '<p><a href="/login">Back to sign in</a></p>',
  ].join("\n");
  return pageHtml("Join — TaskSparkle", body);
}

// The country gate's refusal at the link's landing: signing
// in stands open from anywhere; only joining is gated.
export function linkCountryPageHtml(cfg) {
  var body = [
    "<h1>TaskSparkle</h1>",
    "<p>" + escapeHtml(countryLine(cfg)) + "</p>",
    "<p>This address reads as outside them, so an account cannot be made from here. If you already have an account, you can sign in from anywhere.</p>",
    '<p><a href="/login">Back to sign in</a></p>',
  ].join("\n");
  return pageHtml("Join — TaskSparkle", body);
}

// The offer that follows a joining spend, inside the first
// session: a passkey for this device. The ceremony is the
// Account page's own (its options and its answer, under the
// core's step-up — the just-spent link is the session's fresh
// proof, and the new account holds no passkey yet, so the
// proof the enrolment asks for stands). "Not now" is a plain
// way past it; the offer stands again in Settings, then
// Account, whenever the person wants it.
export function passkeyOfferPageHtml(cfg) {
  var body = [
    "<h1>TaskSparkle</h1>",
    '<p class="sub">Your boards stand. One more thing, if you like.</p>',
    "<p>Make this device one tap: add a passkey for it, and signing in here after that is the tap and nothing else — no link to wait for.</p>",
    '    <div id="spend-passkey">',
    '      <button type="button" id="spend-passkey-button">Add a passkey</button>',
    '      <p class="error" id="spend-error" hidden></p>',
    "    </div>",
    '  <p class="switch"><a href="/">Not now</a></p>',
    spendScript("/api/auth/passkeys/options", "/api/auth/passkeys"),
  ].join("\n");
  return pageHtml("Add a passkey — TaskSparkle", body);
}

// --- The page handlers ----------------------------------------------------------------
//
// Builds the handler for the sign-in, setup, invite and logout
// addresses from the deployment's config:
//
// - authDb: the auth store.
// - cfg.hosted: the page wording variant. Either home offers
//   passkeys at a secure address and not at an ordinary HTTP
//   one (issue #113); the request's own address decides.
// - cfg.listNames: the login page lists account names (home)
//   rather than taking a typed name (hosted).
// - cfg.requireSetupCode / cfg.setupCodeHash(): the hosted
//   setup page's one-time code, held as a deployment secret;
//   setupCodeHash answers its SHA-256 hex, or null when no code
//   is configured (a required code with none configured fails
//   closed: setup cannot complete until the operator sets one).
// - cfg.sourceOf(request): the source address the throttle
//   keys on — CF-Connecting-IP on the hosted copy and nothing
//   else; the socket's peer address at home.
// - cfg.sourceCapMs: the per-source lockout ceiling for this
//   home (fifteen minutes hosted, one minute at home).
// - cfg.cookieSecure(request): whether the session cookie
//   carries Secure for this request.
// - cfg.turnstileSiteKey / cfg.turnstileVerify(token, source):
//   the bot check on joining. Both stand only where the
//   deployment configured the check — the widget's public
//   key, and the server-side verification the deployment's
//   secret answers. Where the key stands, joining waits for
//   the verifier's yes and fails closed without it; where
//   neither stands, no check runs at all.
// - cfg.signupCountries / cfg.countryOf(request): the
//   country gate on joining. The list names the countries
//   joining is open to; no list, no gate. countryOf reads
//   the request's country as the deployment's own edge
//   reports it. The gate refuses joining only — sign-in is
//   never gated.
// - cfg.mailSend(message): the hosted copy's mail path — the
//   deployment's hand that sends one message ({to, subject,
//   text, html, kind, idempotencyKey}) through the shared
//   mail service and answers whether it was accepted. Only
//   the hosted shape ever calls it; where it does not stand,
//   a link request still answers the same and sends nothing.
//
// The handler takes and returns web-standard Request and
// Response objects, like the core's, and answers null for any
// address that is not one of the door's own.

function authJson(data, status, headers) {
  var all = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  if (headers) Object.keys(headers).forEach(function (k) { all[k] = headers[k]; });
  return new Response(JSON.stringify(data), { status: status || 200, headers: all });
}

function authRedirect(location, headers) {
  var all = { Location: location };
  if (headers) Object.keys(headers).forEach(function (k) { all[k] = headers[k]; });
  return new Response(null, { status: 302, headers: all });
}

function authHtml(html, turnstile) {
  var policy =
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
    "font-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
  if (turnstile) {
    // The bot check's widget stands on the joining form
    // alone: its script, its frame and its answer calls are
    // let through in that page's answers, and nowhere else.
    policy =
      "default-src 'none'; style-src 'unsafe-inline'; " +
      "script-src 'unsafe-inline' https://challenges.cloudflare.com; " +
      "font-src 'self'; img-src 'self'; " +
      "connect-src 'self' https://challenges.cloudflare.com; " +
      "frame-src https://challenges.cloudflare.com; " +
      "form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
  }
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      "content-security-policy": policy,
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
    },
  });
}

export function createAuthHandlers(deps) {
  var authDb = deps.authDb;
  var cfg = deps.cfg;

  // Whether a setup code stands configured at all (issue
  // #153). setupCodeOk fails closed when none does, but the
  // refusal must say so — "did not match" would send the
  // operator hunting for a typo in a code that does not
  // exist. Doors that ask for no code are always configured.
  async function setupCodeConfigured() {
    if (!cfg.requireSetupCode) return true;
    return !!(cfg.setupCodeHash && (await cfg.setupCodeHash()));
  }

  async function setupCodeOk(given) {
    if (!cfg.requireSetupCode) return true;
    var expectedHex = cfg.setupCodeHash ? await cfg.setupCodeHash() : null;
    if (!expectedHex) return false; // fail closed: no code configured
    var givenHash = await sha256Bytes(String(given || ""));
    var expectedBytes;
    try {
      expectedBytes = new Uint8Array(expectedHex.match(/.{2}/g).map(function (h) {
        return parseInt(h, 16);
      }));
    } catch (e) {
      return false;
    }
    return bytesEqual(givenHash, expectedBytes);
  }

  // Verifies a password against an account row, rehashing on a
  // successful legacy or out-of-date proof (design section 3:
  // the scrypt carry-over, and parameter rises, both land at
  // the next proof).
  async function checkPassword(account, password) {
    var stored = account ? account.password_hash : null;
    var result = await verifyPassword(stored, password);
    if (result.ok && account && (result.legacy || !isCurrentHash(stored))) {
      var upgraded = await hashPassword(password);
      await authDb.prepare("UPDATE accounts SET password_hash = ? WHERE key = ?")
        .bind(upgraded, account.key).run();
    }
    return result.ok;
  }

  async function beginSession(res, accountKey, via, request, proofVia) {
    var made = await createSession(authDb, accountKey, via, proofVia);
    res.headers.set("Set-Cookie",
      sessionCookieValue(made.token, cfg.cookieSecure(request)));
    return res;
  }

  // A session begun by a passkey enrolment (issue #141): the
  // person has just given this device a passkey, so beside
  // the session cookie the answer stands the remembered
  // sign-in view up as the passkey view — their next sign-in
  // on this device opens on it. The memory still follows
  // their own switches afterwards; this records only the
  // newest choice they have actually made.
  async function beginEnrolledSession(res, accountKey, via, request) {
    var out = await beginSession(res, accountKey, via, request, "passkey");
    out.headers.append("Set-Cookie",
      viewCookieValue("passkey", cfg.cookieSecure(request)));
    return out;
  }

  // The enrolment options a spend ceremony answers, in the
  // same shape the Account page's enrolment reads. The handle
  // and the name come from the challenge's pending record —
  // minted and bound at issuance — never from the verify call
  // (amendment A.6).
  function spendOptionsJson(challengeB64u, url, handle, name, exclude) {
    return {
      challenge: challengeB64u,
      rp: { id: url.hostname, name: "TaskSparkle" },
      user: { id: handle, name: name, displayName: name },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -8 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      attestation: "none",
      timeout: CHALLENGE_MS,
      excludeCredentials: (exclude || []).map(function (row) {
        return { id: row.credential_id, type: "public-key" };
      }),
    };
  }

  // The challenge a ceremony answer names, read out of its
  // client data — the way every verify in this file finds it.
  function ceremonyChallenge(body) {
    try {
      var data = JSON.parse(new TextDecoder().decode(
        b64uDecode(body.response.response.clientDataJSON || "")));
      return data.challenge || null;
    } catch (e) { return null; }
  }

  // The setup page's passkey way (amendment A.6): the
  // ceremony runs first, guarded by the setup code and the
  // source throttle exactly as the password spend is, and the
  // first account is created only when a credential verifies
  // — born with no password and its first passkey standing,
  // its session stamped with the passkey as its proof.
  async function handleSetupPasskeyOptions(request) {
    var source = cfg.sourceOf(request);
    var refused = function (msg, status) {
      return authJson({ error: msg }, status || 400);
    };
    if ((await countAccounts(authDb)) > 0) {
      return refused("The first account already stands.");
    }
    if (await throttleLocked(authDb, source, null)) {
      return refused("Too many tries. Wait a little, then try again.", 429);
    }
    var body = null;
    try { body = await request.json(); } catch (e) { body = null; }
    var display = String((body && body.name) || "").trim();
    if (nameProblem(display)) {
      return refused("That name cannot be used. Pick another name and try again.");
    }
    if (!(await setupCodeConfigured())) {
      return refused("No setup code is set on this copy yet. A setup code must be " +
        "set first — it lives in this copy's deployment settings.");
    }
    if (!(await setupCodeOk(body && body.code))) {
      await noteThrottleFailure(authDb, source, null, cfg.sourceCapMs);
      return refused("That setup code did not match. Check it and try again.");
    }
    var handle = b64uEncode(randomBytes(32));
    var issued = await issueChallenge(authDb, "spend", null, {
      setup: true, name: display, userHandle: handle,
    });
    var url = new URL(request.url);
    return authJson(spendOptionsJson(issued.challengeB64u, url, handle, display));
  }

  async function handleSetupPasskeyVerify(request) {
    var source = cfg.sourceOf(request);
    var refused = function (msg, status) {
      return authJson({ error: msg }, status || 400);
    };
    if ((await countAccounts(authDb)) > 0) {
      return refused("The first account already stands.");
    }
    var body = null;
    try { body = await request.json(); } catch (e) { body = null; }
    if (!body || !body.response) return refused("That passkey could not be enrolled.");
    var challengeB64u = ceremonyChallenge(body);
    var found = challengeB64u
      ? await findChallenge(authDb, challengeB64u, "spend", null) : null;
    if (!found || !found.payload || !found.payload.setup) {
      return refused("That passkey could not be enrolled.");
    }
    var url = new URL(request.url);
    var registered;
    try {
      registered = await verifyRegistration(body.response, {
        challengeB64u: challengeB64u, origin: url.origin, rpId: url.hostname,
      });
    } catch (e) {
      return refused("That passkey could not be enrolled: " + e.message);
    }
    if (!(await spendChallenge(authDb, challengeB64u, "spend", null))) {
      return refused("That passkey could not be enrolled.");
    }
    // First-wins, in the setup insert's own atomic shape, at
    // NULL: the creation lands whole or not at all, under the
    // handle and name the pending record carries.
    var stamp = nowMs();
    var made = await authDb.prepare(
      "INSERT INTO accounts (key, id, name, password_hash, admin, owner_id, user_handle, created_at) " +
      "SELECT ?, ?, ?, NULL, 1, NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM accounts)"
    ).bind(nameKey(found.payload.name), newAccountId(), found.payload.name,
      found.payload.userHandle, stamp).run();
    if (!made || !made.meta || !Number(made.meta.changes)) {
      return refused("The first account already stands.");
    }
    var account = await getAccount(authDb, nameKey(found.payload.name));
    await addPasskey(authDb, {
      credentialId: registered.credentialId, accountKey: account.key,
      coseBytes: registered.coseBytes, signCount: registered.signCount,
      transports: registered.transports, backedUp: registered.backedUp,
      nickname: "", rpHome: url.hostname,
    });
    await writeAudit(authDb, account, "first-account", account, "setup page, passkey");
    await clearThrottle(authDb, source, null);
    await sweepAuth(authDb);
    return beginEnrolledSession(authJson({ ok: true }), account.key, "setup", request);
  }

  // The invite page's passkey way (amendment A.6): the same
  // ceremony-first spend, for a new account and for a
  // passwordless account's recovery alike. A password
  // account's invite is a reset: its one ceremony is the
  // start-fresh spend, run from the reset form's ticked
  // press (issue #133).
  async function handleInvitePasskeyOptions(request, code) {
    var source = cfg.sourceOf(request);
    var refused = function (msg, status) {
      return authJson({ error: msg }, status || 400);
    };
    var row = await findInvite(authDb, code);
    if (!inviteUsable(row)) return refused("This invite link does not work.");
    if (await throttleLocked(authDb, source, row.key)) {
      return refused("Too many tries. Wait a little, then try again.", 429);
    }
    var body = null;
    try { body = await request.json(); } catch (e) { body = null; }
    var url = new URL(request.url);
    var codeHash = await sha256Hex(code);
    var account = await getAccount(authDb, row.key);
    if (account && account.password_hash) {
      // A reset invite's one ceremony is the start-fresh
      // spend (issue #133): the choice binds into the pending
      // record, and the verify spends the invite, replaces
      // the password and removes the standing passkeys in
      // the same act that enrols the new one. Without the
      // choice the invite sets a password through the form,
      // as it always has. No exclusion list rides the
      // options: the new passkey may be enrolled on the very
      // device whose passkeys are being replaced (issue
      // #132's lesson).
      if (!(body && body.startFresh === true)) {
        return refused("This invite sets a password. Use the form on the page.");
      }
      var resetIssued = await issueChallenge(authDb, "spend", row.key, {
        codeHash: codeHash, userHandle: account.user_handle,
        startFresh: true, reset: true,
      });
      return authJson(spendOptionsJson(resetIssued.challengeB64u, url,
        account.user_handle, account.name));
    }
    if (account) {
      // The recovery ceremony: the handle is the account's
      // own, and the start-fresh choice binds into the
      // pending record at issuance, so the verify spends
      // exactly what the page offered.
      var issuedRec = await issueChallenge(authDb, "spend", row.key, {
        codeHash: codeHash, userHandle: account.user_handle,
        startFresh: !!(body && body.startFresh),
      });
      var held = await listPasskeys(authDb, row.key);
      return authJson(spendOptionsJson(issuedRec.challengeB64u, url,
        account.user_handle, account.name, held));
    }
    var display = body && body.name != null ? String(body.name).trim() : row.name;
    if (nameProblem(display)) {
      return refused("That name cannot be used. Pick another name and try again.");
    }
    if (nameKey(display) !== row.key && (await getAccount(authDb, nameKey(display)))) {
      return refused("That name is not available. Pick another name and try again.");
    }
    var handle = b64uEncode(randomBytes(32));
    var issued = await issueChallenge(authDb, "spend", null, {
      codeHash: codeHash, name: display, userHandle: handle,
    });
    return authJson(spendOptionsJson(issued.challengeB64u, url, handle, display));
  }

  async function handleInvitePasskeyVerify(request, code) {
    var source = cfg.sourceOf(request);
    var refused = function (msg, status) {
      return authJson({ error: msg }, status || 400);
    };
    var row = await findInvite(authDb, code);
    if (!inviteUsable(row)) return refused("This invite link does not work.");
    var account = await getAccount(authDb, row.key);
    var body = null;
    try { body = await request.json(); } catch (e) { body = null; }
    if (!body || !body.response) return refused("That passkey could not be enrolled.");
    var challengeB64u = ceremonyChallenge(body);
    var found = challengeB64u ? await findChallenge(authDb, challengeB64u,
      "spend", account ? row.key : null) : null;
    var codeHash = await sha256Hex(code);
    if (!found || !found.payload || found.payload.codeHash !== codeHash ||
        found.payload.setup) {
      return refused("That passkey could not be enrolled.");
    }
    // A password account's ceremony is the start-fresh
    // reset spend, and only that (issue #133): the pending
    // record must carry the choice bound at issuance, and
    // the new password rides the verify, judged here —
    // before anything is spent — with the form's own rules.
    var isResetSpend = !!(account && account.password_hash);
    var resetPassword = null;
    if (isResetSpend) {
      if (!found.payload.reset || !found.payload.startFresh) {
        return refused("This invite sets a password. Use the form on the page.");
      }
      resetPassword = String(body.password || "");
      if (resetPassword !== String(body.confirm || "")) {
        return refused("The two passwords did not match.");
      }
      var resetProblem = passwordProblem(resetPassword, account.name);
      if (resetProblem) return refused(resetProblem);
    }
    var url = new URL(request.url);
    var registered;
    try {
      registered = await verifyRegistration(body.response, {
        challengeB64u: challengeB64u, origin: url.origin, rpId: url.hostname,
      });
    } catch (e) {
      return refused("That passkey could not be enrolled: " + e.message);
    }
    if (await getPasskey(authDb, registered.credentialId)) {
      return refused("That passkey already stands on an account.");
    }
    if (!(await spendChallenge(authDb, challengeB64u, "spend",
        account ? row.key : null))) {
      return refused("That passkey could not be enrolled.");
    }
    if (!(await spendInvite(authDb, code))) {
      // A second press landed first; this one is a refusal,
      // and no account is made on a spent invite.
      return refused("This invite link does not work.");
    }
    if (isResetSpend) {
      // The start-fresh reset spend (issue #133): the new
      // password replaces the old and every session is
      // revoked, as a plain reset's are, and the standing
      // passkeys are deleted in the same act that enrols
      // the new one — the only removal a reset carries, and
      // it never lands without the enrolment beside it.
      var resetHash = await hashPassword(resetPassword);
      await authDb.prepare("UPDATE accounts SET password_hash = ? WHERE key = ?")
        .bind(resetHash, row.key).run();
      await revokeAccountSessions(authDb, row.key, null);
      await authDb.prepare("DELETE FROM passkeys WHERE account_key = ?")
        .bind(row.key).run();
      await addPasskey(authDb, {
        credentialId: registered.credentialId, accountKey: row.key,
        coseBytes: registered.coseBytes, signCount: registered.signCount,
        transports: registered.transports, backedUp: registered.backedUp,
        nickname: "", rpHome: url.hostname,
      });
      await writeAudit(authDb, account, "password-reset", account,
        "invite spend, start fresh");
      await clearThrottle(authDb, source, row.key);
      await sweepAuth(authDb);
      return beginEnrolledSession(authJson({ ok: true }), row.key, "invite", request);
    }
    if (account) {
      // The recovery spend (amendment A.6): every session is
      // revoked, as a reset's are. The standing passkeys
      // remain — under [B] a spend removes none of them —
      // unless the start-fresh choice was bound into the
      // pending record, the named act this page offers.
      if (found.payload.startFresh) {
        await authDb.prepare("DELETE FROM passkeys WHERE account_key = ?")
          .bind(row.key).run();
      }
      await revokeAccountSessions(authDb, row.key, null);
      await addPasskey(authDb, {
        credentialId: registered.credentialId, accountKey: row.key,
        coseBytes: registered.coseBytes, signCount: registered.signCount,
        transports: registered.transports, backedUp: registered.backedUp,
        nickname: "", rpHome: url.hostname,
      });
      await writeAudit(authDb, account, "passkey-recovery", account,
        found.payload.startFresh ? "invite spend, start fresh" : "invite spend");
      await clearThrottle(authDb, source, row.key);
      await sweepAuth(authDb);
      return beginEnrolledSession(authJson({ ok: true }), row.key, "invite", request);
    }
    // The passkey-born account: created only now, under the
    // handle and name the pending record carries, at NULL.
    // If the creation cannot land, the invite is handed back
    // unspent, ready for a fresh ceremony.
    var created;
    try {
      created = await createAccount(authDb, {
        key: nameKey(found.payload.name), name: found.payload.name,
        passwordHash: null, admin: false, userHandle: found.payload.userHandle,
      });
    } catch (e) {
      await unspendInvite(authDb, code);
      return refused("That name is not available. Pick another name and try again.");
    }
    await addPasskey(authDb, {
      credentialId: registered.credentialId, accountKey: created.key,
      coseBytes: registered.coseBytes, signCount: registered.signCount,
      transports: registered.transports, backedUp: registered.backedUp,
      nickname: "", rpHome: url.hostname,
    });
    await writeAudit(authDb, created, "account-created", created, "invite spend, passkey");
    await ensureAdminStanding(authDb);
    await clearThrottle(authDb, source, created.key);
    await sweepAuth(authDb);
    return beginEnrolledSession(authJson({ ok: true }), created.key, "invite", request);
  }

  async function handleLoginPost(request) {
    var form = new URLSearchParams(await request.text());
    var key = nameKey(form.get("name"));
    var source = cfg.sourceOf(request);
    // Every refusal from this door carries the typed name
    // back in the one-shot cookie (issue #143), so the page
    // it lands on stands the name in the field and clears
    // only the password.
    var attempted = String(form.get("name") || "").trim();
    var refusal = function (location) {
      var res = authRedirect(location);
      if (attempted) {
        res.headers.append("Set-Cookie",
          attemptCookieValue(attempted, cfg.cookieSecure(request)));
      }
      return res;
    };
    if (await throttleLocked(authDb, source, key)) {
      return refusal("/login?error=locked");
    }
    var account = await getAccount(authDb, key);
    // The passwordless case on the name-listing door (issue
    // #144): the account holds no password, so the box below
    // could never be satisfied. The refusal names the case
    // instead of letting the press fail as a mismatch. This
    // door only — on the typed door the same knowledge would
    // tell a stranger which names hold no password. No
    // throttle note: nothing was guessed wrong.
    if (cfg.listNames && account && !account.password_hash) {
      return refusal("/login?error=nopassword");
    }
    var ok = await checkPassword(account, form.get("password") || "");
    if (!account || !ok) {
      await noteThrottleFailure(authDb, source, key, cfg.sourceCapMs);
      return refusal("/login?error=1");
    }
    await clearThrottle(authDb, source, key);
    await sweepAuth(authDb);
    var res = await beginSession(authRedirect("/"), account.key, "password", request);
    // The remembered name (issue #112): the form's box stood
    // ticked, so the name rests on this device for the next
    // visit; unticked — which an unticked box posts as no
    // field at all — any remembered name is cleared and
    // nothing is stored. A failed sign-in moves neither way.
    res.headers.append("Set-Cookie", form.get("remember")
      ? rememberedNameCookieValue(account.name, cfg.cookieSecure(request))
      : expiredRememberedNameCookieValue(cfg.cookieSecure(request)));
    return res;
  }

  async function handleSetupPost(request) {
    var source = cfg.sourceOf(request);
    var form = new URLSearchParams(await request.text());
    if ((await countAccounts(authDb)) > 0) {
      return authRedirect("/login?error=taken");
    }
    if (await throttleLocked(authDb, source, null)) {
      return authRedirect("/login?error=locked");
    }
    var display = String(form.get("name") || "").trim();
    if (nameProblem(display)) {
      return authRedirect("/login?error=name");
    }
    if (!(await setupCodeConfigured())) {
      // Not a guessing failure: no throttle note, and the
      // refusal names the missing setting (issue #153).
      return authRedirect("/login?error=nocode");
    }
    if (!(await setupCodeOk(form.get("code")))) {
      await noteThrottleFailure(authDb, source, null, cfg.sourceCapMs);
      return authRedirect("/login?error=code");
    }
    var password = String(form.get("password") || "");
    var confirm = String(form.get("confirm") || "");
    var setupRefusal = passwordRefusalKey(password, confirm, display);
    if (setupRefusal) {
      await noteThrottleFailure(authDb, source, null, cfg.sourceCapMs);
      return authRedirect("/login?error=" + setupRefusal);
    }
    var key = nameKey(display);
    var hash = await hashPassword(password);
    var stamp = nowMs();
    // First-wins is atomic: the insert lands only while no
    // account stands at all, so two presses racing settle as
    // one account and one plain refusal.
    var made = await authDb.prepare(
      "INSERT INTO accounts (key, id, name, password_hash, admin, owner_id, user_handle, created_at) " +
      "SELECT ?, ?, ?, ?, 1, NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM accounts)"
    ).bind(key, newAccountId(), display, hash, b64uEncode(randomBytes(32)), stamp).run();
    if (!made || !made.meta || !Number(made.meta.changes)) {
      return authRedirect("/login?error=taken");
    }
    var account = await getAccount(authDb, key);
    await writeAudit(authDb, account, "first-account", account, "setup page");
    await clearThrottle(authDb, source, null);
    return beginSession(authRedirect("/"), key, "setup", request);
  }

  async function handleRedeem(request, code) {
    var source = cfg.sourceOf(request);
    var back = "/invite/" + encodeURIComponent(code);
    var form = new URLSearchParams(await request.text());
    var row = await findInvite(authDb, code);
    if (await throttleLocked(authDb, source, row ? row.key : null)) {
      return authRedirect(back + "?error=locked");
    }
    if (!inviteUsable(row)) {
      await noteThrottleFailure(authDb, source, row ? row.key : null, cfg.sourceCapMs);
      return authRedirect(back);
    }
    var standing = await getAccount(authDb, row.key);
    if (standing && !standing.password_hash) {
      // A passwordless account has no password to set: its
      // invite is spent on the recovery page, by ceremony
      // (amendment A.6). A password form posted at it anyway
      // is refused back to that page, and the invite stands
      // unspent either way.
      return authRedirect(back + "?error=recovery");
    }
    var password = String(form.get("password") || "");
    var confirm = String(form.get("confirm") || "");
    var spendRefusal = passwordRefusalKey(password, confirm, row.name);
    if (spendRefusal) {
      await noteThrottleFailure(authDb, source, row.key, cfg.sourceCapMs);
      return authRedirect(back + "?error=" + spendRefusal);
    }
    var account = standing;
    var finalKey = row.key;
    var finalName = row.name;
    if (!account) {
      // A new account: the name on the page may have been
      // adjusted. It must be a name, and it must not be a name
      // an account already holds — refused here, before the
      // spend, so the invite stays unspent.
      var given = form.get("name");
      finalName = given === null ? row.name : String(given).trim();
      if (nameProblem(finalName) ||
          (nameKey(finalName) !== row.key && (await getAccount(authDb, nameKey(finalName))))) {
        return authRedirect(back + "?error=name");
      }
      finalKey = nameKey(finalName);
    }
    if (!(await spendInvite(authDb, code))) {
      // A second press landed first; this one is a refusal.
      await noteThrottleFailure(authDb, source, row.key, cfg.sourceCapMs);
      return authRedirect(back);
    }
    var hash = await hashPassword(password);
    if (account) {
      // A reset is proven only by holding the link: the
      // password is replaced and every session is revoked.
      // The passkeys are NOT touched — under the ruled
      // displacement [B], a passkey comes off an account only
      // by a named act, and the one named act this page
      // offers, the start-fresh choice, is a ceremony: the
      // removal lands inside its verify, beside the new
      // passkey it enrols (issue #133). A form post on its
      // own — a ticked field riding it or not — is a plain
      // reset, so removal without the enrolment is
      // impossible. The boards stand untouched either way.
      await authDb.prepare("UPDATE accounts SET password_hash = ? WHERE key = ?")
        .bind(hash, row.key).run();
      await revokeAccountSessions(authDb, row.key, null);
      await writeAudit(authDb, account, "password-reset", account, "invite spend");
    } else {
      try {
        await createAccount(authDb, {
          key: finalKey, name: finalName, passwordHash: hash, admin: false,
        });
      } catch (e) {
        // Another spend took the name in the same moment. Hand
        // the invite back unspent and refuse, exactly as if the
        // press had named a taken name from the start.
        await unspendInvite(authDb, code);
        return authRedirect(back + "?error=name");
      }
      var created = await getAccount(authDb, finalKey);
      await writeAudit(authDb, created, "account-created", created, "invite spend");
      await ensureAdminStanding(authDb);
    }
    await clearThrottle(authDb, source, finalKey);
    return beginSession(authRedirect("/"), finalKey, "invite", request);
  }

  // --- The emailed link's handlers (the hosted shape) ---
  // Every one of these answers only where cfg.hosted stands;
  // the dispatch below never routes a home copy here, so the
  // home shape's behaviour is untouched by their standing.

  // The bot check, where the deployment configured one: no
  // site key stands configured, no check runs. Where one
  // stands, a missing token, a missing verifier or a failed
  // verification all refuse — the check fails closed.
  async function turnstilePassed(token, source) {
    if (!cfg.turnstileSiteKey) return true;
    if (!token || !cfg.turnstileVerify) return false;
    try {
      return !!(await cfg.turnstileVerify(String(token), source));
    } catch (e) {
      return false;
    }
  }

  // The body of the one message the hosted copy sends: the
  // link, what it does, and how long it stands. The wording
  // is the same whether the address is joining or coming
  // back — the message itself tells nobody which.
  function signInLinkMessage(email, code, origin) {
    var link = origin + "/link/" + code;
    var text = [
      "Sign in to TaskSparkle with this link:",
      "",
      link,
      "",
      "It works once, and it expires in 15 minutes. It signs you in — or makes your account if you are new.",
      "",
      "If you did not ask for this link, leave this message alone.",
    ].join("\n");
    var html = [
      "<p>Sign in to TaskSparkle with this link:</p>",
      '<p><a href="' + link + '">Sign in to TaskSparkle</a></p>',
      "<p>" + link + "</p>",
      "<p>It works once, and it expires in 15 minutes. It signs you in — or makes your account if you are new.</p>",
      "<p>If you did not ask for this link, leave this message alone.</p>",
    ].join("\n");
    return {
      to: email, subject: "Your TaskSparkle sign-in link",
      text: text, html: html, kind: "sign-in-link",
    };
  }

  // The ask: an address typed on the sign-in page. The answer
  // is one redirect, always — the check-your-inbox page —
  // whatever the address holds, whatever the switch says,
  // whether anything was sent: nothing about the answer tells
  // a stranger which case stood. A link is sent only when it
  // would do something: the address has an account (signing
  // in is never gated), or joining stands open to this
  // request under the switch and the country gate. Locked
  // sources and capped paces send nothing either; every
  // well-formed ask that is not already capped spends the
  // pace, sent or not.
  async function handleEmailLinkRequest(request) {
    var source = cfg.sourceOf(request);
    var answer = authRedirect("/login/sent");
    var form = new URLSearchParams(await request.text());
    var email = emailKey(form.get("email"));
    if (emailProblem(email)) return answer;
    if (await throttleLocked(authDb, source, null)) return answer;
    if (await linkPaceCapped(authDb, source, email)) return answer;
    await noteLinkRequest(authDb, source, email);
    var account = await getAccountByEmail(authDb, email);
    var maySend = !!account;
    if (!maySend && (await countAccounts(authDb)) > 0 &&
        (await doorState(authDb)) === DOOR_OPEN && countryAllowed(cfg, request)) {
      maySend = true;
    }
    if (maySend && cfg.mailSend) {
      var minted = await mintEmailLink(authDb, email);
      var origin = new URL(request.url).origin;
      var message = signInLinkMessage(email, minted.code, origin);
      message.idempotencyKey = minted.codeHash;
      try { await cfg.mailSend(message); } catch (e) { /* the answer never says */ }
    }
    await sweepAuth(authDb);
    return answer;
  }

  async function handleLinkGet(request, url, code) {
    var row = await findEmailLink(authDb, code);
    if (!emailLinkUsable(row)) return authHtml(linkRefusedPageHtml());
    var account = await getAccountByEmail(authDb, row.email);
    if (account) return authHtml(linkSignInPageHtml(cfg, account, code));
    // Joining is judged at the landing as at the spend: the
    // switch first, then the country gate, then the form.
    if ((await doorState(authDb)) !== DOOR_OPEN) {
      return authHtml(linkJoinRefusedPageHtml(
        (await doorState(authDb)) === DOOR_CLOSED));
    }
    if (!countryAllowed(cfg, request)) {
      return authHtml(linkCountryPageHtml(cfg));
    }
    return authHtml(
      linkJoinPageHtml(cfg, code, url.searchParams.get("error") || "",
        secureAddress(url)),
      !!cfg.turnstileSiteKey);
  }

  async function handleLinkPost(request, code) {
    var source = cfg.sourceOf(request);
    var back = "/link/" + encodeURIComponent(code);
    var form = new URLSearchParams(await request.text());
    var row = await findEmailLink(authDb, code);
    if (!emailLinkUsable(row)) return authRedirect(back);
    var account = await getAccountByEmail(authDb, row.email);
    if (await throttleLocked(authDb, source, account ? account.key : null)) {
      return authRedirect(back + "?error=locked");
    }
    if (account) {
      // The sign-in spend — and the recovery, the same act:
      // the link is proven by holding it, every other session
      // the account holds is revoked, and a fresh session
      // begins stamped with the link as its proof.
      if (!(await spendEmailLink(authDb, code))) return authRedirect(back);
      await revokeAccountSessions(authDb, account.key, null);
      await writeAudit(authDb, account, "sign-in", account, "emailed link");
      await clearThrottle(authDb, source, account.key);
      await sweepAuth(authDb);
      return beginSession(authRedirect("/"), account.key, "email", request);
    }
    // The joining spend. Every judgment stands before the
    // spend — the switch and the gate read again here, as
    // the creation they guard can have been outrun since the
    // page was rendered — so a refused press leaves the link
    // unspent, exactly as a refused invite press does.
    if ((await doorState(authDb)) !== DOOR_OPEN) return authRedirect(back);
    if (!countryAllowed(cfg, request)) return authRedirect(back);
    var display = String(form.get("name") || "").trim();
    if (nameProblem(display)) return authRedirect(back + "?error=name");
    if (!form.get("terms")) return authRedirect(back + "?error=terms");
    if (!(await turnstilePassed(form.get("cf-turnstile-response"), source))) {
      return authRedirect(back + "?error=bot");
    }
    if (!(await spendEmailLink(authDb, code))) return authRedirect(back);
    // The account is keyed by its address and carries it:
    // the name the person gave is only what they are called.
    // It is born with no password — the link and the passkey
    // it is about to be offered are its ways in.
    var created;
    try {
      created = await createAccount(authDb, {
        key: row.email, email: row.email, name: display,
        passwordHash: null, admin: false,
      });
    } catch (e) {
      // The address won an account in the same moment. Hand
      // the link back unspent and refuse, as an invite spend
      // hands its invite back.
      await unspendEmailLink(authDb, code);
      return authRedirect(back + "?error=taken");
    }
    await writeAudit(authDb, created, "account-created", created, "emailed link");
    await ensureAdminStanding(authDb);
    await clearThrottle(authDb, source, created.key);
    await sweepAuth(authDb);
    return beginSession(authRedirect("/add-passkey"), created.key, "email", request);
  }

  // The passkey offer after a joining spend: a standing
  // session is the whole entry requirement — without one the
  // sign-in page is the answer.
  async function handleAddPasskeyGet(request) {
    var standing = await sessionFromRequest(authDb, request);
    if (!standing) return authRedirect("/login");
    return authHtml(passkeyOfferPageHtml(cfg));
  }

  async function handlePasskeyOptions(request) {
    var source = cfg.sourceOf(request);
    // Refused with zero writes while the source stands locked:
    // issuance needs no account, so the lock gate is what keeps
    // the cheapest anonymous write bounded (section 7).
    if (await throttleLocked(authDb, source, null)) {
      return authJson({ error: "Too many tries. Wait a little, then try again." }, 429);
    }
    var url = new URL(request.url);
    var issued = await issueChallenge(authDb, "assert", null);
    return authJson({
      challenge: issued.challengeB64u,
      rpId: url.hostname,
      timeout: CHALLENGE_MS,
      userVerification: "required",
    });
  }

  async function handlePasskeyVerify(request) {
    var source = cfg.sourceOf(request);
    var body = null;
    try { body = await request.json(); } catch (e) { body = null; }
    var refused = authJson({ error: "That passkey did not sign you in." }, 401);
    if (!body || !body.id) return refused;
    var passkey = await getPasskey(authDb, body.id);
    if (!passkey) {
      await noteThrottleFailure(authDb, source, null, cfg.sourceCapMs);
      return refused;
    }
    var account = await getAccount(authDb, passkey.account_key);
    if (!account) {
      await noteThrottleFailure(authDb, source, null, cfg.sourceCapMs);
      return refused;
    }
    var url = new URL(request.url);
    // The challenge is spent before the signature is checked:
    // single-use means a replayed answer is dead whichever way
    // the check would have gone.
    var clientChallenge = null;
    try {
      var clientData = JSON.parse(new TextDecoder().decode(
        b64uDecode(body.response.clientDataJSON || "")));
      clientChallenge = clientData.challenge;
    } catch (e) { clientChallenge = null; }
    if (!clientChallenge ||
        !(await spendChallenge(authDb, clientChallenge, "assert", null))) {
      await noteThrottleFailure(authDb, source, account.key, cfg.sourceCapMs);
      return refused;
    }
    try {
      var verified = await verifyAssertion(body, passkey, {
        challengeB64u: clientChallenge,
        origin: url.origin,
        rpId: url.hostname,
        userHandle: account.user_handle,
      });
    } catch (e) {
      await noteThrottleFailure(authDb, source, account.key, cfg.sourceCapMs);
      return refused;
    }
    await notePasskeyUse(authDb, passkey.credential_id, verified.signCount);
    await clearThrottle(authDb, source, account.key);
    await sweepAuth(authDb);
    var res = await beginSession(authJson({ ok: true }), account.key, "passkey", request);
    // The remembered name (issue #112): the page's script
    // sends the box's state with the tap. Unticked clears any
    // remembered name; anything else — ticked, or a caller
    // that sends no word — remembers this account's name.
    res.headers.append("Set-Cookie", body.remember === false
      ? expiredRememberedNameCookieValue(cfg.cookieSecure(request))
      : rememberedNameCookieValue(account.name, cfg.cookieSecure(request)));
    return res;
  }

  return async function handleAuthRequest(request) {
    var url = new URL(request.url);
    var path = url.pathname;
    var method = request.method;

    if (path === "/login") {
      if (method === "POST") return handleLoginPost(request);
      if (method === "GET") {
        var standing = await sessionFromRequest(authDb, request);
        if (standing) return authRedirect("/");
        if ((await countAccounts(authDb)) === 0) {
          return authHtml(setupPageHtml(cfg, url.searchParams.get("error") || "",
            secureAddress(url)));
        }
        // The attempted name's cookie is read on every shape
        // (issue #143): it is expired in the same answer that
        // reads it. The home page below stands the name in
        // its field; the hosted page renders no name at all,
        // so there it is simply consumed.
        var attemptedName = attemptedNameFromRequest(request);
        // The hosted copy's page is the emailed link's page:
        // no name is typed and no password is asked for. The
        // home page below is untouched.
        if (cfg.hosted) {
          var hostedAnswer = authHtml(hostedLoginPageHtml(cfg,
            url.searchParams.get("error") || ""));
          if (attemptedName) {
            hostedAnswer.headers.append("Set-Cookie",
              expiredAttemptCookieValue(cfg.cookieSecure(request)));
          }
          return hostedAnswer;
        }
        var names = cfg.listNames ? await listAccounts(authDb) : null;
        var loginAnswer = authHtml(loginPageHtml(cfg, url.searchParams.get("error") || "",
          names, rememberedNameFromRequest(request), secureAddress(url),
          rememberedViewFromRequest(request), attemptedName));
        if (attemptedName) {
          loginAnswer.headers.append("Set-Cookie",
            expiredAttemptCookieValue(cfg.cookieSecure(request)));
        }
        return loginAnswer;
      }
    }
    if (path === "/login/passkey/options" && method === "POST") {
      return handlePasskeyOptions(request);
    }
    if (path === "/login/passkey/verify" && method === "POST") {
      return handlePasskeyVerify(request);
    }
    // The emailed link's addresses, the hosted shape only: a
    // home copy never routes here, and its answers for these
    // paths stay the fall-through they have always been.
    if (cfg.hosted && path === "/login/email" && method === "POST") {
      return handleEmailLinkRequest(request);
    }
    if (cfg.hosted && path === "/login/sent" && method === "GET") {
      return authHtml(checkInboxPageHtml());
    }
    var linkMatch = /^\/link\/([^/]+)$/.exec(path);
    if (cfg.hosted && linkMatch) {
      var linkCode = linkMatch[1];
      try { linkCode = decodeURIComponent(linkCode); } catch (e) { /* the raw segment stands */ }
      if (method === "POST") return handleLinkPost(request, linkCode);
      if (method === "GET") return handleLinkGet(request, url, linkCode);
    }
    if (cfg.hosted && path === "/add-passkey" && method === "GET") {
      return handleAddPasskeyGet(request);
    }
    if (path === "/setup") {
      if (method === "POST") return handleSetupPost(request);
      // A second visit explains itself (issue #154): once the
      // first account stands, the sign-in page carries the
      // word — the account stands; sign in, or ask the
      // administrator for an invite. While none stands, the
      // plain redirect serves the setup page as before.
      if ((await countAccounts(authDb)) > 0) {
        return authRedirect("/login?error=taken");
      }
      return authRedirect("/login");
    }
    if (path === "/setup/passkey/options" && method === "POST") {
      return handleSetupPasskeyOptions(request);
    }
    if (path === "/setup/passkey/verify" && method === "POST") {
      return handleSetupPasskeyVerify(request);
    }
    var inviteCeremony = /^\/invite\/([^/]+)\/passkey\/(options|verify)$/.exec(path);
    if (inviteCeremony && method === "POST") {
      var ceremonyCode = inviteCeremony[1];
      try { ceremonyCode = decodeURIComponent(ceremonyCode); } catch (e) { /* the raw segment stands */ }
      return inviteCeremony[2] === "options"
        ? handleInvitePasskeyOptions(request, ceremonyCode)
        : handleInvitePasskeyVerify(request, ceremonyCode);
    }
    var inviteMatch = /^\/invite\/([^/]+)$/.exec(path);
    if (inviteMatch) {
      var code = inviteMatch[1];
      try { code = decodeURIComponent(code); } catch (e) { /* the raw segment stands */ }
      if (method === "POST") return handleRedeem(request, code);
      if (method === "GET") {
        var row = await findInvite(authDb, code);
        if (!inviteUsable(row)) return authHtml(inviteRefusedHtml());
        var target = await getAccount(authDb, row.key);
        var secure = secureAddress(url);
        // The page follows the account's own shape (A.6): a
        // passwordless account's invite is a recovery, spent
        // by ceremony, never a password form.
        if (target && !target.password_hash) {
          return authHtml(recoveryPageHtml(cfg, row, code,
            url.searchParams.get("error") || "", secure));
        }
        return authHtml(invitePageHtml(cfg, row, code, !!target,
          url.searchParams.get("error") || "", secure));
      }
    }
    if (path === "/invite-code" && method === "POST") {
      var form = new URLSearchParams(await request.text());
      var pasted = String(form.get("code") || "").replace(/\s+/g, "");
      var inviteCode = pasted.indexOf("/invite/") !== -1
        ? pasted.split("/invite/").pop() : pasted;
      if (!inviteCode) return authRedirect("/login");
      return authRedirect("/invite/" + encodeURIComponent(inviteCode));
    }
    if (path === "/logout" && (method === "POST" || method === "GET")) {
      var token = sessionTokenFromRequest(request);
      if (token) {
        var tokenHash = await sha256Hex(token);
        await revokeSession(authDb, tokenHash);
      }
      return authRedirect("/login", {
        "Set-Cookie": expiredSessionCookieValue(cfg.cookieSecure(request)),
      });
    }
    return null;
  };
}
