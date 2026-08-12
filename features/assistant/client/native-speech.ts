/**
 * Spoken answers through the local action layer, played while they are still being generated.
 *
 * The action layer streams raw float32 samples rather than a finished file, because the neural
 * voices take seconds to render a long answer but produce the first half second almost
 * immediately. Every chunk is scheduled directly after the previous one on the audio clock, so
 * the playback is gapless as long as generation keeps ahead of it — which it does.
 *
 * The same path also carries the `say` fallback, which simply arrives as one chunk.
 */
import type { VoiceSettings } from "../types";
import { LOCAL_ACTION_BASE } from "./local-tools";
import { speakableText, type SpeechVoice } from "./speech";

type NativeVoice = { id?: string; name: string; lang: string };
type VoicesPayload = { voices?: NativeVoice[] };

type NativeSpeechHandlers = {
  onStart?(): void;
  onActivity?(level: number): void;
};

/** Scheduling the first chunk slightly ahead absorbs the decode and connect work. */
const START_LEAD_SECONDS = 0.06;
const BYTES_PER_SAMPLE = 4;

let audioContext: AudioContext | null = null;
let currentAbort: AbortController | null = null;
let activeSources = new Set<AudioBufferSourceNode>();
let activityFrame: number | null = null;
let playbackGeneration = 0;

function contextForPlayback() {
  audioContext ??= new AudioContext();
  return audioContext;
}

function stopLocalPlayback() {
  playbackGeneration += 1;
  if (activityFrame !== null) window.cancelAnimationFrame(activityFrame);
  activityFrame = null;
  currentAbort?.abort();
  currentAbort = null;
  for (const source of activeSources) {
    try {
      // `onended` stays attached on purpose: stopping fires it, which is what releases the
      // caller waiting for the answer to finish instead of leaving it pending forever.
      source.stop();
    } catch {
      // The source already ended between the user action and this cleanup.
    }
  }
  activeSources = new Set();
}

/** Interrupting JARVIS is a normal act, not a failure the panel should report. */
function isInterruption(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Converts waveform RMS to a restrained visual level, with a small silence gate. */
export function normalizeSpeechRms(rms: number) {
  if (!Number.isFinite(rms) || rms <= 0.008) return 0;
  return Math.max(0, Math.min(1, (rms - 0.008) / 0.16));
}

/** The panel works with URIs, and a voice id is unique within one installation. */
function toSpeechVoice(voice: NativeVoice): SpeechVoice {
  return { uri: voice.id ?? voice.name, name: voice.name, lang: voice.lang };
}

export async function loadNativeVoices(signal?: AbortSignal): Promise<SpeechVoice[]> {
  try {
    const response = await fetch(`${LOCAL_ACTION_BASE}/speech/voices`, { cache: "no-store", signal });
    if (!response.ok) return [];
    const payload = await response.json() as VoicesPayload;
    return (payload.voices ?? []).map(toSpeechVoice);
  } catch {
    return [];
  }
}

/**
 * Whole float32 samples only: a chunk boundary can fall inside a sample, and the remaining
 * bytes belong to the next one.
 */
function samplesFrom(bytes: Uint8Array<ArrayBufferLike>) {
  const usable = bytes.byteLength - (bytes.byteLength % BYTES_PER_SAMPLE);
  // The stream has no alignment guarantee, so the bytes are copied into an aligned buffer.
  const aligned = new Uint8Array(usable);
  aligned.set(bytes.subarray(0, usable));
  return {
    samples: new Float32Array(aligned.buffer as ArrayBuffer),
    rest: bytes.subarray(usable),
  };
}

function concat(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>) {
  if (!left.byteLength) return right;
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left);
  merged.set(right, left.byteLength);
  return merged;
}

/** Resolves once the answer has been played to the end or was interrupted. */
export async function speakNative(
  text: string,
  settings: VoiceSettings,
  signal?: AbortSignal,
  handlers: NativeSpeechHandlers = {},
) {
  const content = speakableText(text);
  if (!content) return;
  stopLocalPlayback();
  const generation = playbackGeneration;
  const abort = new AbortController();
  currentAbort = abort;
  signal?.addEventListener("abort", () => abort.abort(), { once: true });

  let response: Response;
  try {
    response = await fetch(`${LOCAL_ACTION_BASE}/speech/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: content,
        voice: settings.voiceUri,
        rate: settings.rate,
        volume: settings.volume,
      }),
      signal: abort.signal,
    });
  } catch (error) {
    if (isInterruption(error)) return;
    throw error;
  }
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || "Die Sprachausgabe dieses Macs hat nicht reagiert.");
  }
  if (generation !== playbackGeneration) return;

  const sampleRate = Number(response.headers.get("X-Jarvis-Sample-Rate")) || 24_000;
  const context = contextForPlayback();
  await context.resume();

  const analyser = context.createAnalyser();
  const gain = context.createGain();
  const waveform = new Float32Array(512);
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.9;
  gain.gain.value = Math.max(0, Math.min(1, settings.volume));
  analyser.connect(gain);
  gain.connect(context.destination);

  let cursor = 0;
  let started = false;
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  const finished: Promise<void>[] = [];

  const publishActivity = (() => {
    let visibleLevel = 0;
    let previousFrame = window.performance.now();
    const step = (now: number) => {
      if (generation !== playbackGeneration) return;
      analyser.getFloatTimeDomainData(waveform);
      const rms = Math.sqrt(waveform.reduce((sum, sample) => sum + sample * sample, 0) / waveform.length);
      const target = normalizeSpeechRms(rms);
      const elapsed = Math.max(8, Math.min(48, now - previousFrame));
      previousFrame = now;
      const timeConstant = target > visibleLevel ? 140 : 260;
      visibleLevel += (target - visibleLevel) * (1 - Math.exp(-elapsed / timeConstant));
      handlers.onActivity?.(visibleLevel);
      activityFrame = window.requestAnimationFrame(step);
    };
    return step;
  })();

  const schedule = (samples: Float32Array<ArrayBuffer>) => {
    if (!samples.length || generation !== playbackGeneration) return;
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    // Generation fell behind playback: continue from now rather than scheduling in the past.
    cursor = Math.max(cursor, context.currentTime + (started ? 0 : START_LEAD_SECONDS));
    source.start(cursor);
    cursor += buffer.duration;
    activeSources.add(source);
    finished.push(new Promise<void>((resolveSource) => {
      source.onended = () => {
        activeSources.delete(source);
        source.disconnect();
        resolveSource();
      };
    }));
    if (!started) {
      started = true;
      handlers.onStart?.();
      activityFrame = window.requestAnimationFrame(publishActivity);
    }
  };

  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (generation !== playbackGeneration) break;
      const { samples, rest } = samplesFrom(concat(pending, value));
      pending = rest;
      schedule(samples);
    }
    // Stopping fires `onended` on every scheduled source, so an interruption resolves this
    // just as the last chunk playing to its end does.
    await Promise.all(finished);
  } catch (error) {
    if (!isInterruption(error)) throw error;
  } finally {
    // These nodes belong to this call, so they are released even once a newer answer owns
    // the visible state — that newer call is the only one allowed to write to it.
    analyser.disconnect();
    gain.disconnect();
    if (generation === playbackGeneration) {
      if (activityFrame !== null) window.cancelAnimationFrame(activityFrame);
      activityFrame = null;
      currentAbort = null;
      handlers.onActivity?.(0);
    }
  }
}

export async function stopNativeSpeech() {
  stopLocalPlayback();
  try {
    await fetch(`${LOCAL_ACTION_BASE}/speech/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch {
    // Nothing is speaking when the action layer is unavailable.
  }
}
