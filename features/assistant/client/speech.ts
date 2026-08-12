/**
 * Spoken answers through the macOS system voices the browser exposes. Everything stays
 * on this Mac, and `cancel()` stops JARVIS mid-sentence whenever the user takes over.
 */
import type { VoiceSettings } from "../types";

export type SpeechVoice = {
  uri: string;
  name: string;
  lang: string;
};

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = { voiceUri: "", rate: 1, volume: 1 };
export const VOICE_SETTINGS_KEY = "jarvis-voice-settings-v1";

export function speechSupported() {
  return typeof window !== "undefined" && typeof window.speechSynthesis !== "undefined";
}

function sortedVoices(voices: SpeechSynthesisVoice[]) {
  const german = voices.filter((voice) => voice.lang.toLowerCase().startsWith("de"));
  const others = voices.filter((voice) => !voice.lang.toLowerCase().startsWith("de"));
  return [...german, ...others].map((voice) => ({ uri: voice.voiceURI, name: voice.name, lang: voice.lang }));
}

export function listVoices(): SpeechVoice[] {
  if (!speechSupported()) return [];
  return sortedVoices(window.speechSynthesis.getVoices());
}

/**
 * macOS marks the quality tier in the voice identifier (`com.apple.voice.premium.de-DE.Petra`)
 * and in the display name ("Petra (Premium)"). WebKit does not guarantee which of the two it
 * hands to the page, so both are scored. The German system default is the decade-old compact
 * voice, and an unconfigured assistant should not sound like that.
 */
export function voiceQuality(voice: { uri: string; name: string }) {
  const haystack = `${voice.uri} ${voice.name}`.toLowerCase();
  if (haystack.includes("premium")) return 3;
  if (haystack.includes("enhanced")) return 2;
  // Eloquence and the novelty voices sound worse than the plain compact ones.
  if (haystack.includes("eloquence") || haystack.includes("speech.synthesis.voice")) return 0;
  return 1;
}

function bestVoiceForLanguage(voices: SpeechVoice[], language: string) {
  const matching = voices.filter((voice) => voice.lang.toLowerCase().startsWith(language));
  if (!matching.length) return null;
  return matching.reduce((best, voice) => (voiceQuality(voice) > voiceQuality(best) ? voice : best));
}

export function bestGermanVoice(voices: SpeechVoice[]) {
  return bestVoiceForLanguage(voices, "de");
}

export function bestGermanVoiceUri(voices: SpeechVoice[]) {
  return bestGermanVoice(voices)?.uri ?? "";
}

/**
 * macOS installs close to two hundred voices, which makes a full picker useless. The panel
 * offers the best installed German voice and one English one, in that order.
 */
export function curatedVoices(voices: SpeechVoice[]): SpeechVoice[] {
  return [bestVoiceForLanguage(voices, "de"), bestVoiceForLanguage(voices, "en")]
    .filter((voice): voice is SpeechVoice => Boolean(voice));
}

/**
 * The voice that will actually speak, so the panel can show it instead of guessing.
 *
 * This takes the voices the panel offers, not every voice that exists. Deciding what is worth
 * offering is `curatedVoices` for the browser list and the local voice service for its own, and
 * scoring macOS quality tiers a second time here would drop a service voice that has no such
 * marker in favour of a system one the panel never showed.
 */
export function resolveVoice(offered: SpeechVoice[], settings: VoiceSettings) {
  return offered.find((voice) => voice.uri === settings.voiceUri) ?? offered[0] ?? null;
}

/** Voices arrive asynchronously in WebKit, so the UI subscribes instead of polling. */
export function subscribeToVoices(onChange: (voices: SpeechVoice[]) => void) {
  if (!speechSupported()) return () => undefined;
  const publish = () => onChange(listVoices());
  publish();
  window.speechSynthesis.addEventListener("voiceschanged", publish);
  return () => window.speechSynthesis.removeEventListener("voiceschanged", publish);
}

export function readVoiceSettings(): VoiceSettings {
  try {
    const stored = window.localStorage.getItem(VOICE_SETTINGS_KEY);
    if (!stored) return DEFAULT_VOICE_SETTINGS;
    const parsed = JSON.parse(stored) as Partial<VoiceSettings>;
    return {
      voiceUri: typeof parsed.voiceUri === "string" ? parsed.voiceUri : "",
      rate: clampRate(parsed.rate),
      volume: clampVolume(parsed.volume),
    };
  } catch {
    return DEFAULT_VOICE_SETTINGS;
  }
}

export function storeVoiceSettings(settings: VoiceSettings) {
  window.localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(settings));
}

export function clampRate(value: unknown) {
  const rate = typeof value === "number" ? value : Number(value);
  return Number.isFinite(rate) ? Math.max(0.5, Math.min(1.8, Math.round(rate * 20) / 20)) : 1;
}

export function clampVolume(value: unknown) {
  const volume = typeof value === "number" ? value : Number(value);
  return Number.isFinite(volume) ? Math.max(0, Math.min(1, Math.round(volume * 20) / 20)) : 1;
}

/** Spoken text should never contain markup the voice would read out literally. */
export function speakableText(value: string) {
  return value
    .replace(/https?:\/\/\S+/gu, "")
    // Emphasis markers sit directly against the word, so removing them keeps punctuation tight.
    .replace(/[*_`]/gu, "")
    .replace(/[#>|]/gu, " ")
    .replace(/\[(\d+)\]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function cancelSpeech() {
  if (!speechSupported()) return;
  window.speechSynthesis.cancel();
}

type SpeakHandlers = {
  onStart?(): void;
  onEnd?(): void;
  onError?(message: string): void;
};

export function speak(text: string, settings: VoiceSettings, handlers: SpeakHandlers = {}) {
  const content = speakableText(text);
  if (!speechSupported() || !content) {
    handlers.onEnd?.();
    return;
  }

  cancelSpeech();
  const utterance = new SpeechSynthesisUtterance(content);
  const available = window.speechSynthesis.getVoices();
  const wanted = resolveVoice(sortedVoices(available), settings)?.uri ?? "";
  const voice = available.find((entry) => entry.voiceURI === wanted);
  if (voice) utterance.voice = voice;
  utterance.lang = voice?.lang || "de-DE";
  utterance.rate = clampRate(settings.rate);
  utterance.volume = clampVolume(settings.volume);
  utterance.onstart = () => handlers.onStart?.();
  utterance.onend = () => handlers.onEnd?.();
  utterance.onerror = (event) => {
    // A cancel triggers the same error event; only real failures deserve a message.
    if (event.error === "canceled" || event.error === "interrupted") handlers.onEnd?.();
    else {
      handlers.onError?.("Die Sprachausgabe dieses Macs hat nicht reagiert.");
      handlers.onEnd?.();
    }
  };
  window.speechSynthesis.speak(utterance);
}
