/**
 * /api/stream/vote — Twitch audience voting management
 *
 * GET  — current vote state (public, for the overlay)
 * POST — cast a vote or manage the vote lifecycle
 *
 * Bot actions (require secret):
 *   { action: "open",  chatId, windowSeconds? }  — open a new vote window
 *   { action: "close" }                           — close and return winner
 *   { action: "cancel" }                          — discard current vote
 *
 * Viewer vote (require secret):
 *   { action: "cast", username, command, text }   — cast/replace a vote
 */

import { serverEnv } from "@/lib/server-env";
import {
  castVote,
  clearVote,
  closeVote,
  getStreamState,
  openVote,
  serializeVoteState,
} from "@/lib/stream-state";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const openSchema = z.object({
  action: z.literal("open"),
  secret: z.string(),
  chatId: z.string().optional(),
  windowSeconds: z.number().int().min(10).max(300).default(30),
});

const closeSchema = z.object({
  action: z.enum(["close", "cancel"]),
  secret: z.string(),
});

const castSchema = z.object({
  action: z.literal("cast"),
  secret: z.string(),
  username: z.string().min(1).max(64),
  command: z.enum(["do", "say", "story", "continue"]),
  text: z.string().max(500).default(""),
});

const bodySchema = z.discriminatedUnion("action", [openSchema, closeSchema, castSchema]);

function checkSecret(secret: string) {
  const expected = serverEnv("STREAM_API_SECRET");
  if (!expected) return "STREAM_API_SECRET is not configured.";
  if (secret !== expected) return "Unauthorized.";
  return null;
}

export async function GET() {
  const vote = getStreamState().voting;
  if (!vote) {
    return Response.json({ active: false });
  }
  return Response.json({ active: true, vote: serializeVoteState(vote) });
}

export async function POST(request: Request) {
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    return Response.json({ error: "Invalid request.", detail: String(err) }, { status: 400 });
  }

  const authError = checkSecret(body.secret);
  if (authError) {
    return Response.json(
      { error: authError },
      { status: authError.includes("configured") ? 503 : 401 },
    );
  }

  const state = getStreamState();

  if (body.action === "open") {
    const chatId = body.chatId || state.activeChatId;
    if (!chatId) {
      return Response.json({ error: "No active chat to vote for." }, { status: 400 });
    }
    const vote = openVote(chatId, body.windowSeconds);
    return Response.json({ ok: true, vote: serializeVoteState(vote) });
  }

  if (body.action === "cancel") {
    clearVote();
    return Response.json({ ok: true });
  }

  if (body.action === "close") {
    const winner = closeVote();
    if (!winner) {
      return Response.json({ ok: true, winner: null, message: "No votes were cast." });
    }
    return Response.json({ ok: true, winner });
  }

  if (body.action === "cast") {
    if (!state.voting) {
      return Response.json({ error: "No vote is currently open." }, { status: 409 });
    }
    if (Date.now() > state.voting.closesAt) {
      return Response.json({ error: "Vote window has closed." }, { status: 409 });
    }
    castVote(state.voting, body.username, body.command, body.text);
    return Response.json({ ok: true, vote: serializeVoteState(state.voting) });
  }

  return Response.json({ error: "Unknown action." }, { status: 400 });
}
