import { z } from "zod";
import { updateMessageGeneratedImage } from "@/lib/db";
import { serverEnv } from "@/lib/server-env";
import { dimensionsForImage } from "@/lib/story-prompt";
import type { GeneratedImage } from "@/lib/types";

export const runtime = "nodejs";

const MAX_IMAGE_REFERENCES = 2;

const requestSchema = z.object({
  messageId: z.string().optional(),
  prompt: z.string().min(1),
  mode: z.enum(["fast", "slow"]).default("slow"),
  backend: z.enum(["mflux-hs", "sdnq-hs", "comfyui-flux-gguf"]).default("sdnq-hs"),
  aspect: z.enum(["square", "portrait", "landscape"]).default("square"),
  // Fixed per-story art-direction appended to the scene prompt for a
  // consistent look across every image in a story.
  style: z.string().default(""),
  seed: z.number().int().optional(),
  references: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        url: z.string(),
        dataUrl: z.string().optional(),
      }),
    )
    .default([]),
  // Canonical character design portraits used as face-swap sources (locks the
  // character's face onto the generated scene). Kept separate from img2img
  // references so they don't reshape the whole composition.
  faceSources: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        url: z.string(),
        dataUrl: z.string().optional(),
      }),
    )
    .default([]),
});

export async function POST(request: Request) {
  const body = requestSchema.parse(await request.json());
  const references = body.references.slice(0, MAX_IMAGE_REFERENCES);
  const workerUrl = serverEnv("FLUX_WORKER_URL", "http://127.0.0.1:7869");
  const dimensions = dimensionsForImage(body.mode, body.aspect);

  // Anchor every image to the story's fixed art-direction so the look stays
  // consistent turn to turn, regardless of how the per-scene prompt is worded.
  const style = body.style.trim();
  const prompt = style ? `${body.prompt.trim()}. Style: ${style}` : body.prompt;

  try {
    const upstream = await fetch(`${workerUrl.replace(/\/$/, "")}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        mode: body.mode,
        backend: body.backend,
        aspect: body.aspect,
        width: dimensions.width,
        height: dimensions.height,
        steps: 4,
        guidance: 0.0,
        seed: body.seed,
        references: references.map((reference) => ({
          name: reference.name,
          dataUrl: reference.dataUrl,
          url: reference.url,
        })),
        faceSources: body.faceSources.slice(0, MAX_IMAGE_REFERENCES).map((source) => ({
          name: source.name,
          dataUrl: source.dataUrl,
          url: source.url,
        })),
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      return Response.json(
        { error: `Flux worker failed (${upstream.status}).`, detail: detail.slice(0, 1000) },
        { status: 502 },
      );
    }

    const generatedImage = (await upstream.json()) as GeneratedImage;

    if (body.messageId) {
      updateMessageGeneratedImage(body.messageId, generatedImage);
    }

    return Response.json(generatedImage);
  } catch (error) {
    return Response.json(
      {
        error: "Flux worker is not running.",
        detail: error instanceof Error ? error.message : String(error),
        expected: "Start it with: npm run flux:worker",
      },
      { status: 503 },
    );
  }
}
