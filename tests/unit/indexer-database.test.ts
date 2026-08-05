import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chunkSourceBlocks } from "../../features/knowledge/chunking";
import { DatabaseSync } from "node:sqlite";
import { closeKnowledgeDatabase, openKnowledgeDatabase } from "../../desktop/indexer/db/database";
import { MIGRATIONS } from "../../desktop/indexer/db/migrations";
import { KnowledgeRepository, blobToVector, type SourceRecord } from "../../desktop/indexer/db/repository";

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-index-"));
  const path = join(directory, "knowledge-index.sqlite3");
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: "page-1",
    objectType: "page",
    title: "5. Übung",
    rootId: "root-courses",
    rootTitle: "Courses",
    parentPath: "AI Methods",
    url: "https://notion.so/page-1",
    lastEditedTime: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function selectDatabase(repository: KnowledgeRepository, id = "root-courses", title = "Courses") {
  repository.replaceDatabases([{
    id,
    dataSourceIds: [`ds:${id}`],
    title,
    originalTitle: title,
    icon: null,
    parentId: null,
    parentTitle: null,
    url: null,
    contentCount: 0,
    selected: false,
    lastSeenAt: new Date().toISOString(),
  }]);
  repository.setSelectedDatabases([id]);
}

const blocks = [
  { blockId: "b1", headingPath: ["AI Methods", "Reinforcement Learning"], text: "Ein Agent lernt aus Belohnung." },
  { blockId: "b2", headingPath: ["AI Methods", "Reinforcement Learning"], text: "Die Policy bildet Zustände auf Aktionen ab." },
];

test("applies migrations once and survives a reopen", () => {
  const { path, cleanup } = temporaryDatabase();
  try {
    const first = openKnowledgeDatabase(path);
    const versions = first.prepare("SELECT version FROM schema_version").all();
    closeKnowledgeDatabase(first);

    const second = openKnowledgeDatabase(path);
    const repeated = second.prepare("SELECT version FROM schema_version").all();
    const journal = second.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    closeKnowledgeDatabase(second);

    assert.equal(versions.length, MIGRATIONS.length);
    assert.deepEqual(repeated, versions);
    assert.equal(journal.journal_mode, "wal");
  } finally {
    cleanup();
  }
});

test("stores sources, chunks and full-text rows atomically", () => {
  const { path, cleanup } = temporaryDatabase();
  const database = openKnowledgeDatabase(path);
  const repository = new KnowledgeRepository(database);
  try {
    selectDatabase(repository);
    repository.replaceSourceContent(source(), chunkSourceBlocks(blocks), 2, "hash-1");
    const chunks = repository.listChunksForSource("page-1");

    assert.ok(chunks.length >= 1);
    assert.equal(chunks[0].sourceTitle, "5. Übung");
    assert.equal(chunks[0].rootTitle, "Courses");
    assert.equal(repository.coverage().indexedSources, 1);
    assert.equal(repository.coverage().unsupportedBlocks, 2);
    assert.ok(repository.searchChunksByText('"policy"*', 10).length >= 1);
  } finally {
    closeKnowledgeDatabase(database);
    cleanup();
  }
});

test("refreshes source metadata without discarding unchanged chunks or embeddings", () => {
  const { path, cleanup } = temporaryDatabase();
  const database = openKnowledgeDatabase(path);
  const repository = new KnowledgeRepository(database);
  try {
    selectDatabase(repository);
    repository.replaceSourceContent(source(), chunkSourceBlocks(blocks), 0, "hash-1");
    const chunkId = repository.listChunksForSource("page-1")[0].id;
    repository.saveEmbedding("chunk", chunkId, "embeddinggemma", new Float32Array([0.25, 0.75]));

    repository.updateSourceMetadata(source({
      title: "Reinforcement Learning Notes",
      lastEditedTime: "2026-08-03T12:00:00.000Z",
      tags: ["Machine Learning"],
    }));

    assert.equal(repository.getSource("page-1")?.title, "Reinforcement Learning Notes");
    assert.equal(repository.getSource("page-1")?.lastEditedTime, "2026-08-03T12:00:00.000Z");
    assert.equal(repository.getSource("page-1")?.contentHash, "hash-1");
    assert.deepEqual([...repository.listEmbeddings("chunk", "embeddinggemma").get(chunkId) ?? []], [0.25, 0.75]);
  } finally {
    closeKnowledgeDatabase(database);
    cleanup();
  }
});

