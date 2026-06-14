#!/usr/bin/env node
/**
 * Open Dungeon — Twitch chat bot
 *
 * Reads Twitch chat commands and submits them to the story via the
 * /api/stream/* endpoints on the running Open Dungeon server.
 *
 * Commands (chat):
 *   !do <action>      — player performs an action    ("!do grab the sword")
 *   !say <words>      — player says something         ("!say Who are you?")
 *   !story <directive>— narrator directive             ("!story describe the storm")
 *   !continue         — advance the story without input
 *   !vote             — open a voting round (mod/broadcaster only)
 *   !endvote          — close the vote and submit the winner (mod only)
 *   !cancelvote       — discard the current vote (mod only)
 *   !chat <id>        — set the active chat ID (mod only)
 *   !odhelp           — show available commands
 *
 * Voting mode:
 *   When a vote is open, !do / !say / !story / !continue count as votes.
 *   Each viewer gets one vote; re-voting replaces the previous.
 *   After VOTE_WINDOW_SECONDS the bot closes the vote and submits the winner.
 *
 * Required env vars (copy twitch-bot/.env.example to twitch-bot/.env):
 *   TWITCH_BOT_USERNAME    — the bot account username
 *   TWITCH_BOT_OAUTH_TOKEN — oauth:XXXXXX from https://twitchapps.com/tmi/
 *   TWITCH_CHANNEL         — channel to join (without #)
 *   OPEN_DUNGEON_URL       — base URL of the Open Dungeon server (default: http://localhost:3000)
 *   STREAM_API_SECRET      — must match the server's STREAM_API_SECRET
 *   VOTE_WINDOW_SECONDS    — seconds to collect votes (default: 30)
 *   VOTE_COOLDOWN_SECONDS  — minimum gap between auto-close and next vote (default: 10)
 *   MOD_ONLY_VOTE_OPEN     — "true" to require mod/broadcaster to open votes (default: true)
 *   DIRECT_SUBMIT          — "true" to skip voting and submit the first valid command directly (default: false)
 *   RATE_LIMIT_SECONDS     — min seconds between submissions in direct mode (default: 10)
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));

// Load env files — simple parser, no dotenv dependency.
// Resolution order (later files win, but existing process.env always wins):
//   1. project root .env.local  — shared secrets (STREAM_API_SECRET, etc.)
//   2. twitch-bot/.env          — bot-specific overrides
function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf("=");
    if (sep < 0) continue;
    const key = trimmed.slice(0, sep).trim();
    let val = trimmed.slice(sep + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

function loadEnv() {
  // Root .env.local first (lower priority — bot's own .env can override)
  parseEnvFile(join(__dir, "..", ".env.local"));
  parseEnvFile(join(__dir, ".env"));
}
loadEnv();

// tmi.js is a CommonJS package; use createRequire to import it from ESM
const require = createRequire(import.meta.url);
let tmi;
try {
  tmi = require("tmi.js");
} catch {
  console.error("[bot] tmi.js not found. Run: npm install");
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────────────────────

const cfg = {
  username: process.env.TWITCH_BOT_USERNAME || "",
  token: process.env.TWITCH_BOT_OAUTH_TOKEN || "",
  channel: (process.env.TWITCH_CHANNEL || "").replace(/^#/, ""),
  serverUrl: (process.env.OPEN_DUNGEON_URL || "http://localhost:3000").replace(/\/$/, ""),
  secret: process.env.STREAM_API_SECRET || "",
  voteWindowSeconds: parseInt(process.env.VOTE_WINDOW_SECONDS || "30", 10),
  voteCooldownSeconds: parseInt(process.env.VOTE_COOLDOWN_SECONDS || "10", 10),
  modOnlyVoteOpen: process.env.MOD_ONLY_VOTE_OPEN !== "false",
  directSubmit: process.env.DIRECT_SUBMIT === "true",
  rateLimitSeconds: parseInt(process.env.RATE_LIMIT_SECONDS || "10", 10),
};

function validate() {
  const missing = ["username", "token", "channel", "secret"].filter((k) => !cfg[k]);
  if (missing.length) {
    console.error(`[bot] Missing required env vars: ${missing.map((k) => k.toUpperCase()).join(", ")}`);
    console.error("[bot] Copy twitch-bot/.env.example to twitch-bot/.env and fill it in.");
    process.exit(1);
  }
}
validate();

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiPost(path, body) {
  const res = await fetch(`${cfg.serverUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, secret: cfg.secret }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error || json.detail || `HTTP ${res.status}`);
  }
  return json;
}

async function apiGet(path) {
  const res = await fetch(`${cfg.serverUrl}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Vote state ────────────────────────────────────────────────────────────────

let voteTimer = null;
let lastSubmitAt = 0;
let voteCooldownUntil = 0;

async function openVote(client, channel, windowSeconds) {
  windowSeconds = windowSeconds || cfg.voteWindowSeconds;
  try {
    const status = await apiGet("/api/stream/status");
    if (!status.activeChatId) {
      client.say(channel, "❌ No active chat. A mod needs to run !chat <id> first.");
      return;
    }
    await apiPost("/api/stream/vote", { action: "open", windowSeconds });
    client.say(
      channel,
      `🗳️ Vote open for ${windowSeconds}s! Use !do <action>, !say <words>, !story <directive>, or !continue to vote.`,
    );
    if (voteTimer) clearTimeout(voteTimer);
    voteTimer = setTimeout(() => closeVoteAuto(client, channel), windowSeconds * 1000);
  } catch (err) {
    client.say(channel, `❌ Could not open vote: ${err.message}`);
  }
}

async function closeVoteAuto(client, channel) {
  voteTimer = null;
  try {
    const result = await apiPost("/api/stream/vote", { action: "close" });
    if (!result.winner) {
      client.say(channel, "🗳️ Vote closed — no votes were cast.");
      return;
    }
    const { command, text, votes } = result.winner;
    const display =
      command === "do"
        ? `Do: "${text}"`
        : command === "say"
          ? `Say: "${text}"`
          : command === "continue"
            ? "Continue…"
            : `Story: "${text}"`;
    client.say(channel, `🗳️ Vote closed! Submitting (${votes} vote${votes !== 1 ? "s" : ""}): ${display}`);

    // Submit the winning turn
    await submitTurn(client, channel, command, text);
    voteCooldownUntil = Date.now() + cfg.voteCooldownSeconds * 1000;
  } catch (err) {
    client.say(channel, `❌ Error closing vote: ${err.message}`);
  }
}

async function submitTurn(client, channel, command, text) {
  try {
    const result = await apiPost("/api/stream/turn", { command, text });
    // Announce a snippet of the response in chat (truncated to Twitch's 500 char limit)
    if (result.response?.content) {
      const snippet = result.response.content.replace(/\s+/g, " ").trim().slice(0, 220);
      client.say(channel, `📖 ${snippet}${result.response.content.length > 220 ? "…" : ""}`);
    }
  } catch (err) {
    client.say(channel, `❌ Story error: ${err.message}`);
  }
}

// ── Command handling ──────────────────────────────────────────────────────────

const COMMANDS = ["!do", "!say", "!story", "!continue"];

function isMod(tags) {
  return tags.mod || tags.badges?.broadcaster || tags["user-type"] === "mod";
}

async function handleCommand(client, channel, tags, message) {
  const username = tags.username || tags["display-name"] || "unknown";
  const parts = message.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const rest = parts.slice(1).join(" ").trim();

  // Mod-only commands
  if (cmd === "!vote") {
    if (cfg.modOnlyVoteOpen && !isMod(tags)) return;
    const secs = rest ? parseInt(rest, 10) : undefined;
    await openVote(client, channel, isNaN(secs) ? undefined : secs);
    return;
  }

  if (cmd === "!endvote") {
    if (!isMod(tags)) return;
    if (voteTimer) { clearTimeout(voteTimer); voteTimer = null; }
    await closeVoteAuto(client, channel);
    return;
  }

  if (cmd === "!cancelvote") {
    if (!isMod(tags)) return;
    if (voteTimer) { clearTimeout(voteTimer); voteTimer = null; }
    await apiPost("/api/stream/vote", { action: "cancel" }).catch(() => {});
    client.say(channel, "🗳️ Vote cancelled.");
    return;
  }

  if (cmd === "!chat") {
    if (!isMod(tags)) return;
    const chatId = rest.trim();
    if (!chatId) { client.say(channel, "Usage: !chat <chatId>"); return; }
    await apiPost("/api/stream/status", { activeChatId: chatId });
    client.say(channel, `✅ Active chat set to: ${chatId}`);
    return;
  }

  if (cmd === "!odhelp") {
    client.say(
      channel,
      "📖 Open Dungeon commands: !do <action> | !say <words> | !story <directive> | !continue | " +
        "(mods) !vote [seconds] | !endvote | !cancelvote | !chat <id>",
    );
    return;
  }

  // Story commands
  if (!COMMANDS.includes(cmd)) return;

  const command = cmd.slice(1); // strip !
  const text = rest;

  if ((command === "do" || command === "say" || command === "story") && !text) return;

  // Check if a vote is open — cast vote instead of direct submit
  try {
    const voteState = await apiGet("/api/stream/vote");
    if (voteState.active) {
      await apiPost("/api/stream/vote", { action: "cast", username, command, text });
      // Optional: reply with confirmation (can be spammy in large chats)
      // client.say(channel, `@${username} voted: !${command} ${text}`);
      return;
    }
  } catch {
    // If vote state fails to fetch, fall through to direct submit
  }

  // Direct submit mode
  if (!cfg.directSubmit) return;

  const now = Date.now();
  if (now < voteCooldownUntil) return;
  if (now - lastSubmitAt < cfg.rateLimitSeconds * 1000) {
    client.say(channel, `⏳ @${username} story is still being written, please wait.`);
    return;
  }

  lastSubmitAt = Date.now();
  client.say(channel, `📝 Submitting ${command} from @${username}…`);
  await submitTurn(client, channel, command, text);
}

// ── Connect ───────────────────────────────────────────────────────────────────

const client = new tmi.Client({
  options: { debug: false },
  identity: {
    username: cfg.username,
    password: cfg.token,
  },
  channels: [cfg.channel],
});

client.on("message", async (channel, tags, message, self) => {
  if (self) return;
  if (!message.startsWith("!")) return;
  try {
    await handleCommand(client, channel, tags, message);
  } catch (err) {
    console.error(`[bot] Unhandled error for message "${message}":`, err);
  }
});

client.on("connected", (addr, port) => {
  console.log(`[bot] Connected to ${addr}:${port} — watching #${cfg.channel}`);
  console.log(`[bot] Server: ${cfg.serverUrl}`);
  if (cfg.directSubmit) {
    console.log(`[bot] Mode: direct submit (rate limit: ${cfg.rateLimitSeconds}s)`);
  } else {
    console.log(`[bot] Mode: voting (window: ${cfg.voteWindowSeconds}s)`);
  }
});

client.on("disconnected", (reason) => {
  console.warn(`[bot] Disconnected: ${reason}`);
});

await client.connect();
