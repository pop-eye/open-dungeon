#!/usr/bin/env node
/**
 * Cross-platform launcher for the Open Dungeon Kokoro TTS server.
 *
 * Python interpreter resolution:
 *   1. KOKORO_TTS_PYTHON env var (explicit override)
 *   2. Platform-appropriate venv inside KOKORO_TTS_DIR
 *        Windows : <dir>\.venv\Scripts\python.exe
 *        Mac/Linux: <dir>/.venv/bin/python
 *   3. KOKORO_TTS_DIR defaults to ~/open-dungeon-tts
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(import.meta.url), "../..");

function resolvePython() {
  if (process.env.KOKORO_TTS_PYTHON) {
    return process.env.KOKORO_TTS_PYTHON;
  }
  const dir = process.env.KOKORO_TTS_DIR || join(homedir(), "open-dungeon-tts");
  return process.platform === "win32"
    ? join(dir, ".venv", "Scripts", "python.exe")
    : join(dir, ".venv", "bin", "python");
}

const python = resolvePython();
const script = join(projectRoot, "tts_server", "kokoro_server.py");

if (!existsSync(python)) {
  console.error(`[tts-server] Python not found at: ${python}`);
  console.error(
    "[tts-server] Create a venv and install Kokoro, or set KOKORO_TTS_PYTHON / KOKORO_TTS_DIR in .env.local",
  );
  if (process.platform === "win32") {
    console.error("[tts-server] Setup script: .\\scripts\\setup-windows-tts.ps1");
  }
  process.exit(1);
}

console.log(`[tts-server] Backend: Kokoro-82M  python=${python}`);
const child = spawn(python, [script], { stdio: "inherit", env: process.env });

child.on("error", (err) => {
  console.error(`[tts-server] Failed to start: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
