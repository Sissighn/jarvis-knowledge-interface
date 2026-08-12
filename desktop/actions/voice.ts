/**
 * Client of the local speech service in `scripts/voice-server.py`.
 *
 * The service holds both voice engines in memory and streams the audio while it is still being
 * generated, so this module never buffers a complete answer: it hands the stream through to the
 * interface, which starts playing on the first chunk.
 *
 * Everything stays on this Mac. The service listens on loopback only and is never reachable
 * from outside, exactly like the local Whisper service.
 */
const DEFAULT_BASE_URL = "http://127.0.0.1:8179";
const VOICE_LIST_TIMEOUT_MS = 1_500;
const SPEECH_TIMEOUT_MS = 120_000;

export type ServiceVoice = { id: string; name: string; lang: string };

type VoicesPayload = { voices?: ServiceVoice[] };

function baseUrl() {
  return (process.env.VOICE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/u, "");
}

/**
 * An empty list is the honest answer for a Mac where the service was never prepared: the
 * caller then falls back to the system voices instead of leaving the assistant mute.
 */
export async function serviceVoices(): Promise<ServiceVoice[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VOICE_LIST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl()}/voices`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const payload = await response.json() as VoicesPayload;
    return Array.isArray(payload.voices) ? payload.voices : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export type SpokenAudio = {
  /** Little-endian float32 mono samples, chunked as the engine produces them. */
  samples: ReadableStream<Uint8Array>;
  sampleRate: number;
  voice: string;
};

/**
 * Interrupting is what makes barge-in work: when the interface stops listening, the stream is
 * cancelled, the service sees the closed connection, and it drops the rest of the sentence
 * instead of generating audio nobody will hear.
 */
export async function speakThroughService(
  text: string,
  voiceId: string,
  rate: number,
): Promise<SpokenAudio> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SPEECH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: voiceId, rate }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    throw new Error("Der lokale Sprachdienst ist nicht erreichbar.");
  }

  if (!response.ok || !response.body) {
    clearTimeout(timeout);
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || "Die Sprachausgabe ist fehlgeschlagen.");
  }

  const sampleRate = Number(response.headers.get("X-Jarvis-Sample-Rate"));
  return {
    samples: response.body.pipeThrough(new TransformStream({
      flush: () => clearTimeout(timeout),
    })),
    sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 24_000,
    voice: response.headers.get("X-Jarvis-Voice") || voiceId,
  };
}
