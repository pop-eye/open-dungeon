#!/usr/bin/env node
/**
 * Cross-platform launcher for the Open Dungeon image generation server.
 *
 * On macOS/Linux  → optimized_image_server.py  (MFLUX/MLX, Apple Silicon)
 * On Windows      → comfyui_image_server.py    (ComfyUI + CUDA)
 *
 * Override auto-detection with IMAGE_BACKEND env var:
 *   IMAGE_BACKEND=mflux   → always use optimized_image_server.py
 *   IMAGE_BACKEND=comfyui → always use comfyui_image_server.py
 *
 * Python interpreter resolution (mflux path):
 *   1. ULTRA_FAST_IMAGE_GEN_PYTHON env var
 *   2. Platform-appropriate venv inside ULTRA_FAST_IMAGE_GEN_DIR
 *        Windows : <dir>\.venv\Scripts\python.exe
 *        Mac/Linux: <dir>/.venv/bin/python
 *   3. ULTRA_FAST_IMAGE_GEN_DIR defaults to ~/ultra-fast-image-gen
 *
 * Python interpreter resolution (comfyui path):
 *   1. COMFYUI_PYTHON env var
 *   2. python3 / python on PATH
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(import.meta.url), "../..");

// ── Backend selection ────────────────────────────────────────────────────────

function selectBackend() {
  const override = (process.env.IMAGE_BACKEND || "").toLowerCase();
  if (override === "comfyui") return "comfyui";
  if (override === "mflux") return "mflux";
  return process.platform === "win32" ? "comfyui" : "mflux";
}

// ── MFLUX path ───────────────────────────────────────────────────────────────

function resolveMfluxPython() {
  if (process.env.ULTRA_FAST_IMAGE_GEN_PYTHON) {
    return process.env.ULTRA_FAST_IMAGE_GEN_PYTHON;
  }
  const dir =
    process.env.ULTRA_FAST_IMAGE_GEN_DIR || join(homedir(), "ultra-fast-image-gen");
  return process.platform === "win32"
    ? join(dir, ".venv", "Scripts", "python.exe")
    : join(dir, ".venv", "bin", "python");
}

function startMflux() {
  const python = resolveMfluxPython();
  const script = join(projectRoot, "image_server", "optimized_image_server.py");

  if (!existsSync(python)) {
    console.error(`[image-server] Python not found at: ${python}`);
    console.error(
      "[image-server] Set ULTRA_FAST_IMAGE_GEN_PYTHON or ULTRA_FAST_IMAGE_GEN_DIR in your .env.local"
    );
    process.exit(1);
  }

  console.log(`[image-server] Backend: MFLUX/MLX  python=${python}`);
  return spawn(python, [script], { stdio: "inherit", env: process.env });
}

// ── ComfyUI path ─────────────────────────────────────────────────────────────

function resolveComfyuiPython() {
  if (process.env.COMFYUI_PYTHON) return process.env.COMFYUI_PYTHON;
  // Look for python3 then python on PATH
  const candidates =
    process.platform === "win32"
      ? ["python.exe", "python3.exe"]
      : ["python3", "python"];
  for (const name of candidates) {
    // We'll just let spawn resolve it from PATH; existence check isn't reliable
    // for PATH entries on Windows. We return the first candidate and let the
    // spawn error surface if it's missing.
    return name;
  }
  return "python3";
}

function startComfyui() {
  const python = resolveComfyuiPython();
  const script = join(projectRoot, "image_server", "comfyui_image_server.py");

  if (!existsSync(script)) {
    console.error(`[image-server] ComfyUI server script not found at: ${script}`);
    process.exit(1);
  }

  const comfyuiUrl = process.env.COMFYUI_URL || "http://127.0.0.1:8188";
  console.log(`[image-server] Backend: ComfyUI/CUDA  python=${python}  comfyui=${comfyuiUrl}`);
  console.log(
    `[image-server] Make sure ComfyUI is running: python ComfyUI/main.py --listen 127.0.0.1 --port 8188`
  );
  return spawn(python, [script], { stdio: "inherit", env: process.env });
}

// ── Launch ───────────────────────────────────────────────────────────────────

const backend = selectBackend();
const child = backend === "comfyui" ? startComfyui() : startMflux();

child.on("error", (err) => {
  console.error(`[image-server] Failed to start: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
