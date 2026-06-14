#!/usr/bin/env node
/**
 * npm run stream:status
 *
 * Prints a quick health summary of the Open Dungeon stream integration:
 *   - Active chat title + ID
 *   - Last story turn (time + excerpt)
 *   - Current vote state
 *   - Image server health
 *
 * Reads OPEN_DUNGEON_URL from .env.local (falls back to http://localhost:3000).
 * No authentication required — all endpoints used are public GET routes.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));

function loadEnvLocal() {
  const p = join(__dir, "..", ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnvLocal();

const base = (process.env.OPEN_DUNGEON_URL || "http://localhost:3000").replace(/\/$/, "");

// ── Helpers ──────────────────────────────────────────────────────────────────

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const CYAN   = "\x1b[36m";
const PURPLE = "\x1b[35m";

function ok(s)   { return `${GREEN}✓${RESET} ${s}`; }
function warn(s) { return `${YELLOW}⚠${RESET} ${s}`; }
function err(s)  { return `${RED}✗${RESET} ${s}`; }
function head(s) { return `\n${BOLD}${CYAN}${s}${RESET}`; }
function dim(s)  { return `${DIM}${s}${RESET}`; }

function reltime(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

async function get(path) {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Checks ───────────────────────────────────────────────────────────────────

async function checkServer() {
  console.log(head("Open Dungeon server"));
  try {
    const health = await get("/api/health");
    console.log(ok(`Reachable at ${base}`));
    if (health.localText?.ok) {
      const models = health.localText.installedModels;
      console.log(ok(`Ollama: ${models.length ? models.join(", ") : "running (no matching models)"}`));
    } else {
      console.log(warn("Ollama: not reachable"));
    }
    if (health.flux?.ok) {
      console.log(ok(`Image server: reachable${health.flux.loaded ? " (model loaded)" : ""}`));
    } else {
      console.log(warn("Image server: not running  →  npm run image:server"));
    }
  } catch (e) {
    console.log(err(`Not reachable: ${e.message}`));
    console.log(dim(`  Is the app running? → npm run dev`));
    return false;
  }
  return true;
}

async function checkStream() {
  console.log(head("Stream status"));
  let status;
  try {
    status = await get("/api/stream/status");
  } catch (e) {
    console.log(err(`Could not fetch stream status: ${e.message}`));
    return;
  }

  if (status.activeChatId) {
    console.log(ok(`Active chat: ${BOLD}${status.chatTitle || "(untitled)"}${RESET}  ${dim(status.activeChatId)}`));
  } else {
    console.log(warn("No active chat set  →  mod types !chat <id> in Twitch chat"));
  }

  if (status.lastTurnAt) {
    const excerpt = status.lastTurnSummary
      ? `"${status.lastTurnSummary.slice(0, 80)}${status.lastTurnSummary.length > 80 ? "…" : ""}"`
      : "(no excerpt)";
    console.log(ok(`Last turn: ${reltime(status.lastTurnAt)}  ${dim(excerpt)}`));
  } else {
    console.log(dim("  No turns submitted yet this session."));
  }

  if (status.messages?.length) {
    const last = status.messages.at(-1);
    const role = last.role === "assistant" ? `${PURPLE}narrator${RESET}` : `${CYAN}player${RESET}`;
    const preview = last.content.replace(/\s+/g, " ").trim().slice(0, 100);
    console.log(dim(`  Latest message (${role}): "${preview}${preview.length >= 100 ? "…" : ""}"`));
  }
}

async function checkVote() {
  console.log(head("Vote state"));
  let vote;
  try {
    vote = await get("/api/stream/vote");
  } catch (e) {
    console.log(err(`Could not fetch vote state: ${e.message}`));
    return;
  }

  if (!vote.active) {
    console.log(dim("  No vote currently open."));
    return;
  }

  const v = vote.vote;
  const timeColor = (v.remainingSeconds ?? 0) <= 5 ? RED : GREEN;
  console.log(ok(`Vote OPEN — ${timeColor}${v.remainingSeconds}s remaining${RESET}  (${v.uniqueVoters ?? 0} voters, ${v.totalVotes ?? 0} votes)`));

  if (v.entries?.length) {
    for (const [i, e] of v.entries.slice(0, 5).entries()) {
      const bar = "█".repeat(Math.round((e.votes / (v.entries[0].votes || 1)) * 10)).padEnd(10, "░");
      const label = e.command === "do"
        ? `!do ${e.text}`
        : e.command === "say"
          ? `!say "${e.text}"`
          : e.command === "continue"
            ? "!continue"
            : `!story ${e.text}`;
      console.log(`  ${i === 0 ? BOLD : ""}${bar} ${e.votes}v  ${label}${RESET}`);
    }
  } else {
    console.log(dim("  No votes cast yet."));
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log(`${BOLD}Open Dungeon stream status${RESET}  ${dim(new Date().toLocaleTimeString())}`);
console.log(dim(`Server: ${base}`));

const serverOk = await checkServer();
if (serverOk) {
  await checkStream();
  await checkVote();
}
console.log("");
