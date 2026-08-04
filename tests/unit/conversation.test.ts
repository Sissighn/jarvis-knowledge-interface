import assert from "node:assert/strict";
import test from "node:test";
import {
  rememberConversationTurn,
  retrievalContextFromHistory,
} from "../../features/ai/client/conversation";
import type { ConversationTurn } from "../../features/ai/types";
import type { KnowledgeAnswer } from "../../features/knowledge/answer";

const history: ConversationTurn[] = [{
  question: "Was ist Reinforcement Learning?",
  answer: "Ein Agent lernt aus Feedback.",
  sourceNodeIds: ["rl"],
}];

const answer: KnowledgeAnswer = {
  query: "Wie funktioniert das genau?",
  status: "answered",
  title: "Antwort",
  summary: "Der Agent interagiert mit seiner Umgebung. [2]",
  confidence: 0.8,
  confidenceLabel: "HOCH",
  evidence: [],
  sources: [
    { nodeId: "related", label: "Überblick", group: "ML", snippet: "Überblick", score: 0.6, matchedTerms: [] },
    { nodeId: "rl", label: "RL", group: "ML", snippet: "Agent", score: 0.9, matchedTerms: ["agent"] },
  ],
  highlightedNodeIds: ["rl"],
  caveat: "Belegt",
  generation: {
    provider: "ollama",
    model: "qwen3.5:4b",
    citations: [2],
    grounded: true,
    conversationTurns: 1,
  },
};

test("turns recent conversation into weak retrieval guidance", () => {
  const context = retrievalContextFromHistory(history);

  assert.deepEqual(context.previousQueries, ["Was ist Reinforcement Learning?"]);
  assert.deepEqual(context.preferredNodeIds, ["rl"]);
});

test("remembers only sources actually cited by the answer", () => {
  const updated = rememberConversationTurn(history, answer);

  assert.equal(updated.length, 2);
  assert.deepEqual(updated.at(-1)?.sourceNodeIds, ["rl"]);
});
