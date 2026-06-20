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
  username: z.string().optional(),
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

// The story route responds with NDJSON (one JSON object per line).
// Consume the stream and reconstruct the final content + imageRequest from
// the "done" event so the bot can echo a snippet in chat.
async function drainStoryStream(
  upstream: Response,
): Promise<{ content: string; imageRequest?: unknown }> {
  if (!upstream.body) return { content: "" };

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let imageRequest: unknown;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "done") {
          if (typeof event.content === "string") content = event.content;
          if (event.imageRequest !== undefined) imageRequest = event.imageRequest;
        } else if (event.type === "delta" && typeof event.text === "string") {
          content += event.text;
        }
      } catch {
        // ignore malformed lines
      }
    }
  }

  return { content, imageRequest };
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

    if (!upstream.ok) {
      const detail = await upstream.json().catch(() => ({}));
      return Response.json(
        { error: "Story generation failed.", detail },
        { status: upstream.status },
      );
    }

    const contentType = upstream.headers.get("content-type") || "";
    let result: { content: string; imageRequest?: unknown };

    if (contentType.includes("application/x-ndjson")) {
      result = await drainStoryStream(upstream);
    } else {
      const json = (await upstream.json()) as { content?: string; imageRequest?: unknown };
      result = { content: json.content ?? "", imageRequest: json.imageRequest };
    }

    // Update stream state so the overlay picks up the new passage.
    const state = getStreamState();
    state.lastTurnAt = Date.now();
    state.lastTurnSummary = result.content.slice(0, 200) || null;
    state.lastSubmittedBy = body.username?.trim() || null;

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
