import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSpeechRms } from "../../features/assistant/client/native-speech";

test("keeps silence still and maps real speech into a bounded visual level", () => {
  assert.equal(normalizeSpeechRms(0), 0);
  assert.equal(normalizeSpeechRms(0.008), 0);
  assert.ok(normalizeSpeechRms(0.06) > 0);
  assert.equal(normalizeSpeechRms(2), 1);
  assert.equal(normalizeSpeechRms(Number.NaN), 0);
});
