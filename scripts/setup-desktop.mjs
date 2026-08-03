import { chmod, copyFile, link, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const projectRoot = process.cwd();
const appDataDirectory = resolve(homedir(), "Library/Application Support/com.sissighn.jarvis");
const sourceEnvironment = resolve(projectRoot, ".env.local");
const targetEnvironment = resolve(appDataDirectory, ".env.local");
const modelName = "ggml-large-v3-turbo-q5_0.bin";
const sourceModel = resolve(projectRoot, "models/whisper", modelName);
const targetModel = resolve(appDataDirectory, "models/whisper", modelName);

await mkdir(dirname(targetModel), { recursive: true });

try {
  await stat(sourceEnvironment);
  await copyFile(sourceEnvironment, targetEnvironment);
  await chmod(targetEnvironment, 0o600);
  console.log(`Desktop configuration copied to ${targetEnvironment}`);
} catch {
  console.warn("No .env.local file was copied. JARVIS will use safe defaults and sample Notion data.");
}

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
