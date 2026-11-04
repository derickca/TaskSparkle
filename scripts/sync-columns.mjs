#!/usr/bin/env node
// Column sync for the deploy job.
//
// schema.sql is the truth for the database's shape, but its
// CREATE TABLE IF NOT EXISTS statements do not change a table the
// live database already has, so a column added to schema.sql for an
// existing table would never reach the live database on its own.
// This script closes that gap. It reads the columns schema.sql
// declares for each table, asks the live database which columns it
// actually has (PRAGMA table_info), and adds each missing one with
// ALTER TABLE ADD COLUMN, using the type and default exactly as
// schema.sql declares them.
//
// It runs in the deploy job after schema.sql is applied (which
// creates any table that is missing outright) and before the
// Worker deploy. Adding only what is missing makes it idempotent:
// a run where nothing is missing changes nothing and says so, and
// re-running is always safe.
//
// A column SQLite cannot add to an existing table in place — one
// carrying a primary key or a unique rule, or a default that is
// not a constant — stops the deploy here with a message naming the
// table and the column. Such a column needs a table rebuild by
// hand; the job never guesses and never skips one silently.
//
// Access is the D1 REST API with the deploy job's own credential,
// read from the environment like wrangler reads it:
//   CLOUDFLARE_API_TOKEN   the job's Cloudflare token
//   CLOUDFLARE_ACCOUNT_ID  the Cloudflare account id
// The database is the one named in wrangler.toml, unless
// D1_DATABASE_ID in the environment names another (the scratch
// database rehearsals use that). SCHEMA_FILE and CLOUDFLARE_API_BASE
// exist for those same rehearsals and default to the real schema
// and the real API.

import { readFile } from "node:fs/promises";

const API_BASE = (process.env.CLOUDFLARE_API_BASE || "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const ROOT = new URL("..", import.meta.url);

function fail(message) {
  console.error(`sync-columns: FAILED: ${message}`);
  process.exit(1);
}

// --- Reading the declared shape out of schema.sql ---

// Remove -- comments without touching single-quoted strings, so
// the word hunting below never trips over the file's own prose.
function stripComments(sql) {
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inString) {
      out += c;
      if (c === "'") {
        if (sql[i + 1] === "'") { out += "'"; i++; } else { inString = false; }
      }
      continue;
    }
    if (c === "'") { inString = true; out += c; continue; }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

// Split a CREATE TABLE body into its top-level comma-separated
// parts, leaving commas inside brackets and strings alone.
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inString) {
      if (c === "'") {
        if (body[i + 1] === "'") { i++; } else { inString = false; }
      }
      continue;
    }
    if (c === "'") { inString = true; continue; }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function unquote(token) {
  if (token.length >= 2 && token[0] === '"' && token[token.length - 1] === '"') return token.slice(1, -1);
  if (token.length >= 2 && token[0] === "`" && token[token.length - 1] === "`") return token.slice(1, -1);
  if (token.length >= 2 && token[0] === "[" && token[token.length - 1] === "]") return token.slice(1, -1);
  return token;
}

