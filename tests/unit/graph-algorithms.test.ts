import assert from "node:assert/strict";
import test from "node:test";
import {
  addSimilarityEdges,
  buildTfIdfVectors,
  layoutGraph,
  sizeNodes,
} from "../../features/knowledge/server/graph-algorithms";
import type { KnowledgeEdge, KnowledgeNode } from "../../features/knowledge/types";

function node(id: string, label: string, content: string): KnowledgeNode {
  return { id, label, content, group: "Notizen", kind: "page", x: 0, y: 0, size: 3 };
}

test("creates a semantic edge between related notes", () => {
  const nodes = [
    node("react-a", "React TypeScript Patterns", "Components, hooks and TypeScript architecture"),
    node("react-b", "TypeScript React Components", "Reusable React hooks and component patterns"),
    node("food", "Vegetarische Rezepte", "Schnelle Gerichte mit Gemüse und Reis"),
  ];
  const edges: KnowledgeEdge[] = [];

  addSimilarityEdges(nodes, buildTfIdfVectors(nodes), (source, target, type, weight, reason) => {
    edges.push({ source, target, type, weight, reason });
  });

  assert.ok(edges.some((edge) => new Set([edge.source, edge.target]).has("react-a")
    && new Set([edge.source, edge.target]).has("react-b")));
  assert.ok(edges.every((edge) => edge.type === "similarity"));
});

test("lays out and sizes graph nodes deterministically", () => {
  const firstRun = [
    node("a", "Alpha", "machine learning"),
    node("b", "Beta", "machine learning"),
    node("c", "Gamma", "project planning"),
  ];
  const secondRun = structuredClone(firstRun);
  const edges: KnowledgeEdge[] = [{ source: "a", target: "b", type: "similarity", weight: 0.8 }];

  sizeNodes(firstRun, edges);
  layoutGraph(firstRun);
  sizeNodes(secondRun, edges);
  layoutGraph(secondRun);

  assert.deepEqual(firstRun, secondRun);
  assert.ok(firstRun.every((entry) => Number.isFinite(entry.x) && Number.isFinite(entry.y)));
  assert.ok((firstRun.find((entry) => entry.id === "a")?.size ?? 0) > 3);
});
