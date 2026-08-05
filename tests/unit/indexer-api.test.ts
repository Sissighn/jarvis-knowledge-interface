import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleKnowledgeRequest, isKnowledgeRequest } from "../../desktop/indexer/api";
import { KnowledgeService } from "../../desktop/indexer/service";
import type { KnowledgeGraph, KnowledgeSearchResponse, KnowledgeStatus } from "../../features/knowledge/types";

function request(path: string, init?: RequestInit) {
  return new Request(`http://127.0.0.1:4318${path}`, init);
}

function withService<T>(work: (service: KnowledgeService) => Promise<T>) {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-api-"));
  const service = new KnowledgeService(join(directory, "knowledge-index.sqlite3"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unreachable", { status: 503 })) as typeof fetch;
  return work(service).finally(() => {
    globalThis.fetch = originalFetch;
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
}

test("routes only the knowledge namespace", () => {
  assert.ok(isKnowledgeRequest("/api/knowledge/status"));
  assert.ok(isKnowledgeRequest("/api/knowledge"));
  assert.equal(isKnowledgeRequest("/api/notion/status"), false);
  assert.equal(isKnowledgeRequest("/api/knowledgebase"), false);
});

test("answers the status contract without a configured Notion token", async () => {
  await withService(async (service) => {
    const previousToken = process.env.NOTION_ACCESS_TOKEN;
    delete process.env.NOTION_ACCESS_TOKEN;
    try {
      const response = await handleKnowledgeRequest(request("/api/knowledge/status"), service);
      const payload = await response.json() as KnowledgeStatus;

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(payload.available, true);
      assert.deepEqual(payload.notion, { configured: false, connected: false });
      assert.equal(payload.models.connected, false);
      assert.equal(payload.sync.phase, "idle");
      assert.equal(payload.graphVersion, 0);
      assert.deepEqual(payload.coverage, {
        selectedRoots: 0,
        selectedDatabases: 0,
        foundSources: 0,
        indexedSources: 0,
        chunks: 0,
        concepts: 0,
        relations: 0,
        failedSources: 0,
        unsupportedBlocks: 0,
      });
      assert.ok(payload.databasePath.endsWith("knowledge-index.sqlite3"));
    } finally {
      if (previousToken !== undefined) process.env.NOTION_ACCESS_TOKEN = previousToken;
    }
  });
});

test("returns an empty concept graph before the first sync", async () => {
  await withService(async (service) => {
    const response = await handleKnowledgeRequest(request("/api/knowledge/graph"), service);
    const graph = await response.json() as KnowledgeGraph;

    assert.equal(response.status, 200);
    assert.deepEqual(graph.nodes.map((node) => node.kind), ["system"]);
    assert.deepEqual(graph.edges, []);
    assert.deepEqual(graph.categories, []);
    assert.equal(graph.syncedAt, null);
  });
});

test("stores a concrete database selection and reports it back", async () => {
  await withService(async (service) => {
    service.repository.replaceDatabases([
      {
        id: "database-knowledge",
        dataSourceIds: ["data-source-1"],
        title: "Knowledge",
        originalTitle: "Knowledge",
        icon: "🧠",
        parentId: "page-knowledge",
        parentTitle: "Second Brain",
        url: "https://notion.so/database-knowledge",
        contentCount: 42,
        selected: false,
        lastSeenAt: new Date().toISOString(),
      },
      {
        id: "database-private",
        dataSourceIds: ["data-source-2"],
        title: "Privat",
        originalTitle: "Privat",
        icon: null,
        parentId: null,
        parentTitle: null,
        url: null,
        contentCount: 3,
        selected: false,
        lastSeenAt: new Date().toISOString(),
      },
    ]);

    const saved = await handleKnowledgeRequest(request("/api/knowledge/databases", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedDatabaseIds: ["database-knowledge", "unknown-database"] }),
    }), service);
    const savedPayload = await saved.json() as {
      databases: Array<{ id: string; selected: boolean }>;
      selectionVersion: number;
      sync: { scheduled: boolean };
    };

    assert.equal(saved.status, 200);
    assert.equal(savedPayload.selectionVersion, 1);
    assert.deepEqual(savedPayload.databases.filter((database) => database.selected).map((database) => database.id), ["database-knowledge"]);

    const listed = await handleKnowledgeRequest(request("/api/knowledge/databases"), service);
    const listedPayload = await listed.json() as { databases: Array<{ id: string; contentCount: number }> };
    assert.deepEqual(listedPayload.databases.map((database) => database.id), ["database-knowledge", "database-private"]);
    assert.equal(listedPayload.databases[0].contentCount, 42);
  });
});

test("rejects an empty or oversized search query", async () => {
  await withService(async (service) => {
    for (const body of [{ query: "" }, { query: "x".repeat(501) }]) {
      const response = await handleKnowledgeRequest(request("/api/knowledge/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }), service);

      assert.equal(response.status, 400);
      assert.equal((await response.json() as { code: string }).code, "invalid_query");
    }
  });
});

test("returns no chunks when the index is still empty", async () => {
  await withService(async (service) => {
    const response = await handleKnowledgeRequest(request("/api/knowledge/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "Was ist Reinforcement Learning?" }),
    }), service);
    const payload = await response.json() as KnowledgeSearchResponse;

    assert.equal(response.status, 200);
    assert.deepEqual(payload.chunks, []);
    assert.deepEqual(payload.conceptIds, []);
  });
});

test("refuses to sync without a local Notion token", async () => {
  await withService(async (service) => {
    const previousToken = process.env.NOTION_ACCESS_TOKEN;
    delete process.env.NOTION_ACCESS_TOKEN;
    try {
      const response = await handleKnowledgeRequest(request("/api/knowledge/sync", { method: "POST" }), service);

      assert.equal(response.status, 503);
      assert.equal((await response.json() as { code: string }).code, "not_configured");
    } finally {
      if (previousToken !== undefined) process.env.NOTION_ACCESS_TOKEN = previousToken;
    }
  });
});

test("reports unknown concepts and endpoints instead of guessing", async () => {
  await withService(async (service) => {
    const concept = await handleKnowledgeRequest(request("/api/knowledge/concepts/concept:unknown"), service);
    const unknown = await handleKnowledgeRequest(request("/api/knowledge/does-not-exist"), service);

    assert.equal(concept.status, 404);
    assert.equal(unknown.status, 404);
  });
});

test("clears the index on request", async () => {
  await withService(async (service) => {
    const response = await handleKnowledgeRequest(request("/api/knowledge/reset", { method: "POST" }), service);
    const payload = await response.json() as { reset: boolean; coverage: { concepts: number } };

    assert.equal(response.status, 200);
    assert.equal(payload.reset, true);
    assert.equal(payload.coverage.concepts, 0);
  });
});
