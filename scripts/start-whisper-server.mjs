import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(".env.local");
} catch {
  // Defaults keep the speech service usable without a local environment file.
}

const modelSetting = process.env.WHISPER_MODEL_PATH || "models/whisper/ggml-large-v3-turbo-q5_0.bin";
const modelPath = isAbsolute(modelSetting) ? modelSetting : resolve(process.cwd(), modelSetting);
const executable = process.env.WHISPER_SERVER_BIN || "/opt/homebrew/bin/whisper-server";
const port = process.env.WHISPER_PORT || "8178";

try {
  await access(modelPath);
} catch {
  console.error(`Local speech model missing: ${modelPath}`);
  console.error("Run the speech setup described in README.md, then restart JARVIS.");
  process.exit(1);
}

const server = spawn(executable, [
  "--model", modelPath,
  "--host", "127.0.0.1",
  "--port", port,
  "--language", process.env.WHISPER_LANGUAGE || "de",
  "--threads", "6",
  "--convert",
  "--prompt", "JARVIS, Codex, ChatGPT, Notion, Ollama, Qwen, GitHub, TypeScript, Machine Learning, Reinforcement Learning",
], { stdio: "inherit" });

server.on("error", (error) => {
  console.error(`Local speech server could not start: ${error.message}`);
  process.exit(1);
});

process.on("SIGTERM", () => server.kill("SIGTERM"));

server.on("exit", (code) => process.exit(code ?? 0));
