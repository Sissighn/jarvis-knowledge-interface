import assert from "node:assert/strict";
import test from "node:test";
import { parseStructuredAnswer, verifyGroundedAnswer } from "../../features/ai/server/ollama";
import type { ModelContext } from "../../features/ai/types";

const contexts: ModelContext[] = [{
  nodeId: "rl",
  label: "Reinforcement Learning",
  group: "Machine Learning",
  content: "Ein Agent lernt durch Interaktion mit einer Umgebung und erhält Feedback in Form von Belohnungen.",
  retrievalScore: 0.9,
  matchedTerms: ["reinforcement", "learning"],
}];

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

test("drops a cited sentence that is not supported by its source", () => {
  const verified = verifyGroundedAnswer({
    provider: "ollama",
    model: "qwen3.5:4b",
    answer: "Ein Agent lernt durch Interaktion mit einer Umgebung [1]. Paris ist die Hauptstadt von Frankreich [1].",
    citations: [1],
    grounded: true,
  }, contexts);

  assert.equal(verified.grounded, true);
  assert.match(verified.answer, /Agent lernt/);
  assert.doesNotMatch(verified.answer, /Paris/);
  assert.equal(verified.grounding?.rejectedClaims, 1);
});

test("returns uncertainty when no generated claim is supported", () => {
  const verified = verifyGroundedAnswer({
    provider: "ollama",
    model: "qwen3.5:4b",
    answer: "Paris ist die Hauptstadt von Frankreich [1].",
    citations: [1],
    grounded: true,
  }, contexts);

  assert.equal(verified.grounded, false);
  assert.deepEqual(verified.citations, []);
  assert.match(verified.answer, /nicht für eine verlässlich belegte Antwort/);
});
