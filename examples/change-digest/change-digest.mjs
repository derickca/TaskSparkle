#!/usr/bin/env node
// TaskSparkle change digest: a small example of the watching
// pattern described in docs/watching-for-changes.md.
//
// It polls the version with an agent key. When the number has
// moved, it reads the whole state and prints a plain digest of
// what changed since the snapshot kept beside this script.
//
// Set two environment values before running it:
//
//   TASKSparkle_AGENT_URL  the agents door, for example
//                          https://tasksparkle-api.example.com
//                          or http://your-machine.local:8080
//   TASKSparkle_AGENT_KEY  one person's agent key
//
// The optional TASKSparkle_DIGEST_SNAPSHOT value names another
// snapshot file. Keeping a separate snapshot per person matters:
// a snapshot belongs to the owner whose key made it.
//
// The script uses only Node's standard library. It sends the
// digest to standard output and leaves delivery to the reader:
// print it, save it or hand it to a scheduler and a chat tool.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = process.env.TASKSparkle_DIGEST_SNAPSHOT || join(SCRIPT_DIR, "snapshot.json");
const RAW_URL = process.env.TASKSparkle_AGENT_URL || "";
const KEY = process.env.TASKSparkle_AGENT_KEY || "";

if (!RAW_URL || !KEY) {
  console.error("Set TASKSparkle_AGENT_URL and TASKSparkle_AGENT_KEY before running this example.");
  process.exit(2);
}

const BASE = RAW_URL.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
const HEADERS = {
  Accept: "application/json",
  Authorization: "Bearer " + KEY,
  // The directions ask agents to send an ordinary browser
  // User-Agent. Some doors refuse a library default before
  // they read the key.
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 TaskSparkleChangeDigest/1.0",
};

async function getJson(path) {
  let response;
  try {
    response = await fetch(BASE + path, { headers: HEADERS });
  } catch (error) {
    throw new Error("Could not reach " + BASE + path + ": " + error.message);
  }
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch (error) { /* handled below */ }
  if (!response.ok) {
    const detail = body && body.error ? body.error : text.slice(0, 200);
    throw new Error("GET " + path + " answered " + response.status + (detail ? ": " + detail : ""));
  }
  if (!body || typeof body !== "object") {
    throw new Error("GET " + path + " did not answer with JSON.");
  }
  return body;
}

function saveSnapshot(state) {
  const temporary = SNAPSHOT_PATH + ".tmp";
  writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(temporary, SNAPSHOT_PATH);
}

