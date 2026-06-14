#!/usr/bin/env node
/**
 * Cross-platform launcher for the Open Dungeon image generation server.
 *
 * Default on ALL platforms: optimized_image_server.py (ultra-fast-image-gen)
 *   macOS → mflux-hs backend (MLX/Apple Silicon)
 *   Windows/Linux → sdnq-hs backend with --device cuda (PyTorch, NVIDIA)
 *
 * The Python server auto-selects the right device — no config needed.
 *
 * Optional override via IMAGE_BACKEND env var:
 *   IMAGE_BACKEND=comfyui → use comfyui_image_server.py instead
 *                           (requires a running ComfyUI instance; see docs/windows.md)
 *
 * Python interpreter resolution (optimized server):
 *   1. ULTRA_FAST_IMAGE_GEN_PYTHON env var (explicit override)
 *   2. Platform-appropriate venv inside ULTRA_FAST_IMAGE_GEN_DIR
 *        Windows : <dir>\.venv\Scripts\python.exe
 *        Mac/Linux: <dir>/.venv/bin/python
 *   3. ULTRA_FAST_IMAGE_GEN_DIR defaults to ~/ultra-fast-image-gen
 *
 * Python interpreter resolution (comfyui server):
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

const backend = (process.env.IMAGE_BACKEND || "").toLowerCase();
const useComfyui = backend === "comfyui";

// ── Optimized server path (default) ─────────────────────────────────────────

function resolvePython() {
  if (process.env.ULTRA_FAST_IMAGE_GEN_PYTHON) {
    return process.env.ULTRA_FAST_IMAGE_GEN_PYTHON;
  }
  const dir =
    process.env.ULTRA_FAST_IMAGE_GEN_DIR || join(homedir(), "ultra-fast-image-gen");
  return process.platform === "win32"
    ? join(dir, ".venv", "Scripts", "python.exe")
    : join(dir, ".venv", "bin", "python");
}

function startOptimized() {
  const python = resolvePython();
  const script = join(projectRoot, "image_server", "optimized_image_server.py");

  if (!existsSync(python)) {
    console.error(`[image-server] Python not found at: ${python}`);
    console.error(
      "[image-server] Install ultra-fast-image-gen, then set ULTRA_FAST_IMAGE_GEN_PYTHON " +
        "or ULTRA_FAST_IMAGE_GEN_DIR in .env.local"
    );
    if (process.platform === "win32") {
      console.error(
        "[image-server] Windows setup guide: docs/windows.md  |  " +
          "Setup script: .\\scripts\\setup-windows-images.ps1"
      );
    }
    process.exit(1);
  }

  const device = process.env.SDNQ_DEVICE || (process.platform === "win32" ? "CUDA" : "MPS");
  console.log(`[image-server] Backend: optimized (ultra-fast-image-gen)  device=${device}  python=${python}`);
  return spawn(python, [script], { stdio: "inherit", env: process.env });
}

// ── ComfyUI path (opt-in) ────────────────────────────────────────────────────

function resolveComfyuiPython() {
  return process.env.COMFYUI_PYTHON || (process.platform === "win32" ? "python" : "python3");
}

function startComfyui() {
  const python = resolveComfyuiPython();
  const script = join(projectRoot, "image_server", "comfyui_image_server.py");

  if (!existsSync(script)) {
    console.error(`[image-server] ComfyUI server script not found at: ${script}`);
    process.exit(1);
  }

  const comfyuiUrl = process.env.COMFYUI_URL || "http://127.0.0.1:8188";
  console.log(`[image-server] Backend: ComfyUI  python=${python}  comfyui=${comfyuiUrl}`);
  console.log("[image-server] Ensure ComfyUI is running: python ComfyUI/main.py --listen 127.0.0.1 --port 8188");
  return spawn(python, [script], { stdio: "inherit", env: process.env });
}

// ── Launch ───────────────────────────────────────────────────────────────────

const child = useComfyui ? startComfyui() : startOptimized();

child.on("error", (err) => {
  console.error(`[image-server] Failed to start: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code) => process.exit(code ?? 0));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
