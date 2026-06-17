import { z } from "zod";
import { serverEnv } from "@/lib/server-env";

export const runtime = "nodejs";

const requestSchema = z.object({
  text: z.string().min(1),
  voice: z.string().optional(),
  speed: z.number().min(0.5).max(2).optional(),
});

// Proxies narration text to the local Kokoro TTS server and streams the WAV
// audio back to the browser. Keeps the TTS host off the public client.
export async function POST(request: Request) {
  const body = requestSchema.parse(await request.json());
  const ttsUrl = serverEnv("KOKORO_TTS_URL", "http://127.0.0.1:7870").replace(/\/$/, "");

  let upstream: Response;
  try {
    upstream = await fetch(`${ttsUrl}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: body.text,
        voice: body.voice,
        speed: body.speed ?? 1.0,
      }),
    });
  } catch (error) {
    return Response.json(
      {
        error: "Kokoro TTS server is not running.",
        detail: error instanceof Error ? error.message : String(error),
        expected: "Start it with: npm run tts:server",
      },
      { status: 503 },
    );
  }

  if (!upstream.ok) {
    const detail = await upstream.text();
    return Response.json(
      { error: `Kokoro TTS failed (${upstream.status}).`, detail: detail.slice(0, 1000) },
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "audio/wav",
      "Cache-Control": "no-store",
    },
  });
}

// Lightweight probe + voice list so the client can show availability.
export async function GET() {
  const ttsUrl = serverEnv("KOKORO_TTS_URL", "http://127.0.0.1:7870").replace(/\/$/, "");
  try {
    const upstream = await fetch(`${ttsUrl}/health`, { cache: "no-store" });
    if (!upstream.ok) {
      return Response.json({ ok: false }, { status: 502 });
    }
    return Response.json(await upstream.json());
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
