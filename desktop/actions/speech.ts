/**
 * Spoken answers, through the local voice service and — when that is not prepared — through
 * the macOS `say` command.
 *
 * The service in `scripts/voice-server.py` holds the neural voices in memory and streams the
 * audio while it is still being generated. `say` is the fallback that keeps a fresh
 * installation from being mute; WKWebView hides the downloaded premium voices from the page,
 * so even that path has to run out here in the action layer rather than in the browser.
 *
 * Both paths hand back the same thing: little-endian float32 mono samples and their rate.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LocalActionError, isMacOs } from "./macos";
import { serviceVoices, speakThroughService, type SpokenAudio } from "./voice";

const run = promisify(execFile);
const VOICE_LIST_TIMEOUT_MS = 10_000;
const MAX_SPEECH_MS = 120_000;
const MAX_TEXT_LENGTH = 4_000;
/** `say` renders float32 at this rate; the interface resamples whatever it is handed. */
const SAY_SAMPLE_RATE = 22_050;
/** `say` counts words per minute; this is its own default and the anchor for the rate slider. */
const BASE_WORDS_PER_MINUTE = 180;

export type SystemVoice = {
  /**
   * What the panel stores and sends back. A system voice is identified by its name, which is
   * unique on one Mac; the service voices carry the short ids the service itself uses.
   */
  id: string;
  name: string;
  lang: string;
  quality: "premium" | "enhanced" | "compact";
};

let speaking: ChildProcess | null = null;

function qualityOf(name: string): SystemVoice["quality"] {
  const lowered = name.toLowerCase();
  if (lowered.includes("premium")) return "premium";
  if (lowered.includes("enhanced")) return "enhanced";
  return "compact";
}

/** Parses the fixed-width listing of `say -v '?'`. Voice names contain spaces and brackets. */
export function parseVoiceList(output: string): SystemVoice[] {
  return output
    .split("\n")
    // Long names leave only a single space before the language column, so one is enough.
    .map((line) => /^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/u.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({
      id: match[1].trim(),
      name: match[1].trim(),
      lang: match[2].replace("_", "-"),
      quality: qualityOf(match[1]),
    }));
}

const QUALITY_RANK: Record<SystemVoice["quality"], number> = { premium: 3, enhanced: 2, compact: 1 };

/**
 * The novelty voices and the ancient MacinTalk generation. Both sound worse than the plain
 * modern compact voices, so they never win a comparison on quality alone.
 */
const LEGACY_VOICES = [
  "agnes", "albert", "bad news", "bahh", "bells", "boing", "bruce", "bubbles", "cellos",
  "deranged", "eddy", "flo", "fred", "good news", "grandma", "grandpa", "hysterical", "jester",
  "junior", "kathy", "organ", "princess", "ralph", "reed", "rocko", "sandy", "shelley",
  "superstar", "trinoids", "vicki", "victoria", "whisper", "wobble", "zarvox",
];

function isNovelty(voice: SystemVoice) {
  const name = voice.name.toLowerCase();
  return LEGACY_VOICES.some((legacy) => name === legacy || name.startsWith(`${legacy} (`));
}

/** Without a regional preference the first match wins, which lands on voices like en-IN. */
const PREFERRED_LOCALES = ["de-DE", "en-US", "en-GB"];

function localeRank(lang: string) {
  const index = PREFERRED_LOCALES.indexOf(lang);
  return index === -1 ? PREFERRED_LOCALES.length : index;
}

/** One voice per language, the best installed one, novelty voices excluded. */
export function curateVoices(voices: SystemVoice[]): SystemVoice[] {
  const best = (prefix: string) => {
    const candidates = voices
      .filter((voice) => voice.lang.toLowerCase().startsWith(prefix) && !isNovelty(voice))
      .sort((left, right) => (
        QUALITY_RANK[right.quality] - QUALITY_RANK[left.quality]
        || localeRank(left.lang) - localeRank(right.lang)
        || left.name.localeCompare(right.name)
      ));
    return candidates[0] ?? null;
  };
  return [best("de"), best("en")].filter((voice): voice is SystemVoice => Boolean(voice));
}

async function systemVoices(): Promise<SystemVoice[]> {
  if (!isMacOs()) return [];
  try {
    const { stdout } = await run("say", ["-v", "?"], { timeout: VOICE_LIST_TIMEOUT_MS });
    return curateVoices(parseVoiceList(stdout));
  } catch {
    throw new LocalActionError("Die Stimmen dieses Macs konnten nicht gelesen werden.", 500);
  }
}

