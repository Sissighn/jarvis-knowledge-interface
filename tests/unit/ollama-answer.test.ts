import assert from "node:assert/strict";
import test from "node:test";
import { parseStructuredAnswer } from "../../features/ai/server/ollama";

test("removes uncited model sentences from a grounded answer", () => {
  const parsed = parseStructuredAnswer(JSON.stringify({
    answer: "Ein Agent lernt durch Interaktion [1]. Diese unbelegte Ergänzung stammt nicht aus der Quelle.",
    citations: [1],
    sufficientContext: true,
  }), 1, "qwen3.5:4b");

  assert.equal(parsed.answer, "Ein Agent lernt durch Interaktion [1].");
  assert.deepEqual(parsed.citations, [1]);
  assert.equal(parsed.grounded, true);
});

test("accepts citation indices returned as numeric strings", () => {
  const parsed = parseStructuredAnswer(JSON.stringify({
    answer: "Der Kontext reicht für diese Aussage.",
    citations: ["1"],
    sufficientContext: true,
  }), 1, "qwen3.5:4b");

  assert.match(parsed.answer, /\[1\]$/);
  assert.deepEqual(parsed.citations, [1]);
});