test("keeps the previous version when a page update fails", () => {
  const { path, cleanup } = temporaryDatabase();
  const database = openKnowledgeDatabase(path);
  const repository = new KnowledgeRepository(database);
  try {
    selectDatabase(repository);
    repository.replaceSourceContent(source(), chunkSourceBlocks(blocks), 0, "hash-1");
    const before = repository.listChunksForSource("page-1");

    assert.throws(() => repository.transaction(() => {
      repository.clearOccurrencesForSource("page-1");
      throw new Error("Notion request failed");
    }), /Notion request failed/);

    const after = repository.listChunksForSource("page-1");
    assert.deepEqual(after.map((chunk) => chunk.id), before.map((chunk) => chunk.id));
    assert.equal(repository.getSource("page-1")?.contentHash, "hash-1");
  } finally {
    closeKnowledgeDatabase(database);
    cleanup();
  }
});

test("replaces chunks incrementally without leaving orphans", () => {
  const { path, cleanup } = temporaryDatabase();
  const database = openKnowledgeDatabase(path);
  const repository = new KnowledgeRepository(database);
  try {
    selectDatabase(repository);
    repository.replaceSourceContent(source(), chunkSourceBlocks(blocks), 0, "hash-1");
    repository.replaceSourceContent(
      source({ lastEditedTime: "2026-08-02T09:00:00.000Z" }),
      chunkSourceBlocks([blocks[0]]),
      0,
      "hash-2",
    );

    assert.equal(repository.countChunks(), 1);
    assert.equal(repository.getSource("page-1")?.contentHash, "hash-2");
    assert.equal(repository.searchChunksByText('"aktionen"*', 10).length, 0);
  } finally {
    closeKnowledgeDatabase(database);
    cleanup();
  }
});

