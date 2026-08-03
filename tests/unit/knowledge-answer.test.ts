import assert from "node:assert/strict";
import test from "node:test";
import { answerKnowledge } from "../../features/knowledge/answer";
import type { KnowledgeEdge, KnowledgeNode } from "../../features/knowledge/types";

const nodes: KnowledgeNode[] = [
  { id: "root", label: "Notion", group: "System", kind: "system", x: 0, y: 0, size: 7 },
  {
    id: "ml",
    label: "Backpropagation",
    group: "Machine Learning",
    kind: "page",
    x: 0.1,
    y: 0.1,
    size: 4,
    content: "Backpropagation berechnet den Gradienten des Fehlers schrittweise vom Ausgang zum Eingang. Der Optimierer aktualisiert anschließend die Gewichte des neuronalen Netzes.",
  },
  {
    id: "stats",
    label: "Gradienten",
    group: "Statistik",
    kind: "page",
    x: 0.2,
    y: 0.2,
    size: 3,
    content: "Ein Gradient beschreibt die Richtung des stärksten Anstiegs einer Funktion.",
  },
  { id: "atlas", label: "Projekt Atlas", group: "Projekte", kind: "page", x: -0.2, y: 0, size: 3 },
];

const edges: KnowledgeEdge[] = [
  { source: "ml", target: "stats", type: "relation", weight: 1 },
];

test("builds an answer only from grounded note content", () => {
  const answer = answerKnowledge(nodes, edges, "Wie funktioniert Backpropagation?");

  assert.equal(answer.status, "answered");
  assert.equal(answer.sources[0]?.nodeId, "ml");
  assert.match(answer.evidence[0]?.text ?? "", /berechnet den Gradienten/);
  assert.ok(answer.highlightedNodeIds.includes("stats"));
  assert.ok(answer.confidence > 0.3);
});

test("returns an uncertainty state when only a title matches", () => {
  const answer = answerKnowledge(nodes, edges, "Projekt Atlas");

  assert.equal(answer.status, "uncertain");
  assert.equal(answer.evidence.length, 0);
  assert.equal(answer.sources[0]?.nodeId, "atlas");
  assert.match(answer.caveat, /statt aus Seitentiteln/);
});

test("does not invent an answer when nothing matches", () => {
  const answer = answerKnowledge(nodes, edges, "Quantenphysik und schwarze Löcher");

  assert.equal(answer.status, "not_found");
  assert.equal(answer.sources.length, 0);
  assert.equal(answer.confidence, 0);
});
