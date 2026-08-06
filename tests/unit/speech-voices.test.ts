import assert from "node:assert/strict";
import test from "node:test";
import {
  bestGermanVoiceUri,
  curatedVoices,
  resolveVoice,
  speakableText,
  voiceQuality,
} from "../../features/assistant/client/speech";

const VOICES = [
  { uri: "com.apple.voice.compact.de-DE.Anna", name: "Anna", lang: "de-DE" },
  { uri: "com.apple.eloquence.de-DE.Rocko", name: "Rocko", lang: "de-DE" },
  { uri: "com.apple.voice.premium.de-DE.Petra", name: "Petra (Premium)", lang: "de-DE" },
  { uri: "com.apple.voice.premium.en-US.Ava", name: "Ava (Premium)", lang: "en-US" },
];

/** WebKit may expose either the identifier or only the display name. */
const NAME_ONLY_VOICES = [
  { uri: "Anna", name: "Anna", lang: "de-DE" },
  { uri: "Petra (Premium)", name: "Petra (Premium)", lang: "de-DE" },
];

test("ranks the macOS quality tiers by their identifier", () => {
  assert.equal(voiceQuality({ uri: "com.apple.voice.premium.de-DE.Petra", name: "Petra" }), 3);
  assert.equal(voiceQuality({ uri: "com.apple.voice.enhanced.de-DE.Markus", name: "Markus" }), 2);
  assert.equal(voiceQuality({ uri: "com.apple.voice.compact.de-DE.Anna", name: "Anna" }), 1);
  assert.equal(voiceQuality({ uri: "com.apple.eloquence.de-DE.Rocko", name: "Rocko" }), 0);
});

test("ranks by the display name when the identifier carries no tier", () => {
  assert.equal(voiceQuality({ uri: "Petra", name: "Petra (Premium)" }), 3);
  assert.equal(voiceQuality({ uri: "Markus", name: "Markus (Enhanced)" }), 2);
  assert.equal(bestGermanVoiceUri(NAME_ONLY_VOICES), "Petra (Premium)");
});

test("offers exactly one German and one English voice", () => {
  const many = [
    ...VOICES,
    { uri: "com.apple.voice.compact.en-GB.Daniel", name: "Daniel", lang: "en-GB" },
    { uri: "com.apple.eloquence.en-US.Bells", name: "Bells", lang: "en-US" },
    { uri: "com.apple.voice.compact.fr-FR.Thomas", name: "Thomas", lang: "fr-FR" },
  ];
  const curated = curatedVoices(many);

  assert.deepEqual(curated.map((voice) => voice.name), ["Petra (Premium)", "Ava (Premium)"]);
  assert.equal(curatedVoices([]).length, 0);
  // A missing language simply drops out instead of padding the list with something else.
  assert.deepEqual(curatedVoices([VOICES[0]]).map((voice) => voice.name), ["Anna"]);
});

test("reports the voice that will actually speak", () => {
  assert.equal(resolveVoice(VOICES, { voiceUri: "", rate: 1, volume: 1 })?.name, "Petra (Premium)");
  // The offered English voice is honoured.
  assert.equal(
    resolveVoice(VOICES, { voiceUri: "com.apple.voice.premium.en-US.Ava", rate: 1, volume: 1 })?.name,
    "Ava (Premium)",
  );
  // A voice that is no longer offered falls back to German instead of a novelty voice.
  assert.equal(
    resolveVoice(VOICES, { voiceUri: "com.apple.eloquence.de-DE.Rocko", rate: 1, volume: 1 })?.name,
    "Petra (Premium)",
  );
  assert.equal(resolveVoice([], { voiceUri: "", rate: 1, volume: 1 }), null);
});

test("prefers the best installed German voice over the system default", () => {
  assert.equal(bestGermanVoiceUri(VOICES), "com.apple.voice.premium.de-DE.Petra");
});

test("falls back to the compact voice when nothing better is installed", () => {
  const withoutPremium = VOICES.filter((voice) => !voice.uri.includes(".premium."));
  assert.equal(bestGermanVoiceUri(withoutPremium), "com.apple.voice.compact.de-DE.Anna");
});

test("never returns a voice from another language", () => {
  assert.equal(bestGermanVoiceUri([VOICES[3]]), "");
  assert.equal(bestGermanVoiceUri([]), "");
});

test("strips markup and links that a voice would read out literally", () => {
  assert.equal(
    speakableText("Schau **hier**: https://example.com/news [1]"),
    "Schau hier:",
  );
});
