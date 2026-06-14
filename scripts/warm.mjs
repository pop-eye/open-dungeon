#!/usr/bin/env node
/**
 * Cross-platform warm-up request for the image server.
 * Replaces the bash curl one-liners in `image:warm:*` npm scripts.
 *
 * Usage (via npm): npm run image:warm:mflux
 *          direct: node scripts/warm.mjs mflux-hs
 */

const backend = process.argv[2] || "mflux-hs";
const workerUrl = (
  process.env.FLUX_WORKER_URL || "http://127.0.0.1:7869"
).replace(/\/$/, "");

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
