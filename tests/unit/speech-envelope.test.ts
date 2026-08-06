import assert from "node:assert/strict";
import test from "node:test";
import { buildSpeechEnvelope, sampleSpeechEnvelope } from "../../features/assistant/client/speech-envelope";

test("builds the same motion for the same spoken sentence", () => {
  const first = buildSpeechEnvelope("Heute regnet es ab siebzehn Uhr.", 1);
  const second = buildSpeechEnvelope("Heute regnet es ab siebzehn Uhr.", 1);

  assert.deepEqual(first, second);
  assert.ok(first.durationMs > 0);
});

test("creates visible word energy and silent punctuation pauses", () => {
  const envelope = buildSpeechEnvelope("Ja, danach weiter.", 1);
  const word = envelope.segments.find((segment) => segment.energy > 0);
  const pause = envelope.segments.find((segment) => segment.energy === 0 && segment.endMs - segment.startMs > 100);

  assert.ok(word);
  assert.ok(pause);
  assert.ok(sampleSpeechEnvelope(envelope, (word.startMs + word.endMs) / 2) > 0.1);
  assert.equal(sampleSpeechEnvelope(envelope, (pause.startMs + pause.endMs) / 2), 0);
});

test("matches a faster configured voice with a shorter animation", () => {
  const slow = buildSpeechEnvelope("Das ist eine gesprochene Antwort.", 0.7);
  const fast = buildSpeechEnvelope("Das ist eine gesprochene Antwort.", 1.6);

  assert.ok(fast.durationMs < slow.durationMs);
  assert.equal(sampleSpeechEnvelope(fast, -1), 0);
  assert.equal(sampleSpeechEnvelope(fast, fast.durationMs), 0);
});

test("blends neighbouring speech samples without harsh character steps", () => {
  const envelope = buildSpeechEnvelope("Neuronale Bewegungen bleiben weich.", 1);
  const samples = Array.from({ length: Math.ceil(envelope.durationMs / 12) }, (_, index) => (
    sampleSpeechEnvelope(envelope, index * 12)
  ));
  const largestStep = samples.reduce((largest, sample, index) => (
    Math.max(largest, Math.abs(sample - (samples[index - 1] ?? sample)))
  ), 0);

  assert.ok(largestStep < 0.2, `speech envelope jumped by ${largestStep}`);
});
