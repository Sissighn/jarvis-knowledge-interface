import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(".env.local");
} catch {
  // Defaults keep the voice service usable without a local environment file.
}

const voiceHome = process.env.VOICE_HOME
  || resolve(homedir(), "Library/Application Support/com.sissighn.jarvis/voice");
const python = process.env.VOICE_PYTHON || join(voiceHome, "venv/bin/python3");
const service = resolve(process.cwd(), "scripts/voice-server.py");

try {
  await access(python);
} catch {
  console.error(`Voice environment missing: ${python}`);
  console.error("Run npm run setup:voice, then restart JARVIS.");
  process.exit(1);
}

const server = spawn(python, [service], {
  stdio: "inherit",
  env: {
    ...process.env,
    VOICE_PORT: process.env.VOICE_PORT || "8179",
    VOICE_MODELS_DIR: process.env.VOICE_MODELS_DIR || join(voiceHome, "voices"),
    // The Piper wheel ships an incomplete espeak-ng data directory and otherwise looks for the
    // one baked in at build time, on a path that only ever existed on the CI runner.
    ESPEAK_DATA_PATH: process.env.ESPEAK_DATA_PATH || "/opt/homebrew/share",
  },
});

server.on("error", (error) => {
  console.error(`Local voice service could not start: ${error.message}`);
  process.exit(1);
});

process.on("SIGTERM", () => server.kill("SIGTERM"));

server.on("exit", (code) => process.exit(code ?? 0));
