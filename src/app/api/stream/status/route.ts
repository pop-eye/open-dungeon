/**
 * GET  /api/stream/status — public status for the overlay and bot
 * POST /api/stream/status — set the active chat (requires secret)
 */

import { getChat } from "@/lib/db";
import { serverEnv } from "@/lib/server-env";
import { getStreamState, serializeVoteState, setActiveChatId } from "@/lib/stream-state";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const setSchema = z.object({
  activeChatId: z.string().nullable(),
  secret: z.string(),
});

export async function GET() {
  const state = getStreamState();
  const chat = state.activeChatId ? getChat(state.activeChatId) : null;

  const lastMessages = chat?.messages.slice(-5).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    hasImage: Boolean(m.generatedImage?.url),
    imageUrl: m.generatedImage?.url ?? null,
  })) ?? [];

  return Response.json({
    activeChatId: state.activeChatId,
    chatTitle: chat?.title ?? null,
    lastTurnAt: state.lastTurnAt,
    lastTurnSummary: state.lastTurnSummary,
    voting: state.voting ? serializeVoteState(state.voting) : null,
    messages: lastMessages,
  });
}

export async function POST(request: Request) {
  const secret = serverEnv("STREAM_API_SECRET");
  if (!secret) {
    return Response.json({ error: "STREAM_API_SECRET is not configured." }, { status: 503 });
  }

  let body: z.infer<typeof setSchema>;
  try {
    body = setSchema.parse(await request.json());
  } catch (err) {
    return Response.json({ error: "Invalid body.", detail: String(err) }, { status: 400 });
  }

  if (body.secret !== secret) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  setActiveChatId(body.activeChatId);
  return Response.json({ ok: true, activeChatId: body.activeChatId });
}