function byId(items) {
  return new Map((items || []).map((item) => [item.id, item]));
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function quoted(value) {
  return JSON.stringify(value == null || value === "" ? "(none)" : String(value));
}

function stamp(value) {
  return value ? "agent key " + quoted(value) : "the person (no key stamp)";
}

const NO_STAMP = "no stamp; do not attribute this change";

function boardName(state, boardId) {
  const board = (state.boards || []).find((item) => item.id === boardId);
  return board ? board.name : "(board no longer present)";
}

function boardForCard(state, card) {
  return (state.boards || []).find((item) => item.id === card.boardId) || null;
}

function location(state, card) {
  const board = boardForCard(state, card);
  if (!board) return boardName(state, card.boardId) + " / (column no longer present)";
  const column = (board.columns || []).find((item) => item.kind === card.columnId);
  return board.name + " / " + (column ? column.name : card.columnId || "(unknown column)");
}

function labelNames(state, card) {
  const labels = byId(state.labels || []);
  return (card.labels || []).map((id) => labels.get(id)?.name || id);
}

function projectName(state, card) {
  if (!card.projectId) return null;
  const project = (state.projects || []).find((item) => item.id === card.projectId);
  return project ? project.name : card.projectId;
}

function pushComment(lines, comment, prefix) {
  lines.push(prefix + "Comment by " + stamp(comment.authorKeyName) + ":");
  const body = String(comment.body || "");
  for (const line of body.split(/\r?\n/)) lines.push("    " + line);
}

function diffSteps(lines, beforeCard, afterCard) {
  const before = byId(beforeCard.steps || []);
  const after = byId(afterCard.steps || []);
  for (const step of afterCard.steps || []) {
    const old = before.get(step.id);
    if (!old) {
      lines.push("  - Checklist step added: " + quoted(step.text) + (step.done ? " (ticked)" : "") + " [" + NO_STAMP + "]");
    } else {
      if (old.text !== step.text) lines.push("  - Checklist step renamed: " + quoted(old.text) + " -> " + quoted(step.text) + " [" + NO_STAMP + "]");
      if (!!old.done !== !!step.done) lines.push("  - Checklist step " + (step.done ? "ticked" : "unticked") + ": " + quoted(step.text) + " [" + NO_STAMP + "]");
    }
  }
  for (const step of beforeCard.steps || []) {
    if (!after.has(step.id)) lines.push("  - Checklist step removed: " + quoted(step.text) + " [" + NO_STAMP + "]");
  }
  const beforeOrder = (beforeCard.steps || []).map((step) => step.id).join("\n");
  const afterOrder = (afterCard.steps || []).map((step) => step.id).join("\n");
  if (beforeOrder !== afterOrder && before.size === after.size && [...before.keys()].every((id) => after.has(id))) {
    lines.push("  - Checklist order changed [" + NO_STAMP + "]");
  }
}

function diffLinks(lines, beforeCard, afterCard) {
  const before = byId(beforeCard.links || []);
  const after = byId(afterCard.links || []);
  for (const link of afterCard.links || []) {
    const old = before.get(link.id);
    const label = link.name ? link.name + " <" + link.url + ">" : link.url;
    if (!old) {
      lines.push("  - Link added: " + label + " [" + NO_STAMP + "]");
    } else if (old.url !== link.url || old.name !== link.name) {
      const oldLabel = old.name ? old.name + " <" + old.url + ">" : old.url;
      lines.push("  - Link changed: " + oldLabel + " -> " + label + " [" + NO_STAMP + "]");
    }
  }
  for (const link of beforeCard.links || []) {
    if (!after.has(link.id)) {
      const label = link.name ? link.name + " <" + link.url + ">" : link.url;
      lines.push("  - Link removed: " + label + " [" + NO_STAMP + "]");
    }
  }
  const beforeOrder = (beforeCard.links || []).map((link) => link.id).join("\n");
  const afterOrder = (afterCard.links || []).map((link) => link.id).join("\n");
  if (beforeOrder !== afterOrder && before.size === after.size && [...before.keys()].every((id) => after.has(id))) {
    lines.push("  - Link order changed [" + NO_STAMP + "]");
  }
}

function diffComments(lines, beforeCard, afterCard, afterState) {
  const before = byId(beforeCard.comments || []);
  const after = byId(afterCard.comments || []);
  for (const comment of afterCard.comments || []) {
    if (!before.has(comment.id)) {
      lines.push("Comment added on " + quoted(afterCard.title) + " in " + location(afterState, afterCard) + ":");
      pushComment(lines, comment, "  ");
    }
  }
  for (const comment of beforeCard.comments || []) {
    if (!after.has(comment.id)) {
      lines.push("Comment removed from " + quoted(afterCard.title) + ". The removed comment was by " + stamp(comment.authorKeyName) + "; the removal itself has " + NO_STAMP + ":");
      const body = String(comment.body || "");
      for (const line of body.split(/\r?\n/)) lines.push("    " + line);
    }
  }
}

function diffCard(lines, beforeCard, afterCard, beforeState, afterState) {
  const changes = [];
  const beforePlace = location(beforeState, beforeCard);
  const afterPlace = location(afterState, afterCard);
  if (beforeCard.title !== afterCard.title) changes.push("title " + quoted(beforeCard.title) + " -> " + quoted(afterCard.title));
  if (beforePlace !== afterPlace) changes.push("place " + beforePlace + " -> " + afterPlace);
  if ((beforeCard.notes || "") !== (afterCard.notes || "")) changes.push("notes changed");
  if (!same(labelNames(beforeState, beforeCard), labelNames(afterState, afterCard))) {
    changes.push("labels " + (labelNames(beforeState, beforeCard).join(", ") || "(none)") + " -> " + (labelNames(afterState, afterCard).join(", ") || "(none)"));
  }
  if (projectName(beforeState, beforeCard) !== projectName(afterState, afterCard)) {
    changes.push("project " + quoted(projectName(beforeState, beforeCard)) + " -> " + quoted(projectName(afterState, afterCard)));
  }
  if ((beforeCard.due || "") !== (afterCard.due || "")) changes.push("due " + quoted(beforeCard.due) + " -> " + quoted(afterCard.due));
  if (!!beforeCard.archived !== !!afterCard.archived) changes.push(afterCard.archived ? "archived" : "restored");
  if (!!beforeCard.important !== !!afterCard.important) changes.push(afterCard.important ? "marked Important" : "Important removed");
  if (beforeCard.position !== afterCard.position && beforePlace === afterPlace) changes.push("position changed");

  if (changes.length) {
    lines.push("Card changed: " + quoted(afterCard.title) + " in " + afterPlace + " [" + NO_STAMP + "]");
    for (const change of changes) lines.push("  - " + change);
  }
  diffSteps(lines, beforeCard, afterCard);
  diffLinks(lines, beforeCard, afterCard);
  if (changes.length || !same(beforeCard.steps || [], afterCard.steps || []) || !same(beforeCard.links || [], afterCard.links || [])) {
    // Step and link entries already carry their own headings.
    // Their card context is the changed-card line when present;
    // add one when those were the only changes.
    if (!changes.length) {
      const detailStart = lines.length - (countDetailLines(lines));
      if (detailStart >= 0) lines.splice(detailStart, 0, "Card changed: " + quoted(afterCard.title) + " in " + afterPlace + " [" + NO_STAMP + "]");
    }
  }
  diffComments(lines, beforeCard, afterCard, afterState);
}

function countDetailLines(lines) {
  let count = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("  - Checklist") || lines[i].startsWith("  - Link")) count++;
    else break;
  }
  return count;
}