// The declared shape: [{ table, columns: [{ name, definition }] }]
// in the order schema.sql declares them. Table-level rules (a
// combined primary key, a foreign key written as its own line)
// declare no column and are skipped.
function declaredShape(schemaSql) {
  const sql = stripComments(schemaSql);
  const tables = [];
  const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?/gi;
  let match;
  while ((match = createRe.exec(sql)) !== null) {
    let i = createRe.lastIndex;
    while (i < sql.length && /\s/.test(sql[i])) i++;
    let name;
    if (sql[i] === '"' || sql[i] === "`") {
      const end = sql.indexOf(sql[i], i + 1);
      name = sql.slice(i + 1, end);
      i = end + 1;
    } else {
      const start = i;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      name = sql.slice(start, i);
    }
    while (i < sql.length && /\s/.test(sql[i])) i++;
    if (sql[i] !== "(") fail(`schema.sql: expected ( after CREATE TABLE ${name}`);
    // Scan to the bracket that closes the table, string-aware.
    let depth = 0;
    let inString = false;
    const bodyStart = i + 1;
    let bodyEnd = -1;
    for (; i < sql.length; i++) {
      const c = sql[i];
      if (inString) {
        if (c === "'") {
          if (sql[i + 1] === "'") { i++; } else { inString = false; }
        }
        continue;
      }
      if (c === "'") { inString = true; continue; }
      if (c === "(") depth++;
      if (c === ")") {
        depth--;
        if (depth === 0) { bodyEnd = i; break; }
      }
    }
    if (bodyEnd < 0) fail(`schema.sql: the CREATE TABLE for ${name} never closes`);
    const columns = [];
    for (const part of splitTopLevel(sql.slice(bodyStart, bodyEnd))) {
      const definition = part.trim().replace(/\s+/g, " ");
      if (!definition) continue;
      const firstWord = definition.split(" ")[0].toUpperCase();
      if (["PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "CONSTRAINT"].includes(firstWord)) continue;
      columns.push({ name: unquote(definition.split(" ")[0]), definition });
    }
    tables.push({ table: name, columns });
  }
  return tables;
}

// Why a column cannot be added in place, or null when it can.
// SQLite refuses ALTER TABLE ADD COLUMN for a column that carries
// a primary key or a unique rule, whose default is not a constant
// (an expression in brackets, or CURRENT_TIME and its kin), or
// that demands NOT NULL while giving no constant default to fill
// the rows already there.
function cannotAddReason(definition) {
  if (/\bprimary\s+key\b/i.test(definition)) return "it carries a primary key";
  if (/\bunique\b/i.test(definition)) return "it carries a unique rule";
  if (/\bdefault\s*\(/i.test(definition)) return "its default is an expression, not a constant";
  if (/\bdefault\s+(current_time|current_date|current_timestamp)\b/i.test(definition)) {
    return "its default is the current time, not a constant";
  }
  if (/\bnot\s+null\b/i.test(definition)) {
    const dflt = definition.match(/\bdefault\s+(\S+)/i);
    if (!dflt || /^null$/i.test(dflt[1])) return "it demands NOT NULL but declares no constant default";
  }
  return null;
}

// --- Talking to the live database ---

async function query(databaseId, sql) {
  let response;
  try {
    response = await fetch(`${API_BASE}/accounts/${ACCOUNT_ID}/d1/database/${databaseId}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql }),
    });
  } catch (err) {
    fail(`the D1 API could not be reached: ${err.message}`);
  }
  let body = null;
  try { body = await response.json(); } catch { /* a non-JSON reply is reported below */ }
  if (!response.ok || !body || body.success !== true) {
    const detail = body && Array.isArray(body.errors) && body.errors.length
      ? body.errors.map((e) => e.message).join("; ")
      : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  const entry = Array.isArray(body.result) ? body.result[0] : null;
  return (entry && entry.results) || [];
}

async function main() {
  if (!API_TOKEN) fail("CLOUDFLARE_API_TOKEN is not set in the environment");
  if (!ACCOUNT_ID) fail("CLOUDFLARE_ACCOUNT_ID is not set in the environment");

  const schemaPath = process.env.SCHEMA_FILE || new URL("worker/schema.sql", ROOT).pathname;
  const schemaSql = await readFile(schemaPath, "utf8");
  const shape = declaredShape(schemaSql);
  if (!shape.length) fail("schema.sql declares no tables; nothing to sync against");

  let databaseId = process.env.D1_DATABASE_ID || "";
  if (!databaseId) {
    const toml = await readFile(new URL("wrangler.toml", ROOT), "utf8");
    const found = toml.match(/database_id\s*=\s*"([^"]+)"/);
    if (!found) fail("no D1_DATABASE_ID in the environment and no database_id in wrangler.toml");
    databaseId = found[1];
  }

  let added = 0;
  for (const { table, columns } of shape) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) fail(`schema.sql declares a table name this script cannot quote safely: ${table}`);
    let liveRows;
    try {
      liveRows = await query(databaseId, `PRAGMA table_info("${table}")`);
    } catch (err) {
      fail(`reading the live columns of ${table} failed: ${err.message}`);
    }
    if (!liveRows.length) {
      fail(`table ${table} is declared in schema.sql but does not exist in the database; the schema apply step should have created it`);
    }
    const liveNames = new Set(liveRows.map((row) => row.name));
    for (const column of columns) {
      if (liveNames.has(column.name)) continue;
      const reason = cannotAddReason(column.definition);
      if (reason) {
        fail(`column ${table}.${column.name} is declared in schema.sql but missing from the live database, and it cannot be added in place: ${reason}. It needs a table rebuild by hand.`);
      }
      try {
        await query(databaseId, `ALTER TABLE "${table}" ADD COLUMN ${column.definition}`);
      } catch (err) {
        fail(`adding column ${table}.${column.name} failed: ${err.message}`);
      }
      added++;
      console.log(`Added column ${table}.${column.name} (${column.definition}).`);
    }
  }

  if (added === 0) {
    console.log("All declared columns are already present; nothing to add (0 additions).");
  } else {
    console.log(`Added ${added} column(s); the database now matches schema.sql.`);
  }
}

main().catch((err) => fail(err.message));
