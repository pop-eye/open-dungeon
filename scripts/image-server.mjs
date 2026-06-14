#!/usr/bin/env node
/**
 * Cross-platform launcher for the image generation server.
 * Replaces the bash-only `image:server` npm script so it works on Windows too.
 *
 * Resolution order for the Python interpreter:
 *   1. ULTRA_FAST_IMAGE_GEN_PYTHON env var (explicit override)
 *   2. Platform-appropriate venv inside ULTRA_FAST_IMAGE_GEN_DIR
 *        Windows : <dir>\.venv\Scripts\python.exe
 *        Mac/Linux: <dir>/.venv/bin/python
 *   3. ULTRA_FAST_IMAGE_GEN_DIR defaults to ~/ultra-fast-image-gen
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(import.meta.url), "../..");

function resolvePython() {
  if (process.env.ULTRA_FAST_IMAGE_GEN_PYTHON) {
    return process.env.ULTRA_FAST_IMAGE_GEN_PYTHON;
  }
  const dir =
    process.env.ULTRA_FAST_IMAGE_GEN_DIR ||
    join(homedir(), "ultra-fast-image-gen");
  const venvPython =
    process.platform === "win32"
      ? join(dir, ".venv", "Scripts", "python.exe")
      : join(dir, ".venv", "bin", "python");
  return venvPython;
}

const python = resolvePython();
const script = join(projectRoot, "image_server", "optimized_image_server.py");

if (!existsSync(python)) {
  console.error(`[image-server] Python not found at: ${python}`);
  console.error(
    "[image-server] Set ULTRA_FAST_IMAGE_GEN_PYTHON or ULTRA_FAST_IMAGE_GEN_DIR in your .env.local"
  );
  process.exit(1);
}

if (!existsSync(script)) {
  console.error(`[image-server] Server script not found at: ${script}`);
  process.exit(1);
}

console.log(`[image-server] Starting with ${python}`);

const child = spawn(python, [script], {
  stdio: "inherit",
  env: process.env,
  // On Windows, start_new_session in Python handles its own process group;
  // detached here would create an orphan. Keep it simple: inherit.
});

child.on("error", (err) => {
  console.error(`[image-server] Failed to start: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

// Forward signals so Ctrl-C propagates cleanly on both platforms
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