test("drops concepts without evidence and stores occurrences with links", () => {
  const { path, cleanup } = temporaryDatabase();
  const database = openKnowledgeDatabase(path);
  const repository = new KnowledgeRepository(database);
  try {
    selectDatabase(repository);
    repository.replaceSourceContent(source(), chunkSourceBlocks(blocks), 0, "hash-1");
    const chunkId = repository.listChunksForSource("page-1")[0].id;

    repository.upsertConcept({
      id: "concept:reinforcement-learning",
      label: "Reinforcement Learning",
      normalized: "reinforcement learning",
      aliases: ["RL"],
      description: "Lernen aus Belohnung.",
      category: "Machine Learning",
      importance: 0.9,
    });
    repository.upsertConcept({
      id: "concept:5-uebung",
      label: "5. Übung",
      normalized: "5 uebung",
      aliases: [],
      description: "",
      category: "Allgemein",
      importance: 0.2,
    });
    repository.addOccurrences([{
      conceptId: "concept:reinforcement-learning",
      chunkId,
      sourceId: "page-1",
      snippet: "Ein Agent lernt aus Belohnung.",
      confidence: 0.9,
    }]);

    assert.equal(repository.deleteConceptsWithoutEvidence(), 1);
    const concepts = repository.listConcepts();
    assert.deepEqual(concepts.map((concept) => concept.label), ["Reinforcement Learning"]);
    assert.equal(concepts[0].sourceCount, 1);
    assert.deepEqual(concepts[0].aliases, ["RL"]);

    const occurrences = repository.listOccurrences("concept:reinforcement-learning");
    assert.equal(occurrences.length, 1);
    assert.equal(occurrences[0].rootTitle, "Courses");
    assert.match(occurrences[0].notionUrl, /^https:\/\/notion\.so\/page-1#/);
    assert.deepEqual([...(repository.conceptRootIds().get("concept:reinforcement-learning") ?? [])], ["root-courses"]);
  } finally {
    closeKnowledgeDatabase(database);
    cleanup();
  }
});

test("removes content of roots that are no longer selected", () => {
  const { path, cleanup } = temporaryDatabase();
  const database = openKnowledgeDatabase(path);
  const repository = new KnowledgeRepository(database);
  try {
    selectDatabase(repository);
    repository.replaceSelectedRoots([
      { id: "root-courses", type: "page", title: "Courses", parentTitle: null, url: null, lastEditedTime: null },
      { id: "root-private", type: "page", title: "Privat", parentTitle: null, url: null, lastEditedTime: null },
    ]);
    repository.replaceSourceContent(source(), chunkSourceBlocks(blocks), 0, "hash-1");
    repository.replaceSourceContent(
      source({ id: "page-2", rootId: "root-private", rootTitle: "Privat", title: "Rezepte" }),
      chunkSourceBlocks([{ blockId: "b9", headingPath: ["Privat"], text: "Vegetarische Rezepte." }]),
      0,
      "hash-9",
    );

    repository.replaceSelectedRoots([
      { id: "root-courses", type: "page", title: "Courses", parentTitle: null, url: null, lastEditedTime: null },
    ]);
    assert.equal(repository.deleteSourcesOutsideRoots(["root-courses"]), 1);

    assert.deepEqual(repository.listSources().map((entry) => entry.id), ["page-1"]);
    assert.deepEqual(repository.selectedRootIds(), ["root-courses"]);
  } finally {
    closeKnowledgeDatabase(database);
    cleanup();
  }
});

test("stores float32 embeddings and reads them back unchanged", () => {
  const { path, cleanup } = temporaryDatabase();
  const database = openKnowledgeDatabase(path);
  const repository = new KnowledgeRepository(database);
  try {
    const vector = Float32Array.from([0.25, -0.5, 0.75]);
    repository.saveEmbedding("concept", "concept:policy", "embeddinggemma", vector);

    const stored = repository.listEmbeddings("concept", "embeddinggemma").get("concept:policy");
    assert.deepEqual([...(stored ?? [])], [0.25, -0.5, 0.75]);
    assert.equal(repository.embeddingDimension("embeddinggemma"), 3);
    assert.deepEqual(repository.ownersWithoutEmbedding("concept", ["concept:policy", "concept:reward"], "embeddinggemma"), ["concept:reward"]);
    assert.equal(blobToVector(undefined).length, 0);
  } finally {
    closeKnowledgeDatabase(database);
    cleanup();
  }
});

test("tracks sync runs, graph versions and interrupted restarts", () => {
  const { path, cleanup } = temporaryDatabase();
  const database = openKnowledgeDatabase(path);
  const repository = new KnowledgeRepository(database);
  try {
    const runId = repository.startSyncRun(12);
    repository.updateSyncRun(runId, { phase: "indexing", processedSources: 5 });
    assert.equal(repository.latestSyncRun()?.processedSources, 5);

    repository.markRunningSyncsInterrupted();
    assert.equal(repository.latestSyncRun()?.status, "interrupted");

    const nextRun = repository.startSyncRun(3);
    repository.finishSyncRun(nextRun, "done");
    assert.equal(repository.latestSyncRun()?.status, "done");
    assert.ok(repository.lastSuccessfulSyncAt());
    assert.equal(repository.bumpGraphVersion(), repository.graphVersion());
  } finally {
    closeKnowledgeDatabase(database);
    cleanup();
  }
});

test("clears the whole index but keeps the selected roots", () => {
  const { path, cleanup } = temporaryDatabase();
  const database = openKnowledgeDatabase(path);
  const repository = new KnowledgeRepository(database);
  try {
    selectDatabase(repository);
    repository.replaceSelectedRoots([
      { id: "root-courses", type: "page", title: "Courses", parentTitle: null, url: null, lastEditedTime: null },
    ]);
    repository.replaceSourceContent(source(), chunkSourceBlocks(blocks), 0, "hash-1");
    const before = repository.graphVersion();

    repository.clearIndex();

    assert.equal(repository.countChunks(), 0);
    assert.equal(repository.listSources().length, 0);
    assert.deepEqual(repository.selectedRootIds(), ["root-courses"]);
    assert.ok(repository.graphVersion() > before);
  } finally {
    closeKnowledgeDatabase(database);
    cleanup();
  }
});

test("upgrades a version 1 index to version 2 without losing data", () => {
  const { path, cleanup } = temporaryDatabase();
  try {
    // Build an index that only knows the first migration.
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const statement of MIGRATIONS[0].statements) legacy.exec(statement);
    legacy.prepare("INSERT INTO schema_version (version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
    legacy.prepare(
      `INSERT INTO notion_sources (id, object_type, title, root_id, root_title, parent_path, url, status)
       VALUES ('page-1', 'page', '5. Übung', 'root-courses', 'Courses', '', 'https://notion.so/page-1', 'indexed')`,
    ).run();
    legacy.prepare(
      "INSERT INTO content_chunks (id, source_id, block_id, heading_path, text, position, hash) VALUES ('page-1:0', 'page-1', 'b1', 'AI', 'Policy und Reward.', 0, 'h')",
    ).run();
    legacy.prepare(
      `INSERT INTO selected_roots (id, type, title, selected, needs_reindex, updated_at)
       VALUES ('root-courses', 'page', 'Courses', 1, 1, ?)`,
    ).run(new Date().toISOString());
    legacy.close();

    const upgraded = openKnowledgeDatabase(path);
    const repository = new KnowledgeRepository(upgraded);
    const versions = (upgraded.prepare("SELECT version FROM schema_version ORDER BY version").all() as Array<{ version: number }>)
      .map((row) => Number(row.version));

    assert.deepEqual(versions, MIGRATIONS.map((migration) => migration.version));
    assert.equal(repository.countChunks(), 1);
    assert.deepEqual(repository.listSources().map((source) => source.id), ["page-1"]);
    assert.deepEqual(repository.selectedRootIds(), ["root-courses"]);
    assert.deepEqual(repository.listAreas(), []);
    assert.equal(repository.getCheckpoint("page-1"), null);
    closeKnowledgeDatabase(upgraded);
  } finally {
    cleanup();
  }
});

test("stores canonical areas, keeps the selection disjoint and versions it", () => {
  const { path, cleanup } = temporaryDatabase();
  const database = openKnowledgeDatabase(path);
  const repository = new KnowledgeRepository(database);
  try {
    repository.replaceAreas([
      {
        id: "knowledge",
        title: "Knowledge",
        originalTitle: "Knowledge",
        scopeIds: ["knowledge", "db-1", "course-ai"],
        contentCount: 42,
        sampleTitles: ["Explainable AI"],
        recommended: true,
        labelSource: "notion",
      },
      {
        id: "untitled",
        title: "Weitere Wissensinhalte",
        originalTitle: "Ohne Titel",
        scopeIds: ["untitled"],
        contentCount: 4,
        sampleTitles: ["CONFIDENCE is a cult", "Zweite Notiz"],
        recommended: false,
        labelSource: "fallback",
      },
    ]);

    assert.equal(repository.setSelectedAreas(["knowledge"]), 1);
    assert.deepEqual(repository.selectedAreaIds(), ["knowledge"]);
    assert.equal(repository.selectionVersion(), 1);
    assert.equal(repository.coverage().selectedRoots, 0);

    // A second save replaces the selection instead of adding to it.
    assert.equal(repository.setSelectedAreas(["untitled"]), 2);
    assert.deepEqual(repository.selectedAreaIds(), ["untitled"]);

    // Unclear areas are the only ones that get a locally generated name.
    assert.deepEqual(repository.areasWithoutName().map((area) => area.id), ["untitled"]);
    repository.saveAreaAiTitle("untitled", "Persönliche Notizen");
    const named = repository.listAreas().find((area) => area.id === "untitled");
    assert.equal(named?.title, "Persönliche Notizen");
    assert.equal(named?.labelSource, "local_ai");
    assert.equal(named?.originalTitle, "Ohne Titel");
    assert.deepEqual(repository.areasWithoutName(), []);

    // Refreshing the areas keeps both the selection and the cached name.
    repository.replaceAreas([
      {
        id: "untitled",
        title: "Weitere Wissensinhalte",
        originalTitle: "Ohne Titel",
        scopeIds: ["untitled"],
        contentCount: 6,
        sampleTitles: ["CONFIDENCE is a cult"],
        recommended: false,
        labelSource: "fallback",
      },
    ]);
    const refreshed = repository.listAreas();
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0].title, "Persönliche Notizen");
    assert.equal(refreshed[0].selected, true);
    assert.equal(refreshed[0].contentCount, 6);
  } finally {
    closeKnowledgeDatabase(database);
    cleanup();
  }
});

