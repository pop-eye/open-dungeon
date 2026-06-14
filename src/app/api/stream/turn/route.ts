/**
 * POST /api/stream/turn
 *
 * Submits a story turn on behalf of a Twitch viewer or the stream bot.
 * Reads current chat state from the DB, constructs the full story request,
 * and POSTs to /api/story internally.
 *
 * Body: { chatId?, command, text, secret }
 *   chatId   — override the active chat ID (defaults to stream-state activeChatId)
 *   command  — "do" | "say" | "story" | "continue"
 *   text     — the player input (omit/empty for "continue")
 *   secret   — must match STREAM_API_SECRET env var
 */

import { getChat } from "@/lib/db";
import { serverEnv } from "@/lib/server-env";
import { getStreamState } from "@/lib/stream-state";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  chatId: z.string().optional(),
  command: z.enum(["do", "say", "story", "continue"]).default("do"),
  text: z.string().max(500).default(""),
  secret: z.string(),
});

function formatInput(command: string, text: string): string {
  const t = text.trim();
  switch (command) {
    case "do":
      return t.charAt(0).toUpperCase() + t.slice(1);
    case "say":
      return `"${t}"`;
    case "story":
      return t;
    case "continue":
      return "continue";
    default:
      return t;
  }
}

export async function POST(request: Request) {
  const secret = serverEnv("STREAM_API_SECRET");
  if (!secret) {
    return Response.json(
      { error: "STREAM_API_SECRET is not configured." },
      { status: 503 },
    );
  }

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await request.json());
  } catch (err) {
    return Response.json({ error: "Invalid request body.", detail: String(err) }, { status: 400 });
  }

  if (body.secret !== secret) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const chatId = body.chatId || getStreamState().activeChatId;
  if (!chatId) {
    return Response.json(
      { error: "No active chat. Set activeChatId via POST /api/stream/status or pass chatId." },
      { status: 400 },
    );
  }

  const chat = getChat(chatId);
  if (!chat) {
    return Response.json({ error: `Chat not found: ${chatId}` }, { status: 404 });
  }

  const storyMode = body.command === "continue" ? "continue" : "turn";
  const input = formatInput(body.command, body.text);

  if (!input.trim()) {
    return Response.json({ error: "Input is empty." }, { status: 400 });
  }

  // Forward to the story route as a local HTTP request
  const baseUrl = serverEnv("NEXTAUTH_URL", `http://127.0.0.1:${process.env.PORT || 3000}`);
  const storyUrl = `${baseUrl.replace(/\/$/, "")}/api/story`;

  const storyPayload = {
    chatId,
    mode: storyMode,
    input,
    messages: chat.messages,
    attachments: [],
    settings: chat.settings,
  };

  try {
    const upstream = await fetch(storyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(storyPayload),
    });

    const result = await upstream.json();

    if (!upstream.ok) {
      return Response.json(
        { error: "Story generation failed.", detail: result },
        { status: upstream.status },
      );
    }

    // Update stream state for the overlay
    const state = getStreamState();
    state.lastTurnAt = Date.now();
    state.lastTurnSummary =
      typeof result.content === "string"
        ? result.content.slice(0, 200)
        : null;

    return Response.json({
      ok: true,
      chatId,
      command: body.command,
      input,
      response: result,
    });
  } catch (err) {
    return Response.json(
      { error: "Failed to reach story route.", detail: String(err) },
      { status: 502 },
    );
  }
}