/**
 * The service voices replace the system ones rather than joining them: a picker that offers
 * both is a picker where the worse half is one click away.
 */
export async function availableVoices(): Promise<SystemVoice[]> {
  const neural = await serviceVoices();
  if (!neural.length) return systemVoices();
  return neural.map((voice) => ({ ...voice, quality: "premium" as const }));
}

export function stopSpeaking() {
  const current = speaking;
  speaking = null;
  if (!current) return { stopped: false };
  current.kill("SIGTERM");
  return { stopped: true };
}

function rateFor(rate: number) {
  const factor = Number.isFinite(rate) ? Math.max(0.5, Math.min(1.8, rate)) : 1;
  return Math.round(BASE_WORDS_PER_MINUTE * factor);
}

/** Square brackets would be read as embedded speech commands, so they never survive. */
function sanitize(text: string) {
  return text.replace(/[[\]]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, MAX_TEXT_LENGTH);
}

/**
 * A WAV file is a sequence of chunks, and `say` writes a metadata chunk before the samples,
 * so the audio does not start at the fixed offset a minimal header would suggest.
 */
export function pcmFromWav(file: Uint8Array): Uint8Array {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let offset = 12;
  while (offset + 8 <= file.byteLength) {
    const id = String.fromCharCode(...file.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (id === "data") {
      return file.subarray(offset + 8, Math.min(file.byteLength, offset + 8 + size));
    }
    // Chunks are padded to an even length, and that padding is not counted in the size.
    offset += 8 + size + (size % 2);
  }
  throw new LocalActionError("Die Sprachausgabe hat keine Audiodaten geliefert.", 500);
}

/** Renders through `say`, which cannot stream, so its audio arrives as a single chunk. */
async function speakThroughSystem(text: string, voiceName: string, rate: number): Promise<SpokenAudio> {
  if (!isMacOs()) throw new LocalActionError("Sprachausgabe gibt es nur unter macOS.", 503);
  const voices = await systemVoices();
  const voice = voices.find((entry) => entry.id === voiceName) ?? voices[0];
  if (!voice) throw new LocalActionError("Auf diesem Mac ist keine passende Stimme installiert.", 404);

  const directory = await mkdtemp(join(tmpdir(), "jarvis-speech-"));
  const outputPath = join(directory, "voice.wav");
  try {
    const child = spawn("say", [
      "-v", voice.name,
      "-r", String(rateFor(rate)),
      "-o", outputPath,
      "--file-format=WAVE",
      `--data-format=LEF32@${SAY_SAMPLE_RATE}`,
      "-f", "-",
    ], { stdio: ["pipe", "ignore", "ignore"] });
    stopSpeaking();
    speaking = child;
    child.stdin?.end(text);
    await new Promise<void>((resolveRender, rejectRender) => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), MAX_SPEECH_MS);
      child.on("error", () => {
        clearTimeout(timeout);
        if (speaking === child) speaking = null;
        rejectRender(new LocalActionError("Die Stimme konnte nicht vorbereitet werden.", 500));
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (speaking === child) speaking = null;
        if (code === 0) resolveRender();
        else rejectRender(new LocalActionError("Die Stimme konnte nicht vorbereitet werden.", 500));
      });
    });

    const samples = pcmFromWav(await readFile(outputPath));
    return {
      samples: new ReadableStream({
        start(controller) {
          controller.enqueue(samples);
          controller.close();
        },
      }),
      sampleRate: SAY_SAMPLE_RATE,
      voice: voice.name,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The interface plays what this returns chunk by chunk, which is what keeps the pause before
 * JARVIS starts speaking short even when the whole answer takes seconds to generate.
 */
export async function speakStream(
  rawText: string,
  voiceId: string,
  rate: number,
): Promise<SpokenAudio> {
  const text = sanitize(rawText);
  if (!text) throw new LocalActionError("Es gibt keinen Text zum Vorlesen.", 400);

  const neural = await serviceVoices();
  if (neural.some((voice) => voice.id === voiceId)) {
    return speakThroughService(text, voiceId, rate);
  }
  // A setting written before this Mac had the service still names a `say` voice. As long as
  // the service is up, its own first voice is the better answer to that stale id.
  if (neural.length) return speakThroughService(text, neural[0].id, rate);
  return speakThroughSystem(text, voiceId, rate);
}
