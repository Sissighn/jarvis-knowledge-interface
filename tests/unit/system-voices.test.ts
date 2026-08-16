import assert from "node:assert/strict";
import test from "node:test";
import { curateVoices, parseVoiceList, pcmFromWav } from "../../desktop/actions/speech";

/** Real output of `say -v '?'` on a Mac with a downloaded premium voice. */
const SAY_OUTPUT = [
  "Alva                sv_SE    # Hej! Jag heter Alva.",
  "Anna                de_DE    # Hallo! Ich heiße Anna.",
  "Petra (Premium)     de_DE    # Hallo! Ich heiße Petra.",
  "Rocko (German (Germany)) de_DE    # Hallo! Ich heiße Rocko.",
  "Samantha            en_US    # Hello! My name is Samantha.",
  "Ava (Premium)       en_US    # Hello! My name is Ava.",
  "Bells               en_US    # Time flies when you are having fun.",
].join("\n");

test("parses names with spaces and brackets out of the fixed-width listing", () => {
  const voices = parseVoiceList(SAY_OUTPUT);

  assert.equal(voices.length, 7);
  assert.deepEqual(voices[2], {
    id: "Petra (Premium)",
    name: "Petra (Premium)",
    lang: "de-DE",
    quality: "premium",
  });
  assert.deepEqual(voices[1], { id: "Anna", name: "Anna", lang: "de-DE", quality: "compact" });
  assert.equal(voices.find((voice) => voice.name.startsWith("Rocko"))?.lang, "de-DE");
});

test("offers the premium voice per language and drops the novelty ones", () => {
  const curated = curateVoices(parseVoiceList(SAY_OUTPUT));

  assert.deepEqual(curated.map((voice) => voice.name), ["Petra (Premium)", "Ava (Premium)"]);
});

test("falls back to the compact voice when nothing better is installed", () => {
  const withoutPremium = parseVoiceList(SAY_OUTPUT).filter((voice) => !voice.name.includes("Premium"));

  assert.deepEqual(curateVoices(withoutPremium).map((voice) => voice.name), ["Anna", "Samantha"]);
});

test("prefers the common locale when the quality is equal", () => {
  const mixed = parseVoiceList([
    "Aman                en_IN    # Hello! My name is Aman.",
    "Samantha            en_US    # Hello! My name is Samantha.",
    "Daniel              en_GB    # Hello! My name is Daniel.",
  ].join("\n"));

  assert.deepEqual(curateVoices(mixed).map((voice) => voice.name), ["Samantha"]);
});

test("never returns a novelty voice even when it is the only one", () => {
  const noveltyOnly = parseVoiceList("Bells               en_US    # Time flies.");

  assert.deepEqual(curateVoices(noveltyOnly), []);
});

test("ignores lines that are not voice entries", () => {
  assert.deepEqual(parseVoiceList("irgendein Text ohne Sprache\n\n"), []);
});

/** Builds a WAV the way `say` writes one: chunks, in order, with the samples last. */
function wavFile(chunks: [string, Uint8Array][]) {
  const body = chunks.flatMap(([id, payload]) => {
    const header = new Uint8Array(8);
    const view = new DataView(header.buffer);
    header.set([...id].map((character) => character.charCodeAt(0)));
    view.setUint32(4, payload.byteLength, true);
    // Odd chunks are padded to an even length, and the padding is not part of the size.
    const padding = new Uint8Array(payload.byteLength % 2);
    return [header, payload, padding];
  });
  const total = body.reduce((sum, part) => sum + part.byteLength, 0);
  const file = new Uint8Array(12 + total);
  file.set([...("RIFF....WAVE")].map((character) => character.charCodeAt(0)));
  let offset = 12;
  for (const part of body) {
    file.set(part, offset);
    offset += part.byteLength;
  }
  return file;
}

test("finds the samples behind the metadata chunk say writes first", () => {
  const samples = new Uint8Array(new Float32Array([0, 0.5, -0.5]).buffer);
  const file = wavFile([
    ["fmt ", new Uint8Array(16)],
    // A metadata chunk of odd length, which is what pushes the audio off the fixed offset.
    ["LIST", new Uint8Array([1, 2, 3])],
    ["data", samples],
  ]);

  assert.deepEqual(pcmFromWav(file), samples);
});

test("refuses a file that carries no audio at all", () => {
  assert.throws(() => pcmFromWav(wavFile([["fmt ", new Uint8Array(16)]])), /keine Audiodaten/u);
});