test("keeps unrelated sources when a run only removes what it no longer found", () => {
  const { path, cleanup } = temporaryDatabase();
  const database = openKnowledgeDatabase(path);
  const repository = new KnowledgeRepository(database);
  try {
    selectDatabase(repository);
    repository.replaceSourceContent(source(), chunkSourceBlocks(blocks), 0, "hash-1");
    repository.replaceSourceContent(
      source({ id: "page-2", title: "Klausur" }),
      chunkSourceBlocks([{ blockId: "b9", headingPath: ["AI"], text: "Reward und Policy." }]),
      0,
      "hash-9",
    );

    assert.equal(repository.deleteSourcesExcept(["page-1", "page-2"]), 0);
    assert.equal(repository.deleteSourcesExcept(["page-1"]), 1);
    assert.deepEqual(repository.listSources().map((entry) => entry.id), ["page-1"]);
  } finally {
    closeKnowledgeDatabase(database);
    cleanup();
  }
});

test("tracks extraction checkpoints per source", () => {
  const { path, cleanup } = temporaryDatabase();
  const database = openKnowledgeDatabase(path);
  const repository = new KnowledgeRepository(database);
  try {
    selectDatabase(repository);
    repository.replaceSourceContent(source(), chunkSourceBlocks(blocks), 0, "hash-1");
    repository.saveCheckpoint("page-1", 8, 19, [3]);

    const checkpoint = repository.getCheckpoint("page-1");
    assert.equal(checkpoint?.completedBatches, 8);
    assert.equal(checkpoint?.totalBatches, 19);
    assert.deepEqual(checkpoint?.failedBatches, [3]);

    repository.clearCheckpoint("page-1");
    assert.equal(repository.getCheckpoint("page-1"), null);
  } finally {
    closeKnowledgeDatabase(database);
    cleanup();
  }
});
