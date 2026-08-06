/**
 * Spoken answers through the macOS `say` command in the local action layer.
 *
 * The embedded WebView only exposes the base system voices to the page, so downloaded
 * premium voices are unreachable through browser speech synthesis. This path reaches them.
 */
import type { VoiceSettings } from "../types";
import { LOCAL_ACTION_BASE } from "./local-tools";
import { speakableText, type SpeechVoice } from "./speech";

type NativeVoice = { name: string; lang: string; quality: "premium" | "enhanced" | "compact" };
type VoicesPayload = { voices?: NativeVoice[] };

type NativeSpeechHandlers = {
  onStart?(): void;
  onActivity?(level: number): void;
};

let audioContext: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let finishCurrentPlayback: (() => void) | null = null;
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
  const source = currentSource;
  const finish = finishCurrentPlayback;
  currentSource = null;
  finishCurrentPlayback = null;
  if (source) {
    source.onended = null;
    try {
      source.stop();
    } catch {
      // The source already ended between the user action and this cleanup.
    }
  }
  finish?.();
}

/** Converts waveform RMS to a restrained visual level, with a small silence gate. */
export function normalizeSpeechRms(rms: number) {
  if (!Number.isFinite(rms) || rms <= 0.008) return 0;
  return Math.max(0, Math.min(1, (rms - 0.008) / 0.16));
}

/** The panel works with URIs, and a voice name is unique enough on one Mac. */
function toSpeechVoice(voice: NativeVoice): SpeechVoice {
  return { uri: voice.name, name: voice.name, lang: voice.lang };
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

/** Resolves once the exact rendered system-voice audio has played or was interrupted. */
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
  const response = await fetch(`${LOCAL_ACTION_BASE}/speech/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: content,
      voice: settings.voiceUri,
      rate: settings.rate,
      volume: settings.volume,
    }),
    signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || "Die Sprachausgabe dieses Macs hat nicht reagiert.");
  }
  if (generation !== playbackGeneration || signal?.aborted) return;
  const context = contextForPlayback();
  await context.resume();
  const audio = await context.decodeAudioData(await response.arrayBuffer());
  if (generation !== playbackGeneration || signal?.aborted) return;

  const source = context.createBufferSource();
  const analyser = context.createAnalyser();
  const gain = context.createGain();
  const waveform = new Float32Array(512);
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.9;
  gain.gain.value = Math.max(0, Math.min(1, settings.volume));
  source.buffer = audio;
  source.connect(analyser);
  analyser.connect(gain);
  gain.connect(context.destination);
  currentSource = source;

  return new Promise<void>((resolve) => {
    let finished = false;
    let visibleLevel = 0;
    let previousFrame = window.performance.now();
    const publishActivity = (now: number) => {
      if (generation !== playbackGeneration || currentSource !== source) return;
      analyser.getFloatTimeDomainData(waveform);
      const rms = Math.sqrt(waveform.reduce((sum, sample) => sum + sample * sample, 0) / waveform.length);
      const target = normalizeSpeechRms(rms);
      const elapsed = Math.max(8, Math.min(48, now - previousFrame));
      previousFrame = now;
      const timeConstant = target > visibleLevel ? 140 : 260;
      visibleLevel += (target - visibleLevel) * (1 - Math.exp(-elapsed / timeConstant));
      handlers.onActivity?.(visibleLevel);
      activityFrame = window.requestAnimationFrame(publishActivity);
    };

    const finish = () => {
      if (finished) return;
      finished = true;
      if (activityFrame !== null) window.cancelAnimationFrame(activityFrame);
      activityFrame = null;
      if (currentSource === source) currentSource = null;
      if (finishCurrentPlayback === finish) finishCurrentPlayback = null;
      handlers.onActivity?.(0);
      source.disconnect();
      analyser.disconnect();
      gain.disconnect();
      resolve();
    };
    finishCurrentPlayback = finish;
    source.onended = finish;
    handlers.onStart?.();
    source.start();
    activityFrame = window.requestAnimationFrame(publishActivity);
  });
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
