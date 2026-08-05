import assert from "node:assert/strict";
import test from "node:test";
import {
  MAP_EDGES_PER_CONCEPT,
  SEMANTIC_NEIGHBOURS_PER_CONCEPT,
  buildCoOccurrenceEdges,
  buildSemanticEdges,
  cosineSimilarity,
  dedupeEdges,
  limitEdgesPerConcept,
  validateModelRelations,
  type ConceptVector,
} from "../../features/knowledge/relations";
import type { ConceptEdge } from "../../features/knowledge/types";

const occurrences = [
  { conceptId: "concept:reinforcement-learning", chunkId: "rl:0", sourceId: "rl" },
  { conceptId: "concept:policy", chunkId: "rl:0", sourceId: "rl" },
  { conceptId: "concept:reward", chunkId: "rl:0", sourceId: "rl" },
  { conceptId: "concept:reinforcement-learning", chunkId: "exam:3", sourceId: "exam" },
  { conceptId: "concept:policy", chunkId: "exam:3", sourceId: "exam" },
];

test("weights co-occurrence by distinct chunks and sources", () => {
  const edges = buildCoOccurrenceEdges(occurrences);
  const rlPolicy = edges.find((edge) => edge.source === "concept:policy" && edge.target === "concept:reinforcement-learning");
  const rlReward = edges.find((edge) => edge.target === "concept:reward" || edge.source === "concept:reward");

  assert.equal(edges.length, 3);
  assert.ok(rlPolicy);
  assert.equal(rlPolicy.evidenceCount, 2);
  assert.ok(rlReward);
  assert.ok(rlPolicy.weight > rlReward.weight);
  assert.match(rlPolicy.reason, /2 Abschnitten aus 2 Quellen/);
});

test("creates semantic edges above the cosine threshold only", () => {
  const vectors: ConceptVector[] = [
    { conceptId: "a", label: "Attention", vector: [1, 0, 0] },
    { conceptId: "b", label: "Self-Attention", vector: [0.96, 0.2, 0] },
    { conceptId: "c", label: "Vegetarische Rezepte", vector: [0, 0, 1] },
  ];

  const edges = buildSemanticEdges(vectors);

  assert.equal(edges.length, 1);
  assert.equal(edges[0].type, "semantic");
  assert.ok(edges[0].weight >= 0.72);
  assert.ok(cosineSimilarity([1, 0, 0], [0, 1, 0]) === 0);
});

test("limits semantic neighbours per concept", () => {
  const vectors: ConceptVector[] = Array.from({ length: 8 }, (unused, index) => ({
    conceptId: `c${index}`,
    label: `Concept ${index}`,
    vector: [1, index * 0.001, 0],
  }));

  const edges = buildSemanticEdges(vectors);
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  assert.ok([...degree.values()].every((value) => value <= SEMANTIC_NEIGHBOURS_PER_CONCEPT));
});

test("accepts model relations only with real chunk and concept evidence", () => {
  const evidence = {
    knownChunkIds: new Set(["rl:0"]),
    evidencedConceptIds: new Set(["concept:reinforcement-learning", "concept:policy"]),
    conceptIdsByChunk: new Map([["rl:0", new Set(["concept:reinforcement-learning", "concept:policy"])]]),
  };

  const edges = validateModelRelations([
    { source: "concept:reinforcement-learning", target: "concept:policy", type: "part_of", reason: "Die Policy ist der gelernte Teil.", chunkId: "rl:0" },
    { source: "concept:reinforcement-learning", target: "concept:policy", type: "invented", reason: "x", chunkId: "rl:0" },
    { source: "concept:reinforcement-learning", target: "concept:unknown", type: "uses", reason: "x", chunkId: "rl:0" },
    { source: "concept:reinforcement-learning", target: "concept:policy", type: "uses", reason: "x", chunkId: "missing:9" },
  ], evidence);

  assert.equal(edges.length, 1);
  assert.equal(edges[0].type, "part_of");
  assert.equal(edges[0].evidenceCount, 1);
  assert.match(edges[0].reason, /gelernte Teil/);
});

test("prefers evidenced model relations over derived edges for the same pair", () => {
  const merged = dedupeEdges([
    { source: "a", target: "b", type: "co_occurrence", weight: 0.94, reason: "gemeinsam", evidenceCount: 9 },
    { source: "a", target: "b", type: "contrasts_with", weight: 0.75, reason: "Abgrenzung", evidenceCount: 1 },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].type, "contrasts_with");
});

test("shows at most eight edges per concept on the map", () => {
  const edges: ConceptEdge[] = Array.from({ length: 14 }, (unused, index) => ({
    source: "hub",
    target: `n${index}`,
    type: "co_occurrence",
    weight: 1 - index * 0.01,
    reason: "gemeinsam",
    evidenceCount: 1,
  }));

  const limited = limitEdgesPerConcept(edges);

  assert.equal(limited.length, MAP_EDGES_PER_CONCEPT);
  assert.deepEqual(limited.map((edge) => edge.target).slice(0, 3), ["n0", "n1", "n2"]);
});
