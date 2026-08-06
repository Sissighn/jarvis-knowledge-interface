/**
 * Spoken answers through the macOS `say` command.
 *
 * WKWebView only hands the base voices to the page, so the premium voices a user downloads
 * are unreachable from browser speech synthesis. `say` sees all of them, which is why the
 * assistant speaks through this process instead.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LocalActionError, isMacOs } from "./macos";

const run = promisify(execFile);
const VOICE_LIST_TIMEOUT_MS = 10_000;
const MAX_SPEECH_MS = 120_000;
const MAX_TEXT_LENGTH = 4_000;
/** `say` counts words per minute; this is its own default and the anchor for the rate slider. */
const BASE_WORDS_PER_MINUTE = 180;

export type SystemVoice = {
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

export async function availableVoices(): Promise<SystemVoice[]> {
  if (!isMacOs()) return [];
  try {
    const { stdout } = await run("say", ["-v", "?"], { timeout: VOICE_LIST_TIMEOUT_MS });
    return curateVoices(parseVoiceList(stdout));
  } catch {
    throw new LocalActionError("Die Stimmen dieses Macs konnten nicht gelesen werden.", 500);
  }
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

function volumeCommand(volume: number) {
  const level = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
  return `[[volm ${level.toFixed(2)}]]`;
}

/** Square brackets would be read as embedded speech commands, so they never survive. */
function sanitize(text: string) {
  return text.replace(/[[\]]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, MAX_TEXT_LENGTH);
}

/**
 * Resolves once the sentence has been spoken, so the caller can keep its speaking state in
 * sync without polling. Stopping kills the process, which resolves this the same way.
 */
export async function speakText(
  rawText: string,
  voiceName: string,
  rate: number,
  volume: number,
): Promise<{ spoken: boolean; voice: string; interrupted: boolean }> {
  if (!isMacOs()) throw new LocalActionError("Sprachausgabe gibt es nur unter macOS.", 503);
  const text = sanitize(rawText);
  if (!text) return { spoken: false, voice: voiceName, interrupted: false };

  const voices = await availableVoices();
  const voice = voices.find((entry) => entry.name === voiceName) ?? voices[0];
  if (!voice) throw new LocalActionError("Auf diesem Mac ist keine passende Stimme installiert.", 404);

  stopSpeaking();
  const child = spawn("say", ["-v", voice.name, "-r", String(rateFor(rate)), "-f", "-"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  speaking = child;
  child.stdin?.end(`${volumeCommand(volume)} ${text}`);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), MAX_SPEECH_MS);
    child.on("error", () => {
      clearTimeout(timeout);
      if (speaking === child) speaking = null;
      reject(new LocalActionError("Die Sprachausgabe konnte nicht gestartet werden.", 500));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (speaking === child) speaking = null;
      resolve({ spoken: code === 0, voice: voice.name, interrupted: Boolean(signal) });
    });
  });
}

/**
 * Renders the selected system voice before playback. The WebView plays this exact file
 * through Web Audio, which lets the core follow the real waveform instead of estimated text timing.
 */
export async function renderSpeechAudio(
  rawText: string,
  voiceName: string,
  rate: number,
): Promise<{ audio: Uint8Array; voice: string }> {
  if (!isMacOs()) throw new LocalActionError("Sprachausgabe gibt es nur unter macOS.", 503);
  const text = sanitize(rawText);
  if (!text) throw new LocalActionError("Es gibt keinen Text zum Vorlesen.", 400);

  const voices = await availableVoices();
  const voice = voices.find((entry) => entry.name === voiceName) ?? voices[0];
  if (!voice) throw new LocalActionError("Auf diesem Mac ist keine passende Stimme installiert.", 404);

  const directory = await mkdtemp(join(tmpdir(), "jarvis-speech-"));
  const outputPath = join(directory, "voice.aiff");
  try {
    const child = spawn("say", [
      "-v", voice.name,
      "-r", String(rateFor(rate)),
      "-o", outputPath,
      "--file-format=AIFF",
      // AIFF stores linear PCM big-endian; forcing little-endian makes premium voices fail.
      "--data-format=BEI16@22050",
      "-f", "-",
    ], { stdio: ["pipe", "ignore", "ignore"] });
    child.stdin?.end(text);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), MAX_SPEECH_MS);
      child.on("error", () => {
        clearTimeout(timeout);
        reject(new LocalActionError("Die Stimme konnte nicht vorbereitet werden.", 500));
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new LocalActionError("Die Stimme konnte nicht vorbereitet werden.", 500));
      });
    });
    return { audio: new Uint8Array(await readFile(outputPath)), voice: voice.name };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