function diffNamedThings(lines, kind, beforeItems, afterItems, describe) {
  const before = byId(beforeItems || []);
  const after = byId(afterItems || []);
  for (const item of afterItems || []) {
    const old = before.get(item.id);
    if (!old) lines.push(kind + " added: " + describe(item, null) + " [" + NO_STAMP + "]");
    else if (!same(old, item)) lines.push(kind + " changed: " + describe(item, old) + " [" + NO_STAMP + "]");
  }
  for (const item of beforeItems || []) {
    if (!after.has(item.id)) lines.push(kind + " removed: " + describe(null, item) + " [" + NO_STAMP + "]");
  }
}

function diffBoards(lines, beforeState, afterState) {
  const before = byId(beforeState.boards || []);
  const after = byId(afterState.boards || []);
  for (const board of afterState.boards || []) {
    const old = before.get(board.id);
    if (!old) {
      lines.push("Board added: " + quoted(board.name) + " [" + NO_STAMP + "]");
    } else {
      const changes = [];
      if (old.name !== board.name) changes.push("name " + quoted(old.name) + " -> " + quoted(board.name));
      if (old.icon !== board.icon) changes.push("icon changed");
      if (old.position !== board.position) changes.push("position changed");
      if (changes.length) lines.push("Board changed: " + quoted(board.name) + " — " + changes.join("; ") + " [" + NO_STAMP + "]");
      const beforeColumns = byId(old.columns || []);
      const afterColumns = byId(board.columns || []);
      for (const column of board.columns || []) {
        const oldColumn = beforeColumns.get(column.id);
        if (!oldColumn) lines.push("Column added on " + quoted(board.name) + ": " + quoted(column.name) + " [" + NO_STAMP + "]");
        else if (oldColumn.name !== column.name || oldColumn.icon !== column.icon || oldColumn.position !== column.position) {
          lines.push("Column changed on " + quoted(board.name) + ": " + quoted(oldColumn.name) + " -> " + quoted(column.name) + " [" + NO_STAMP + "]");
        }
      }
      for (const column of old.columns || []) {
        if (!afterColumns.has(column.id)) lines.push("Column removed from " + quoted(old.name) + ": " + quoted(column.name) + " [" + NO_STAMP + "]");
      }
    }
  }
  for (const board of beforeState.boards || []) {
    if (!after.has(board.id)) lines.push("Board removed: " + quoted(board.name) + " [" + NO_STAMP + "]");
  }
}

