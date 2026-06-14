/**
 * POST /api/stream/donation
 *
 * Receives donation webhooks from StreamElements or StreamLabs and injects
 * a special story event proportional to the donation amount.
 *
 * StreamElements webhook: configure at streamelements.com → Overlays → Webhooks
 * StreamLabs webhook:     configure at streamlabs.com → Settings → API Settings
 *
 * Required env vars:
 *   STREAM_API_SECRET          — shared secret for internal bot calls
 *   DONATION_WEBHOOK_SECRET    — secret sent in X-Donation-Secret header
 *   DONATION_MIN_AMOUNT        — minimum amount (in currency units) to trigger an event (default 1)
 *   DONATION_CURRENCY          — expected currency code, e.g. "USD" (default: accept any)
 *
 * The donation message (if provided by the donor) is injected into the story
 * as a "story" directive. If no message, a default event fires based on tier.
 */

import { getStreamState } from "@/lib/stream-state";
import { serverEnv } from "@/lib/server-env";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// StreamElements and StreamLabs both send slightly different shapes.
// We normalize them before processing.
const streamElementsSchema = z.object({
  type: z.literal("tip"),
  data: z.object({
    username: z.string(),
    amount: z.number(),
    currency: z.string().optional(),
    message: z.string().optional().default(""),
  }),
});

const streamLabsSchema = z.object({
  type: z.literal("donation"),
  message: z.array(
    z.object({
      name: z.string(),
      amount: z.string().or(z.number()),
      currency: z.string().optional(),
      message: z.string().optional().default(""),
    }),
  ),
});

type DonationEvent = {
  username: string;
  amount: number;
  currency: string;
  message: string;
};

function parseBody(body: unknown): DonationEvent | null {
  // Try StreamElements format
  const se = streamElementsSchema.safeParse(body);
  if (se.success) {
    return {
      username: se.data.data.username,
      amount: se.data.data.amount,
      currency: se.data.data.currency || "USD",
      message: se.data.data.message || "",
    };
  }
  // Try StreamLabs format
  const sl = streamLabsSchema.safeParse(body);
  if (sl.success && sl.data.message.length > 0) {
    const msg = sl.data.message[0];
    return {
      username: msg.name,
      amount: Number(msg.amount),
      currency: msg.currency || "USD",
      message: msg.message || "",
    };
  }
  return null;
}

function buildStoryInjection(event: DonationEvent): string {
  const { username, amount, currency, message } = event;

  if (message.trim()) {
    // Donor left a message — inject it as a story directive
    return `[Donation from ${username} (${amount} ${currency}): ${message.trim()}]`;
  }

  // Tiered default events when no message
  if (amount >= 50) {
    return `[A major patron, ${username}, blesses the story — something dramatic and pivotal happens.]`;
  }
  if (amount >= 10) {
    return `[${username} tips the narrator — add an unexpected twist to the scene.]`;
  }
  return `[${username} supports the story — add a small surprising detail.]`;
}

export async function POST(request: Request) {
  // Validate the webhook secret (sent in a header)
  const webhookSecret = serverEnv("DONATION_WEBHOOK_SECRET");
  if (webhookSecret) {
    const received =
      request.headers.get("X-Donation-Secret") ||
      request.headers.get("X-Webhook-Secret") ||
      "";
    if (received !== webhookSecret) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const event = parseBody(rawBody);
  if (!event) {
    // Unknown format — log and ack to avoid webhook retries
    console.warn("[donation] Unknown webhook payload:", JSON.stringify(rawBody).slice(0, 200));
    return Response.json({ ok: true, processed: false });
  }

  const minAmount = parseFloat(serverEnv("DONATION_MIN_AMOUNT", "1") || "1");
  const expectedCurrency = serverEnv("DONATION_CURRENCY", "");
  if (event.amount < minAmount) {
    return Response.json({ ok: true, processed: false, reason: "Below minimum amount." });
  }
  if (expectedCurrency && event.currency !== expectedCurrency) {
    return Response.json({ ok: true, processed: false, reason: "Currency mismatch." });
  }

  const state = getStreamState();
  if (!state.activeChatId) {
    return Response.json({ ok: true, processed: false, reason: "No active chat." });
  }

  const storyText = buildStoryInjection(event);

  // Inject via the stream/turn endpoint internally
  const secret = serverEnv("STREAM_API_SECRET");
  if (!secret) {
    return Response.json({ error: "STREAM_API_SECRET not configured." }, { status: 503 });
  }

  const baseUrl = serverEnv("NEXTAUTH_URL", `http://127.0.0.1:${process.env.PORT || 3000}`);
  const turnUrl = `${baseUrl.replace(/\/$/, "")}/api/stream/turn`;

  try {
    const upstream = await fetch(turnUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: state.activeChatId,
        command: "story",
        text: storyText,
        secret,
      }),
    });

    const result = await upstream.json();
    return Response.json({
      ok: true,
      processed: true,
      event: { username: event.username, amount: event.amount, currency: event.currency },
      storyInjection: storyText,
      turnResult: upstream.ok ? "submitted" : result,
    });
  } catch (err) {
    return Response.json(
      { error: "Failed to submit story turn.", detail: String(err) },
      { status: 502 },
    );
  }
}
