/**
 * A deterministic speech envelope derived from the exact sentence JARVIS reads.
 * Words create syllable-shaped energy, punctuation creates silence. This keeps the
 * core visually tied to the spoken answer without pretending that random noise is audio.
 */

const BASE_WORDS_PER_MINUTE = 180;
const TOKEN_PATTERN = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*|[^\s]/gu;
const VOWEL_GROUP_PATTERN = /[aeiouyäöüàáâèéêìíîòóôùúû]+/giu;
const VOWEL_PATTERN = /[aeiouyäöüàáâèéêìíîòóôùúû]/iu;
const WORD_PATTERN = /^[\p{L}\p{N}]/u;

export type SpeechEnvelopeSegment = {
  startMs: number;
  endMs: number;
  energy: number;
  syllables: number;
  phonemes: number[];
};

export type SpeechEnvelope = {
  durationMs: number;
  segments: SpeechEnvelopeSegment[];
};

function clampRate(rate: number) {
  return Number.isFinite(rate) ? Math.max(0.5, Math.min(1.8, rate)) : 1;
}

function punctuationPause(token: string, rate: number) {
  const factor = 1 / Math.sqrt(rate);
  if (/[.!?]/u.test(token)) return 300 * factor;
  if (/[,;:]/u.test(token)) return 165 * factor;
  if (/[–—-]/u.test(token)) return 110 * factor;
  return 55 * factor;
}

function phonemeEnergy(character: string) {
  if (VOWEL_PATTERN.test(character)) return 1;
  if (/[bdgkpt]/iu.test(character)) return 0.82;
  if (/[fsvwzß]/iu.test(character)) return 0.66;
  if (/\p{N}/u.test(character)) return 0.76;
  return 0.58;
}

/** Builds word timing from the same 180 WPM anchor used by the macOS `say` process. */
export function buildSpeechEnvelope(text: string, rawRate = 1): SpeechEnvelope {
  const rate = clampRate(rawRate);
  const wordDuration = 60_000 / (BASE_WORDS_PER_MINUTE * rate);
  const segments: SpeechEnvelopeSegment[] = [];
  let cursor = 0;

  for (const token of text.match(TOKEN_PATTERN) ?? []) {
    if (!WORD_PATTERN.test(token)) {
      const duration = punctuationPause(token, rate);
      segments.push({ startMs: cursor, endMs: cursor + duration, energy: 0, syllables: 0, phonemes: [] });
      cursor += duration;
      continue;
    }

    const characters = Array.from(token).filter((character) => /[\p{L}\p{N}]/u.test(character));
    const syllables = Math.max(1, token.match(VOWEL_GROUP_PATTERN)?.length ?? 0);
    const lengthFactor = Math.min(0.2, Math.max(0, characters.length - 4) * 0.018);
    const duration = wordDuration * (0.68 + syllables * 0.14 + lengthFactor);
    const energy = Math.min(1, 0.52 + syllables * 0.08 + Math.min(0.18, characters.length * 0.012));
    segments.push({
      startMs: cursor,
      endMs: cursor + duration,
      energy,
      syllables,
      phonemes: characters.map(phonemeEnergy),
    });
    cursor += duration;

    // A short closure between words prevents the core from becoming one continuous pulse.
    const gap = 34 / Math.sqrt(rate);
    segments.push({ startMs: cursor, endMs: cursor + gap, energy: 0, syllables: 0, phonemes: [] });
    cursor += gap;
  }

  return { durationMs: cursor, segments };
}

function smoothStep(value: number) {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

function sampleRawSpeechEnvelope(envelope: SpeechEnvelope, elapsedMs: number) {
  if (elapsedMs < 0 || elapsedMs >= envelope.durationMs) return 0;
  const segment = envelope.segments.find((candidate) => (
    elapsedMs >= candidate.startMs && elapsedMs < candidate.endMs
  ));
  if (!segment?.energy || !segment.phonemes.length) return 0;

  const progress = (elapsedMs - segment.startMs) / Math.max(1, segment.endMs - segment.startMs);
  const attack = smoothStep(progress / 0.13);
  const release = smoothStep((1 - progress) / 0.16);
  // Blend between neighbouring letters instead of stepping from one value to the next.
  // The core should glide through a word, not twitch on every character boundary.
  const phonemePosition = progress * Math.max(0, segment.phonemes.length - 1);
  const phonemeIndex = Math.floor(phonemePosition);
  const nextPhonemeIndex = Math.min(segment.phonemes.length - 1, phonemeIndex + 1);
  const phonemeMix = phonemePosition - phonemeIndex;
  const phoneme = (segment.phonemes[phonemeIndex] ?? 0.6) * (1 - phonemeMix)
    + (segment.phonemes[nextPhonemeIndex] ?? 0.6) * phonemeMix;
  // Each detected syllable opens and closes the form once; letters determine its strength.
  const syllableShape = 0.72
    + (0.5 - Math.cos(progress * segment.syllables * Math.PI * 2) * 0.5) * 0.28;
  return Math.max(0, Math.min(1, segment.energy * phoneme * syllableShape * attack * release));
}

/** Returns a short, centred moving average so adjacent phonemes never create a hard edge. */
export function sampleSpeechEnvelope(envelope: SpeechEnvelope, elapsedMs: number) {
  if (elapsedMs < 0 || elapsedMs >= envelope.durationMs) return 0;
  const offsets = [-36, -24, -12, 0, 12, 24, 36];
  const weights = [1, 2, 3, 4, 3, 2, 1];
  const weighted = offsets.reduce((sum, offset, index) => (
    sum + sampleRawSpeechEnvelope(envelope, elapsedMs + offset) * weights[index]
  ), 0);
  return weighted / 16;
}
