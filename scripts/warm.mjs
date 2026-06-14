#!/usr/bin/env node
/**
 * Cross-platform warm-up request for the image server.
 * Replaces the bash curl one-liners in `image:warm:*` npm scripts.
 *
 * Usage (via npm): npm run image:warm:mflux
 *          direct: node scripts/warm.mjs [backend-id]
 *
 * If no backend ID is given, queries /backends to discover the active one.
 */

const requestedBackend = process.argv[2];
const workerUrl = (
  process.env.FLUX_WORKER_URL || "http://127.0.0.1:7869"
).replace(/\/$/, "");

async function resolveBackend() {
  if (requestedBackend) return requestedBackend;
  // Auto-discover the first available backend from the running server
  try {
    const resp = await fetch(`${workerUrl}/backends`);
    if (resp.ok) {
      const data = await resp.json();
      const first = data.backends?.[0]?.id;
      if (first) return first;
    }
  } catch {
    // fall through
  }
  // Default to mflux-hs for Mac, comfyui-flux-gguf for Windows
  return process.platform === "win32" ? "comfyui-flux-gguf" : "mflux-hs";
}

const backend = await resolveBackend();
console.log(`[warm] Sending warm request for backend "${backend}" to ${workerUrl}/warm`);

let response;
try {
  response = await fetch(`${workerUrl}/warm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backend }),
  });
} catch (err) {
  console.error(`[warm] Could not reach image server: ${err.message}`);
  console.error("[warm] Is the image server running? (npm run image:server)");
  process.exit(1);
}

const text = await response.text();
let json;
try {
  json = JSON.parse(text);
} catch {
  json = { raw: text };
}

if (!response.ok) {
  console.error(`[warm] Server returned ${response.status}:`);
  console.error(json.detail || json.error || text);
  process.exit(1);
}

const elapsed = json.elapsedSeconds ? ` (${json.elapsedSeconds}s)` : "";
const resident = json.resident ? " [resident]" : "";
console.log(`[warm] Done${elapsed}${resident}`);
