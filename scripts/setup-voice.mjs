/**
 * Prepares the local speech output: one Python environment with both voice engines and the
 * model files they need.
 *
 * The environment is created under Application Support rather than in the repository, because
 * a virtual environment cannot be relocated — its scripts carry the interpreter path they were
 * created with — and because the packaged app has to find the exact same one the development
 * server uses.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const voiceHome = resolve(homedir(), "Library/Application Support/com.sissighn.jarvis/voice");
const venvDirectory = join(voiceHome, "venv");
const voicesDirectory = join(voiceHome, "voices");
const python = join(venvDirectory, "bin/python3");

const PIPER_VOICE = "de_DE-thorsten-high.onnx";
const PIPER_BASE_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/high";
const QWEN_REPOSITORY = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit";
/** Newest interpreter the wheels of both engines are published for, most preferred first. */
const INTERPRETERS = ["/opt/homebrew/bin/python3.12", "/opt/homebrew/bin/python3.11", "python3"];

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function firstInterpreter() {
  for (const candidate of INTERPRETERS) {
    if (candidate === "python3" || await exists(candidate)) return candidate;
  }
  throw new Error("No Python interpreter was found. Install one with: brew install python@3.12");
}

// espeak-ng turns German text into the phonemes Piper reads. The published wheel ships an
// incomplete copy of its data and otherwise looks for a build-time path that never exists.
if (!await exists("/opt/homebrew/share/espeak-ng-data/phontab")) {
  console.error("Install the phonemiser first: brew install espeak-ng");
  process.exit(1);
}

await mkdir(voicesDirectory, { recursive: true });

if (await exists(python)) {
  console.log(`Voice environment already present at ${venvDirectory}`);
} else {
  const interpreter = await firstInterpreter();
  console.log(`Creating the voice environment with ${interpreter}…`);
  await run(interpreter, ["-m", "venv", venvDirectory]);
}

console.log("Installing the voice engines…");
await run(python, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"]);
await run(python, ["-m", "pip", "install", "--quiet", "piper-tts", "mlx-audio", "huggingface_hub"]);

const modelPath = join(voicesDirectory, PIPER_VOICE);
for (const file of [PIPER_VOICE, `${PIPER_VOICE}.json`]) {
  const target = join(voicesDirectory, file);
  if (await exists(target)) continue;
  console.log(`Downloading ${file}…`);
  const response = await fetch(`${PIPER_BASE_URL}/${file}`, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}.`);
  const partial = `${target}.download`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    await rename(partial, target);
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw error;
  }
}
console.log(`Piper voice ready at ${modelPath} (${Math.round((await stat(modelPath)).size / 1e6)} MB)`);

// Fetching the weights now keeps the first spoken answer from waiting on a download.
console.log(`Downloading ${QWEN_REPOSITORY}…`);
await run(python, [
  "-c",
  "import sys; from huggingface_hub import snapshot_download; print(snapshot_download(sys.argv[1]))",
  QWEN_REPOSITORY,
]);

// The packaged app starts the service from here; the development server uses the repository
// copy directly, so this only has to exist for the installed app.
await copyFile(resolve("scripts/voice-server.py"), join(voiceHome, "voice-server.py"));

console.log(`Voice output ready. Environment: ${venvDirectory}`);
