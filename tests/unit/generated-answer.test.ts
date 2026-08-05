import assert from "node:assert/strict";
import test from "node:test";
import { mergeGeneratedAnswer, remapCitations } from "../../features/ai/client/generate-answer";
import type { GeneratedAnswer } from "../../features/ai/types";
import type { KnowledgeAnswer } from "../../features/knowledge/answer";

const baseAnswer: KnowledgeAnswer = {
  query: "Was ist Reinforcement Learning?",
  status: "answered",
  title: "Antwort aus deinem Wissen",
  summary: "Aus zwei Notizen ergeben sich belegte Hinweise:",
  confidence: 0.79,
  confidenceLabel: "HOCH",
  evidence: [{
    chunkId: "rl:0",
    sourceTitle: "AI Methods",
    headingPath: "Reinforcement Learning",
    text: "Ein Agent lernt durch die Interaktion mit einer Umgebung.",
  }],
  sources: [{
    chunkId: "rl:0",
    sourceId: "rl",
    sourceTitle: "AI Methods",
    rootTitle: "Courses",
    headingPath: "Reinforcement Learning",
    snippet: "Ein Agent lernt durch die Interaktion mit einer Umgebung.",
    notionUrl: "https://notion.so/ai-methods",
    score: 0.79,
    matchedTerms: ["reinforcement", "learning"],
  }],
  highlightedConceptIds: ["concept:reinforcement-learning"],
  caveat: "Lokale Extraktion.",
};

test("merges a grounded local-model answer without losing its sources", () => {
  const generated: GeneratedAnswer = {
    provider: "ollama",
    model: "qwen3.5:4b",
    answer: "Reinforcement Learning lässt einen Agenten durch Feedback aus seiner Umgebung lernen. [1]",
    citations: [1],
    grounded: true,
  };

  const answer = mergeGeneratedAnswer(baseAnswer, generated, 2);

  assert.equal(answer.status, "answered");
  assert.equal(answer.evidence.length, 0);
  assert.equal(answer.sources, baseAnswer.sources);
  assert.deepEqual(answer.highlightedConceptIds, ["concept:reinforcement-learning"]);
  assert.deepEqual(answer.generation?.citations, [1]);
  assert.equal(answer.generation?.conversationTurns, 2);
  assert.match(answer.summary, /Agenten durch Feedback/);
});

test("keeps an explicit uncertainty state when the context is insufficient", () => {
  const generated: GeneratedAnswer = {
    provider: "ollama",
    model: "qwen3.5:4b",
    answer: "Die gefundenen Notizen reichen für eine sichere Erklärung nicht aus.",
    citations: [],
    grounded: false,
  };

  const answer = mergeGeneratedAnswer(baseAnswer, generated);

  assert.equal(answer.status, "uncertain");
  assert.equal(answer.generation?.grounded, false);
  assert.match(answer.caveat, /keine ausreichend belegte Antwort/);
});

test("keeps citation numbers aligned when a title-only source is skipped", () => {
  const generated: GeneratedAnswer = {
    provider: "ollama",
    model: "qwen3.5:4b",
    answer: "Die Definition steht in der zweiten verwendbaren Notiz. [2]",
    citations: [2],
    grounded: true,
  };

  const remapped = remapCitations(generated, [2, 4]);

  assert.deepEqual(remapped.citations, [4]);
  assert.match(remapped.answer, /\[4\]/);
});
