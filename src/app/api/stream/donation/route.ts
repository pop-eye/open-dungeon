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

import { getStreamState, canFireDonation } from "@/lib/stream-state";
import { serverEnv } from "@/lib/server-env";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// StreamElements and StreamLabs both send slightly different shapes.
// We normalize them before processing.

// Tips / monetary donations
const streamElementsTipSchema = z.object({
  type: z.literal("tip"),
  data: z.object({
    username: z.string(),
    amount: z.number(),
    currency: z.string().optional(),
    message: z.string().optional().default(""),
  }),
});

const streamLabsDonationSchema = z.object({
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

// Subscriptions (StreamElements)
const streamElementsSubSchema = z.object({
  type: z.union([z.literal("subscriber"), z.literal("resub"), z.literal("giftsub")]),
  data: z.object({
    displayName: z.string().optional(),
    username: z.string().optional(),
    gifterDisplayName: z.string().optional(),
    gifterUsername: z.string().optional(),
    amount: z.number().optional(),    // giftsub: number of gifted subs
    message: z.string().optional().default(""),
    tier: z.string().optional(),      // "1000" | "2000" | "3000"
  }),
});

// Bits (StreamElements)
const streamElementsBitsSchema = z.object({
  type: z.literal("cheer"),
  data: z.object({
    displayName: z.string().optional(),
    username: z.string().optional(),
    amount: z.number(),
    message: z.string().optional().default(""),
  }),
});

// Bits (StreamLabs)
const streamLabsBitsSchema = z.object({
  type: z.literal("bits"),
  message: z.array(
    z.object({
      name: z.string(),
      amount: z.string().or(z.number()),
      message: z.string().optional().default(""),
    }),
  ),
});

// StreamLabs subscriptions
const streamLabsSubSchema = z.object({
  type: z.union([z.literal("subscription"), z.literal("resub"), z.literal("giftsub")]),
  message: z.array(
    z.object({
      name: z.string(),
      displayName: z.string().optional(),
      gifterName: z.string().optional(),
      months: z.number().optional(),
      message: z.string().optional().default(""),
      sub_plan: z.string().optional(),
    }),
  ),
});

type DonationEventKind = "tip" | "sub" | "bits";

type DonationEvent = {
  kind: DonationEventKind;
  username: string;
  /** USD-equivalent amount; for bits/subs, converted via BITS_TO_USD_RATE */
  amount: number;
  currency: string;
  message: string;
  /** Raw bits or sub count before conversion */
  rawAmount?: number;
};

function bitsToUsd(bits: number): number {
  const rate = parseFloat(serverEnv("BITS_TO_USD_RATE", "0.01") || "0.01");
  return bits * rate;
}

function subTierToUsd(tier: string | undefined, count: number = 1): number {
  // Twitch sub tiers: 1000=$4.99, 2000=$9.99, 3000=$24.99 (broadcaster gets ~50%)
  const tierValues: Record<string, number> = { "1000": 4.99, "2000": 9.99, "3000": 24.99 };
  return (tierValues[tier ?? "1000"] ?? 4.99) * count;
}

function parseBody(body: unknown): DonationEvent | null {
  // StreamElements tip
  const se = streamElementsTipSchema.safeParse(body);
  if (se.success) {
    return {
      kind: "tip",
      username: se.data.data.username,
      amount: se.data.data.amount,
      currency: se.data.data.currency || "USD",
      message: se.data.data.message || "",
    };
  }

  // StreamLabs donation
  const sl = streamLabsDonationSchema.safeParse(body);
  if (sl.success && sl.data.message.length > 0) {
    const msg = sl.data.message[0];
    return {
      kind: "tip",
      username: msg.name,
      amount: Number(msg.amount),
      currency: msg.currency || "USD",
      message: msg.message || "",
    };
  }

  // StreamElements bits/cheer
  const seBits = streamElementsBitsSchema.safeParse(body);
  if (seBits.success) {
    const bits = seBits.data.data.amount;
    return {
      kind: "bits",
      username: seBits.data.data.displayName || seBits.data.data.username || "anonymous",
      amount: bitsToUsd(bits),
      currency: "USD",
      message: seBits.data.data.message || "",
      rawAmount: bits,
    };
  }

  // StreamLabs bits
  const slBits = streamLabsBitsSchema.safeParse(body);
  if (slBits.success && slBits.data.message.length > 0) {
    const msg = slBits.data.message[0];
    const bits = Number(msg.amount);
    return {
      kind: "bits",
      username: msg.name,
      amount: bitsToUsd(bits),
      currency: "USD",
      message: msg.message || "",
      rawAmount: bits,
    };
  }

  // StreamElements subscriber / resub / giftsub
  const seSub = streamElementsSubSchema.safeParse(body);
  if (seSub.success) {
    const d = seSub.data.data;
    const isGift = seSub.data.type === "giftsub";
    const username = isGift
      ? (d.gifterDisplayName || d.gifterUsername || "anonymous")
      : (d.displayName || d.username || "anonymous");
    const count = isGift ? (d.amount || 1) : 1;
    return {
      kind: "sub",
      username,
      amount: subTierToUsd(d.tier, count),
      currency: "USD",
      message: d.message || "",
      rawAmount: count,
    };
  }

  // StreamLabs subscription
  const slSub = streamLabsSubSchema.safeParse(body);
  if (slSub.success && slSub.data.message.length > 0) {
    const msg = slSub.data.message[0];
    const isGift = slSub.data.type === "giftsub";
    const username = isGift ? (msg.gifterName || msg.name) : msg.name;
    return {
      kind: "sub",
      username,
      amount: subTierToUsd(msg.sub_plan, 1),
      currency: "USD",
      message: msg.message || "",
      rawAmount: 1,
    };
  }

  return null;
}

function buildStoryInjection(event: DonationEvent): string {
  const { kind, username, amount, currency, message, rawAmount } = event;

  if (message.trim()) {
    const label =
      kind === "bits" ? `${rawAmount} Bits from ${username}`
      : kind === "sub" ? `Sub gift from ${username}`
      : `Donation from ${username} (${amount} ${currency})`;
    return `[${label}: ${message.trim()}]`;
  }

  if (kind === "bits") {
    const bits = rawAmount ?? 0;
    if (bits >= 5000) return `[${username} cheered ${bits} Bits — something dramatic and pivotal happens!]`;
    if (bits >= 1000) return `[${username} cheered ${bits} Bits — add an unexpected twist to the scene.]`;
    return `[${username} cheered ${bits} Bits — add a small surprising detail.]`;
  }

  if (kind === "sub") {
    const count = rawAmount ?? 1;
    if (count >= 10) return `[${username} gifted ${count} subscriptions — something dramatic and pivotal happens!]`;
    if (count >= 3) return `[${username} gifted ${count} subscriptions — add an unexpected twist to the scene.]`;
    return `[${username} subscribed — add a small surprising detail.]`;
  }

  // Monetary tip — tiered default events
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

  // Subscriptions always pass the amount check regardless of DONATION_MIN_AMOUNT
  if (event.kind !== "sub") {
    const minAmount = parseFloat(serverEnv("DONATION_MIN_AMOUNT", "1") || "1");
    const expectedCurrency = serverEnv("DONATION_CURRENCY", "");
    if (event.amount < minAmount) {
      return Response.json({ ok: true, processed: false, reason: "Below minimum amount." });
    }
    if (expectedCurrency && event.currency !== expectedCurrency) {
      return Response.json({ ok: true, processed: false, reason: "Currency mismatch." });
    }
  }

  const state = getStreamState();
  if (!state.activeChatId) {
    return Response.json({ ok: true, processed: false, reason: "No active chat." });
  }

  const userCooldown = parseInt(serverEnv("DONATION_USER_COOLDOWN_SECONDS", "60") || "60", 10);
  const globalCooldown = parseInt(serverEnv("DONATION_GLOBAL_COOLDOWN_SECONDS", "15") || "15", 10);
  const cooldownCheck = canFireDonation(event.username, userCooldown, globalCooldown);
  if (!cooldownCheck.allowed) {
    console.log(`[donation] Skipped (cooldown): ${cooldownCheck.reason}`);
    return Response.json({ ok: true, processed: false, reason: cooldownCheck.reason });
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
