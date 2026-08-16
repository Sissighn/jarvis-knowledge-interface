import { chmod, copyFile, link, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const projectRoot = process.cwd();
const appDataDirectory = resolve(homedir(), "Library/Application Support/com.sissighn.jarvis");
const sourceEnvironment = resolve(projectRoot, ".env.local");
const targetEnvironment = resolve(appDataDirectory, ".env.local");
const modelName = "ggml-large-v3-q5_0.bin";
const sourceModel = resolve(projectRoot, "models/whisper", modelName);
const targetModel = resolve(appDataDirectory, "models/whisper", modelName);
const sourceVoiceService = resolve(projectRoot, "scripts/voice-server.py");
const targetVoiceService = resolve(appDataDirectory, "voice/voice-server.py");

await mkdir(dirname(targetModel), { recursive: true });
await mkdir(dirname(targetVoiceService), { recursive: true });

try {
  await stat(sourceEnvironment);
  await copyFile(sourceEnvironment, targetEnvironment);
  await chmod(targetEnvironment, 0o600);
  console.log(`Desktop configuration copied to ${targetEnvironment}`);
} catch {
  console.warn("No .env.local file was copied. JARVIS will use safe defaults and sample Notion data.");
}

// The packaged app runs the service from Application Support, so this copy is what it starts.
// Refreshing it on every build keeps the running app from serving an older revision.
await copyFile(sourceVoiceService, targetVoiceService);
console.log(`Voice service prepared at ${targetVoiceService}`);

try {
  await stat(targetModel);
  console.log(`Desktop speech model already available at ${targetModel}`);
} catch {
  try {
    await link(sourceModel, targetModel);
  } catch {
    await copyFile(sourceModel, targetModel);
  }
  console.log(`Desktop speech model prepared at ${targetModel}`);
}
