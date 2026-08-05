import assert from "node:assert/strict";
import test from "node:test";
import { createForceSimulation, moveForceNode, releaseForceNode, stepForceSimulation, syncForceSimulation } from "../../features/interface/map/force-simulation";
import { extractCorpusConcepts } from "../../features/knowledge/term-extraction";
import type { ConceptEdge, ConceptNode } from "../../features/knowledge/types";
import { discoverNotionDatabases } from "../../desktop/indexer/notion/databases";
import type { NotionClient } from "../../desktop/indexer/notion/client";

test("extracts evidenced technical concepts and rejects navigation headings", () => {
  const concepts = extractCorpusConcepts([
    { id: "a", sourceId: "one", sourceTitle: "5. Übung", databaseTitle: "Courses", headingPath: "5. Übung", text: "Reinforcement Learning verwendet eine Policy und ein Reward Signal. Reinforcement Learning optimiert die Policy." },
    { id: "b", sourceId: "two", sourceTitle: "Lecture", databaseTitle: "Courses", headingPath: "Machine Learning", text: "Supervised Learning und Reinforcement Learning sind unterschiedliche Machine Learning Verfahren." },
  ]);
  const labels = concepts.map((concept) => concept.label.toLocaleLowerCase("de-DE"));
  assert.ok(labels.some((label) => label.includes("reinforcement learning")));
  assert.ok(!labels.some((label) => /übung|zusammenfassung|ohne titel/u.test(label)));
  assert.ok(concepts.every((concept) => concept.occurrences.length > 0));
});

test("force simulation preserves positions, stays bounded and supports temporary dragging", () => {
  const node = (id: string, group: string): ConceptNode => ({ id, label: id, description: "", category: group, aliases: [], importance: 0.8, sourceCount: 1, occurrenceCount: 2, lastSeenAt: "", kind: "concept", group, x: 0, y: 0, size: 4 });
  const nodes = [node("a", "AI"), node("b", "AI"), node("c", "Data")];
  const edges: ConceptEdge[] = [{ source: "a", target: "b", type: "co_occurrence", weight: 0.8, reason: "", evidenceCount: 1 }];
  const simulation = createForceSimulation(nodes, edges);
  for (let index = 0; index < 300; index++) stepForceSimulation(simulation, nodes, false);
  assert.ok([...simulation.points.values()].every((point) => Math.hypot(point.x, point.y) <= 0.461));
  const before = { ...simulation.points.get("a")! };
  syncForceSimulation(simulation, [...nodes, node("d", "AI")], edges);
  assert.equal(simulation.points.get("a")?.x, before.x);
  moveForceNode(simulation, "a", 50, 20, 1);
  assert.equal(simulation.points.get("a")?.pinned, true);
  releaseForceNode(simulation, "a");
  assert.equal(simulation.points.get("a")?.pinned, false);
});

test("discovers stable database ids and replaces a generic title with its parent title", async () => {
  const fake = {
    async collect(_path: string, body: { filter?: { value?: string } }) {
      return body.filter?.value === "data_source"
        ? [{ object: "data_source", id: "ds-1", title: [{ plain_text: "New database" }], parent: { type: "database_id", database_id: "db-1" } }]
        : [{ object: "page", id: "parent-1", icon: { type: "emoji", emoji: "🧠" }, properties: { Name: { type: "title", title: [{ plain_text: "Second Brain" }] } } }];
    },
    async lookup(kind: string) {
      return kind === "databases" ? { id: "db-1", title: [{ plain_text: "New database" }], parent: { type: "page_id", page_id: "parent-1" } } : null;
    },
  } as unknown as NotionClient;
  const databases = await discoverNotionDatabases(fake);
  assert.equal(databases[0].id, "db-1");
  assert.deepEqual(databases[0].dataSourceIds, ["ds-1"]);
  assert.equal(databases[0].title, "Second Brain");
  assert.equal(databases[0].icon, "🧠");
});
