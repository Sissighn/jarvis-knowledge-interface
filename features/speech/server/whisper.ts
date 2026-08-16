/** Server-only bridge to the local whisper.cpp transcription service. */
import type { SpeechStatus, SpeechTranscript } from "../types";

const DEFAULT_BASE_URL = "http://127.0.0.1:8178";
/**
 * The turbo variant distils the decoder down to four layers, which it pays for on everything
 * that is not English. German dictation of names and technical terms is exactly that case, so
 * the full model is worth its roughly doubled transcription time.
 */
const DEFAULT_MODEL = "large-v3-q5_0";
const STATUS_TIMEOUT_MS = 2_000;
const TRANSCRIPTION_TIMEOUT_MS = 180_000;

export class SpeechModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechModelError";
  }
}

function configuration() {
  return {
    baseUrl: (process.env.WHISPER_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, ""),
    model: DEFAULT_MODEL,
  };
}

async function timedFetch(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new SpeechModelError("Die lokale Transkription hat zu lange gebraucht.");
    }
    throw new SpeechModelError("Der lokale Whisper-Dienst ist nicht erreichbar.");
  } finally {
    clearTimeout(timeout);
  }
}

export async function getSpeechStatus(): Promise<SpeechStatus> {
  const { baseUrl, model } = configuration();
  try {
    const response = await timedFetch(`${baseUrl}/`, { method: "GET" }, STATUS_TIMEOUT_MS);
    if (!response.ok) throw new Error();
    return { provider: "whisper.cpp", connected: true, model };
  } catch (error) {
    return {
      provider: "whisper.cpp",
      connected: false,
      model,
      error: error instanceof Error ? error.message : "Whisper ist nicht erreichbar.",
    };
  }
}

export async function transcribeAudio(audio: File): Promise<SpeechTranscript> {
  const { baseUrl, model } = configuration();
  const body = new FormData();
  body.append("file", audio, audio.name || "recording.webm");
  body.append("response_format", "json");
  body.append("language", process.env.WHISPER_LANGUAGE?.trim() || "de");
  body.append("temperature", "0.0");
  body.append("temperature_inc", "0.2");
  // Keep in sync with the service default in scripts/start-whisper-server.mjs.
  body.append("prompt", "Setayesh, JARVIS, Codex, ChatGPT, Notion, Ollama, Qwen, GitHub, TypeScript, Machine Learning, Reinforcement Learning");

  const response = await timedFetch(`${baseUrl}/inference`, { method: "POST", body }, TRANSCRIPTION_TIMEOUT_MS);
  const payload = await response.json().catch(() => ({})) as { text?: unknown; error?: unknown };
  if (!response.ok) {
    throw new SpeechModelError(typeof payload.error === "string" ? payload.error : "Die Audiodatei konnte nicht transkribiert werden.");
  }
  const text = typeof payload.text === "string" ? payload.text.replace(/\s+/g, " ").trim() : "";
  if (!text) throw new SpeechModelError("Whisper hat in der Aufnahme keine Sprache erkannt.");
  return { provider: "whisper.cpp", model, text };
}
