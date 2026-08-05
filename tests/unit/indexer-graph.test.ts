import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chunkSourceBlocks } from "../../features/knowledge/chunking";
import {
  KNOWLEDGE_ROOT_ID,
  knowledgeRootNode,
  layoutConceptNodes,
  rootEdges,
  sizeConceptNodes,
} from "../../features/knowledge/graph-layout";
import type { ConceptEdge, ConceptNode } from "../../features/knowledge/types";
import { closeKnowledgeDatabase, openKnowledgeDatabase } from "../../desktop/indexer/db/database";
import { KnowledgeRepository } from "../../desktop/indexer/db/repository";
import { buildKnowledgeGraph } from "../../desktop/indexer/graph";
import { chunkNotionUrl, selectDiverseChunks } from "../../desktop/indexer/retrieval";

function concept(id: string, label: string, category: string, sources = 2, occurrences = 4): ConceptNode {
  return {
    id,
    label,
    description: `${label} Beschreibung`,
    category,
    aliases: [],
    importance: 0.6,
    sourceCount: sources,
    occurrenceCount: occurrences,
    lastSeenAt: "2026-08-05T00:00:00.000Z",
    kind: "concept",
    group: category,
    x: 0,
    y: 0,
    size: 3,
  };
}

test("sizes and lays out concept nodes deterministically", () => {
  const build = () => [knowledgeRootNode(), concept("a", "Policy", "ML"), concept("b", "Reward", "ML"), concept("c", "Attention", "DL")];
  const edges: ConceptEdge[] = [{ source: "a", target: "b", type: "co_occurrence", weight: 0.6, reason: "gemeinsam", evidenceCount: 2 }];

  const first = build();
  const second = build();
  layoutConceptNodes(sizeConceptNodes(first, edges));
  layoutConceptNodes(sizeConceptNodes(second, edges));

  assert.deepEqual(first, second);
  assert.equal(first[0].size, 7);
  assert.ok(first.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)));
  assert.ok(first.slice(1).every((node) => node.size >= 2.6 && node.size <= 6.2));
});

test("connects the hub with the strongest concept of every category", () => {
  const nodes = [knowledgeRootNode(), concept("a", "Policy", "ML", 5, 20), concept("b", "Reward", "ML", 1, 2), concept("c", "Attention", "DL")];
  const edges = rootEdges(nodes, []);

  assert.equal(edges.length, 2);
  assert.ok(edges.every((edge) => edge.source === KNOWLEDGE_ROOT_ID && edge.type === "root"));
  assert.ok(edges.some((edge) => edge.target === "a"));
  assert.ok(!edges.some((edge) => edge.target === "b"));
});

test("builds a filtered concept graph out of the local index", () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-graph-"));
  const database = openKnowledgeDatabase(join(directory, "knowledge-index.sqlite3"));
  const repository = new KnowledgeRepository(database);
  try {
    repository.replaceDatabases([
      { id: "root-courses", dataSourceIds: ["ds-courses"], title: "Courses", originalTitle: "Courses", icon: null, parentId: null, parentTitle: null, url: null, contentCount: 1, selected: false, lastSeenAt: new Date().toISOString() },
      { id: "root-knowledge", dataSourceIds: ["ds-knowledge"], title: "Knowledge", originalTitle: "Knowledge", icon: null, parentId: null, parentTitle: null, url: null, contentCount: 1, selected: false, lastSeenAt: new Date().toISOString() },
    ]);
    repository.setSelectedDatabases(["root-courses", "root-knowledge"]);
    for (const [sourceId, rootId, rootTitle, text] of [
      ["page-1", "root-courses", "Courses", "Die Policy bildet Zustände auf Aktionen ab."],
      ["page-2", "root-knowledge", "Knowledge", "Attention gewichtet Sequenzteile."],
    ] as const) {
      repository.replaceSourceContent(
        {
          id: sourceId,
          objectType: "page",
          title: sourceId,
          rootId,
          rootTitle,
          parentPath: "",
          url: `https://notion.so/${sourceId}`,
          lastEditedTime: null,
          databaseId: rootId,
        },
        chunkSourceBlocks([{ blockId: `${sourceId}-b`, headingPath: ["AI"], text }]),
        0,
        `hash-${sourceId}`,
      );
    }

    const policyChunk = repository.listChunksForSource("page-1")[0].id;
    const attentionChunk = repository.listChunksForSource("page-2")[0].id;
    repository.upsertConcept({ id: "concept:policy", label: "Policy", normalized: "policy", aliases: [], description: "Zustand auf Aktion.", category: "Machine Learning", importance: 0.8 });
    repository.upsertConcept({ id: "concept:attention", label: "Attention", normalized: "attention", aliases: [], description: "Gewichtung.", category: "Deep Learning", importance: 0.7 });
    repository.addOccurrences([{ conceptId: "concept:policy", chunkId: policyChunk, sourceId: "page-1", snippet: "Policy", confidence: 0.9 }]);
    repository.addOccurrences([{ conceptId: "concept:attention", chunkId: attentionChunk, sourceId: "page-2", snippet: "Attention", confidence: 0.9 }]);
    repository.replaceRelations([{ source: "concept:policy", target: "concept:attention", type: "semantic", weight: 0.8, reason: "ähnlich", evidenceCount: 1 }]);

    const full = buildKnowledgeGraph(repository);
    assert.deepEqual(full.nodes.filter((node) => node.kind === "concept").map((node) => node.label).sort(), ["Attention", "Policy"]);
    assert.deepEqual(full.roots.map((root) => root.title).sort(), ["Courses", "Knowledge"]);
    assert.equal(full.coverage.concepts, 2);

    const filtered = buildKnowledgeGraph(repository, { rootIds: ["root-courses"] });
    assert.deepEqual(filtered.nodes.filter((node) => node.kind === "concept").map((node) => node.label), ["Policy"]);
    assert.equal(filtered.edges.filter((edge) => edge.type === "semantic").length, 0);

    const byCategory = buildKnowledgeGraph(repository, { categories: ["Deep Learning"] });
    assert.deepEqual(byCategory.nodes.filter((node) => node.kind === "concept").map((node) => node.label), ["Attention"]);
  } finally {
    closeKnowledgeDatabase(database);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("limits answer chunks to eight passages from five sources", () => {
  const ranked = Array.from({ length: 30 }, (unused, index) => ({
    chunk: {
      id: `s${index % 9}:${index}`,
      sourceId: `s${index % 9}`,
      blockId: null,
      headingPath: "",
      text: "",
      position: index,
      sourceTitle: "",
      rootTitle: "",
      url: "",
    },
    score: 1 - index * 0.01,
  }));

  const selected = selectDiverseChunks(ranked);

  assert.equal(selected.length, 8);
  assert.ok(new Set(selected.map((entry) => entry.chunk.sourceId)).size <= 5);
});

test("links a chunk to its exact Notion block when available", () => {
  const base = {
    id: "page-1:0",
    sourceId: "page-1",
    headingPath: "",
    text: "",
    position: 0,
    sourceTitle: "",
    rootTitle: "",
    url: "https://notion.so/page-1",
  };

  assert.equal(chunkNotionUrl({ ...base, blockId: "1a2b-3c4d" }), "https://notion.so/page-1#1a2b3c4d");
  assert.equal(chunkNotionUrl({ ...base, blockId: null }), "https://notion.so/page-1");
  assert.equal(chunkNotionUrl({ ...base, blockId: null, url: "" }), "");
});
