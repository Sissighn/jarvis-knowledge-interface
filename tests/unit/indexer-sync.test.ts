import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeKnowledgeDatabase, openKnowledgeDatabase } from "../../desktop/indexer/db/database";
import { KnowledgeRepository } from "../../desktop/indexer/db/repository";
import { searchKnowledgeChunks } from "../../desktop/indexer/retrieval";
import { SyncRunner } from "../../desktop/indexer/sync/runner";

const PAGES = [
  { id: "page-1", title: "1. Übung", text: "Reinforcement Learning trainiert einen Agenten mit Reward und einer Policy." },
  { id: "page-2", title: "2. Übung", text: "Supervised Learning nutzt gelabelte Daten. Unsupervised Learning erkennt Cluster ohne Zielwerte." },
  { id: "page-3", title: "Notizen", text: "Eine Markov Decision Process beschreibt Zustände, Aktionen und Übergänge im Reinforcement Learning." },
];

type Counts = { search: number; blocks: number; chat: number; embed: number };

function installStubs(counts: Counts) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.includes("/v1/search")) {
      counts.search += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { filter?: { value?: string } };
      if (body.filter?.value === "data_source") return json({ results: [{ object: "data_source", id: "ds-courses", title: [{ plain_text: "New database" }], parent: { type: "database_id", database_id: "db-courses" }, url: "https://notion.so/db-courses" }], has_more: false, next_cursor: null });
      return json({ results: [{ object: "page", id: "courses-parent", parent: { type: "workspace", workspace: true }, properties: { Name: { type: "title", title: [{ plain_text: "Courses" }] } }, icon: { type: "emoji", emoji: "🎓" } }], has_more: false, next_cursor: null });
    }
    if (url.includes("/v1/databases/db-courses")) return json({ object: "database", id: "db-courses", title: [{ plain_text: "New database" }], parent: { type: "page_id", page_id: "courses-parent" }, url: "https://notion.so/db-courses" });
    if (url.includes("/v1/data_sources/ds-courses/query")) return json({ results: PAGES.map((page) => ({ object: "page", id: page.id, url: `https://notion.so/${page.id}`, last_edited_time: "2026-08-05T08:00:00.000Z", parent: { type: "data_source_id", data_source_id: "ds-courses" }, properties: { Name: { type: "title", title: [{ plain_text: page.title }] } } })), has_more: false, next_cursor: null });
    const match = url.match(/\/v1\/blocks\/([^/]+)\/children/u);
    if (match) {
      counts.blocks += 1;
      const page = PAGES.find((entry) => entry.id === match[1]);
      return json({ results: page ? [{ id: `${page.id}-body`, type: "paragraph", paragraph: { rich_text: [{ plain_text: page.text }] } }] : [], has_more: false, next_cursor: null });
    }
    if (url.includes("/api/tags")) return json({ models: [{ name: "qwen3.5:4b" }] });
    if (url.includes("/api/chat")) { counts.chat += 1; return json({ message: { content: "{}" } }); }
    if (url.includes("/api/embed")) { counts.embed += 1; return json({ embeddings: [] }); }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function selectCourses(repository: KnowledgeRepository) {
  repository.replaceDatabases([{ id: "db-courses", dataSourceIds: ["ds-courses"], title: "Courses", originalTitle: "New database", icon: null, parentId: "courses-parent", parentTitle: "Courses", url: null, contentCount: 0, selected: false, lastSeenAt: new Date().toISOString() }]);
  repository.setSelectedDatabases(["db-courses"]);
}

async function waitForSync(runner: SyncRunner) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (!runner.isRunning()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("sync did not finish");
}

test("indexes selected databases without any background chat-model calls", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-fast-sync-"));
  const counts: Counts = { search: 0, blocks: 0, chat: 0, embed: 0 };
  const restore = installStubs(counts);
  const previousToken = process.env.NOTION_ACCESS_TOKEN;
  process.env.NOTION_ACCESS_TOKEN = "secret-test-token";
  const database = openKnowledgeDatabase(join(directory, "index.sqlite3"));
  const repository = new KnowledgeRepository(database);
  t.after(() => { closeKnowledgeDatabase(database); restore(); if (previousToken === undefined) delete process.env.NOTION_ACCESS_TOKEN; else process.env.NOTION_ACCESS_TOKEN = previousToken; rmSync(directory, { recursive: true, force: true }); });
  selectCourses(repository);

  const runner = new SyncRunner(repository);
  await runner.start("incremental");
  await waitForSync(runner);
  assert.equal(runner.currentProgress().phase, "ready", runner.currentProgress().error ?? "");
  assert.equal(repository.coverage().indexedSources, PAGES.length);
  assert.equal(counts.chat, 0, "indexing must never invoke Qwen");
  assert.equal(counts.embed, 0, "missing optional embedding model must not block indexing");
  const labels = repository.listConcepts().map((concept) => concept.label.toLocaleLowerCase("de-DE"));
  assert.ok(labels.some((label) => label.includes("reinforcement learning")));
  assert.ok(!labels.some((label) => /übung|ohne titel|zusammenfassung/u.test(label)));
  assert.ok(repository.coverage().relations > 0);
});

test("incremental sync does not reread unchanged pages and retrieval stays database-scoped", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-incremental-sync-"));
  const counts: Counts = { search: 0, blocks: 0, chat: 0, embed: 0 };
  const restore = installStubs(counts);
  const previousToken = process.env.NOTION_ACCESS_TOKEN;
  process.env.NOTION_ACCESS_TOKEN = "secret-test-token";
  const database = openKnowledgeDatabase(join(directory, "index.sqlite3"));
  const repository = new KnowledgeRepository(database);
  t.after(() => { closeKnowledgeDatabase(database); restore(); if (previousToken === undefined) delete process.env.NOTION_ACCESS_TOKEN; else process.env.NOTION_ACCESS_TOKEN = previousToken; rmSync(directory, { recursive: true, force: true }); });
  selectCourses(repository);
  const runner = new SyncRunner(repository);
  await runner.start(); await waitForSync(runner);
  const firstBlockReads = counts.blocks;
  await runner.start(); await waitForSync(runner);
  assert.equal(counts.blocks, firstBlockReads);
  const result = await searchKnowledgeChunks(repository, "Reinforcement Learning");
  assert.ok(result.chunks.length > 0);
  repository.setSelectedDatabases([]);
  const hidden = await searchKnowledgeChunks(repository, "Reinforcement Learning");
  assert.equal(hidden.chunks.length, 0);
});
