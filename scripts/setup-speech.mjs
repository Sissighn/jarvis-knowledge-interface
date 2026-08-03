import { createWriteStream } from "node:fs";
import { access, mkdir, rename, stat, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";

const modelName = "ggml-large-v3-turbo-q5_0.bin";
const modelDirectory = resolve(process.cwd(), "models/whisper");
const modelPath = resolve(modelDirectory, modelName);
const partialPath = `${modelPath}.download`;
const expectedBytes = 574_041_195;
const downloadUrl = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelName}`;

try {
  await access("/opt/homebrew/bin/whisper-server");
  await access("/opt/homebrew/bin/ffmpeg");
} catch {
  console.error("Install the local tools first: brew install whisper-cpp ffmpeg");
  process.exit(1);
}

await mkdir(modelDirectory, { recursive: true });
try {
  if ((await stat(modelPath)).size === expectedBytes) {
    console.log(`Speech model already ready: ${modelPath}`);
    process.exit(0);
  }
} catch {
  // The model has not been downloaded yet.
}

console.log("Downloading Whisper large-v3-turbo Q5 (574 MB)…");
const response = await fetch(downloadUrl, { redirect: "follow" });
if (!response.ok || !response.body) {
  throw new Error(`Model download failed with HTTP ${response.status}.`);
}

try {
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partialPath));
  const downloadedBytes = (await stat(partialPath)).size;
  if (downloadedBytes !== expectedBytes) {
    throw new Error(`Incomplete model download: ${downloadedBytes} of ${expectedBytes} bytes.`);
  }
  await rename(partialPath, modelPath);
  console.log(`Speech model ready: ${modelPath}`);
} catch (error) {
  await unlink(partialPath).catch(() => undefined);
  throw error;
}
