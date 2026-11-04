// The D1-shaped database adapter for the self-host server, over
// node:sqlite. The shared core (worker/core.js) speaks to its
// database exactly the way it speaks to Cloudflare D1 — prepare
// a statement, bind values, then run it, read one row with
// first, read rows with all, or run several as one batch — so
// this file's whole job is to give a local SQLite file that
// shape, with the same answers: run reports how many rows
// changed, first answers the row or null, all answers { results },
// and a batch is one transaction that lands whole or not at all.
import { DatabaseSync } from "node:sqlite";

// Values SQLite takes directly; the core binds strings, numbers
// and nulls, and an undefined or a boolean is normalized the way
// D1 normalizes them.
function normalize(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

export function openDatabase(file, schemaSql) {
  const raw = new DatabaseSync(file);
  // The store has more than one legitimate opener: the running
  // server holds it open, and the maintenance commands
  // (--invite, --delete-person) open it beside the server by
  // design — the data file is their meeting point. SQLite gives
  // the file one write lock, and the open itself needs it (the
  // schema's creates below run as writes). With no wait set,
  // SQLite's default is to wait not at all, so any overlap — the
  // server mid-write as a command opens — failed the open
  // outright with "database is locked" (issue #130). Every
  // opener therefore waits here, ahead of the journal pragma
  // and the schema: ten seconds is far beyond any write the
  // app makes, and a store still locked after it is wedged,
  // not busy.
  raw.exec("PRAGMA busy_timeout = 10000");
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");
  // The schema is idempotent (CREATE TABLE IF NOT EXISTS and its
  // kin throughout), so applying it on every start is the first
  // start's setup and every later start's no-op.
  if (schemaSql) raw.exec(schemaSql);
  // CREATE TABLE IF NOT EXISTS never widens a table that
  // already stands, so a data file written by an older build
  // would keep its old shape and the first write naming a
  // newer column would fail. The column sync below adds the
  // declared columns the file is missing, in place — the twin
  // of the Cloudflare deploy's scripts/sync-columns.mjs, for
  // this server's own file.
  if (schemaSql) syncColumns(raw, schemaSql);

  function prepare(sql) {
    return {
      params: [],
      bind(...values) {
        this.params = values.map(normalize);
        return this;
      },
      async run() {
        const info = raw.prepare(sql).run(...this.params);
        return {
          success: true,
          meta: {
            changes: Number(info.changes),
            last_row_id: Number(info.lastInsertRowid),
          },
        };
      },
      async first() {
        const row = raw.prepare(sql).get(...this.params);
        return row === undefined ? null : row;
      },
      async all() {
        return { results: raw.prepare(sql).all(...this.params) };
      },
    };
  }

  return {
    prepare,
    async batch(statements) {
      const results = [];
      raw.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of statements) {
          results.push(await statement.run());
        }
        raw.exec("COMMIT");
      } catch (err) {
        try { raw.exec("ROLLBACK"); } catch (e) { /* the original error stands */ }
        throw err;
      }
      return results;
    },
    close() {
      raw.close();
    },
  };
}

// The columns schema.sql declares, per table, in declaration
// order: [{ table, columns: [{ name, definition }] }]. A small
// mirror of the parser in scripts/sync-columns.mjs, kept to
// what this file needs: comment-stripped SQL, top-level comma
// splitting, and table-level rules skipped, since those
// declare no column.
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
    if (sql[i] !== "(") continue;
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
    if (bodyEnd < 0) continue;
    const columns = [];
    for (const part of splitTopLevel(sql.slice(bodyStart, bodyEnd))) {
      const definition = part.trim().replace(/\s+/g, " ");
      if (!definition) continue;
      const firstWord = definition.split(" ")[0].toUpperCase();
      if (["PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "CONSTRAINT"].includes(firstWord)) continue;
      let columnName = definition.split(" ")[0];
      if (columnName.length >= 2 && columnName.startsWith('"') && columnName.endsWith('"')) {
        columnName = columnName.slice(1, -1);
      }
      columns.push({ name: columnName, definition });
    }
    tables.push({ table: name, columns });
  }
  return tables;
}

// Why a column cannot be added in place, or null when it can —
// the same rules the deploy's column sync applies.
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

// Adds every column schema.sql declares that this file's
// tables are missing. A column SQLite cannot add in place is
// reported and skipped, never guessed at.
function syncColumns(raw, schemaSql) {
  for (const { table, columns } of declaredShape(schemaSql)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) continue;
    const live = raw.prepare(`PRAGMA table_info("${table}")`).all();
    if (!live.length) continue;
    const liveNames = new Set(live.map((row) => row.name));
    for (const column of columns) {
      if (liveNames.has(column.name)) continue;
      const reason = cannotAddReason(column.definition);
      if (reason) {
        console.error(`tasksparkle: column ${table}.${column.name} is missing and cannot be added in place: ${reason}.`);
        continue;
      }
      raw.exec(`ALTER TABLE "${table}" ADD COLUMN ${column.definition}`);
      console.log(`tasksparkle: added column ${table}.${column.name} (${column.definition}).`);
    }
  }
}
