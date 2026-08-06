import assert from "node:assert/strict";
import test from "node:test";
import { curateVoices, parseVoiceList } from "../../desktop/actions/speech";

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
  assert.deepEqual(voices[2], { name: "Petra (Premium)", lang: "de-DE", quality: "premium" });
  assert.deepEqual(voices[1], { name: "Anna", lang: "de-DE", quality: "compact" });
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