function diffStates(beforeState, afterState) {
  const lines = [];
  diffBoards(lines, beforeState, afterState);
  diffNamedThings(lines, "Label", beforeState.labels, afterState.labels, (item, old) => {
    const value = item || old;
    return quoted(value.name) + " on " + quoted(boardName(item ? afterState : beforeState, value.boardId));
  });
  diffNamedThings(lines, "Project", beforeState.projects, afterState.projects, (item, old) => {
    const value = item || old;
    return quoted(value.name) + " on " + quoted(boardName(item ? afterState : beforeState, value.boardId));
  });

  const beforeCards = byId(beforeState.cards || []);
  const afterCards = byId(afterState.cards || []);
  for (const card of afterState.cards || []) {
    const old = beforeCards.get(card.id);
    if (!old) {
      lines.push("Card added: " + quoted(card.title) + " in " + location(afterState, card) + " [creator: " + stamp(card.creatorKeyName) + "]");
      if (card.notes) lines.push("  Notes: " + card.notes);
      for (const comment of card.comments || []) pushComment(lines, comment, "  ");
    } else {
      diffCard(lines, old, card, beforeState, afterState);
    }
  }
  for (const card of beforeState.cards || []) {
    if (!afterCards.has(card.id)) {
      lines.push("Card removed: " + quoted(card.title) + " from " + location(beforeState, card) + " [" + NO_STAMP + "]");
    }
  }
  return lines;
}

async function main() {
  const version = await getJson("/api/v1/version");
  if (!existsSync(SNAPSHOT_PATH)) {
    const state = await getJson("/api/v1/state");
    saveSnapshot(state);
    console.log("First run: saved a snapshot at version " + state.version + ". Later runs will print changes from that point.");
    return;
  }

  let beforeState;
  try {
    beforeState = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  } catch (error) {
    throw new Error("The snapshot at " + SNAPSHOT_PATH + " is not readable JSON. Move it aside and run the example again to start a fresh snapshot.");
  }

  if (version.version === beforeState.version) {
    console.log("No changes since version " + beforeState.version + ".");
    return;
  }

  const afterState = await getJson("/api/v1/state");
  const ownerChanged = beforeState.me && afterState.me && beforeState.me.id !== afterState.me.id;
  if (ownerChanged || afterState.version < beforeState.version) {
    saveSnapshot(afterState);
    console.log("The boards do not continue from the saved snapshot, so no diff was printed. Saved a fresh snapshot at version " + afterState.version + ".");
    return;
  }

  const lines = diffStates(beforeState, afterState);
  saveSnapshot(afterState);
  console.log("TaskSparkle changes: version " + beforeState.version + " -> " + afterState.version);
  if (!lines.length) {
    console.log("The version rose, but the visible boards, cards and comments match the saved snapshot.");
  } else {
    for (const line of lines) console.log(line);
  }
}

main().catch((error) => {
  console.error("Change digest failed: " + error.message);
  process.exit(1);
});
