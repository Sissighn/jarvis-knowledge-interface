import assert from "node:assert/strict";
import test from "node:test";
import { blockText, childHeadingPath, isUnsupportedBlock, nextHeadingPath } from "../../desktop/indexer/notion/blocks";
import {
  MAX_BLOCKS_PER_PAGE,
  entryTitle,
  parentReference,
  resolveRoot,
  toEntry,
  traverseBlocks,
  type NotionEntry,
} from "../../desktop/indexer/notion/crawl";
import { NotionClient } from "../../desktop/indexer/notion/client";

type Block = { id: string; type: string; has_children?: boolean } & Record<string, unknown>;

function paragraph(id: string, content: string, hasChildren = false): Block {
  return { id, type: "paragraph", has_children: hasChildren, paragraph: { rich_text: [{ plain_text: content }] } };
}

function toggle(id: string, summary: string): Block {
  return { id, type: "toggle", has_children: true, toggle: { rich_text: [{ plain_text: summary }] } };
}

test("reads plain text out of every supported block type", () => {
  assert.equal(blockText(paragraph("p", "Policy und Reward")), "Policy und Reward");
  assert.equal(
    blockText({ id: "t", type: "table_row", table_row: { cells: [[{ plain_text: "RL" }], [{ plain_text: "Policy" }]] } }),
    "RL | Policy",
  );
  assert.equal(
    blockText({ id: "c", type: "code", code: { language: "python", rich_text: [{ plain_text: "q = 0" }] } }),
    "python: q = 0",
  );
  assert.equal(blockText({ id: "d", type: "divider", divider: {} }), "");
  assert.ok(isUnsupportedBlock({ id: "i", type: "image" }));
});

test("keeps heading and toggle paths", () => {
  const heading = { id: "h", type: "heading_2", heading_2: { rich_text: [{ plain_text: "Reinforcement Learning" }] } };
  const path = nextHeadingPath(heading, ["AI Methods"]);

  assert.deepEqual(path, ["AI Methods", "Reinforcement Learning"]);
  assert.deepEqual(childHeadingPath(toggle("t", "RL vs. Supervised Learning"), path), [
    "AI Methods",
    "Reinforcement Learning",
    "RL vs. Supervised Learning",
  ]);
});

test("collects deeply nested toggle content and separates child pages", async () => {
  const children: Record<string, Block[]> = {
    page: [
      { id: "h1", type: "heading_1", heading_1: { rich_text: [{ plain_text: "AI Methods" }] } },
      toggle("t1", "Reinforcement Learning"),
      { id: "sub", type: "child_page", child_page: { title: "5. Übung" } },
      { id: "img", type: "image", image: {} },
    ],
    t1: [paragraph("p1", "Ein Agent lernt aus Belohnung."), toggle("t2", "Policy")],
    t2: [paragraph("p2", "Die Policy bildet Zustände auf Aktionen ab."), toggle("t3", "Reward")],
    t3: [paragraph("p3", "Reward ist das Feedbacksignal der Umgebung.")],
  };

  const content = await traverseBlocks("page", async (blockId) => children[blockId] ?? []);
  const texts = content.blocks.map((block) => block.text);

  assert.ok(texts.includes("Reward ist das Feedbacksignal der Umgebung."));
  assert.deepEqual(
    content.blocks.find((block) => block.blockId === "p3")?.headingPath,
    ["AI Methods", "Reinforcement Learning", "Policy", "Reward"],
  );
  assert.deepEqual(content.childPageIds, ["sub"]);
  assert.equal(content.unsupportedBlocks, 1);
  assert.equal(content.truncated, false);
});

test("stops at the safety limit instead of crawling forever", async () => {
  const content = await traverseBlocks("page", async () => Array.from({ length: 200 }, (unused, index) => ({
    id: `b${index}`,
    type: "paragraph",
    has_children: true,
    paragraph: { rich_text: [{ plain_text: "Text" }] },
  })));

  assert.ok(content.truncated);
  assert.ok(content.blocks.length <= MAX_BLOCKS_PER_PAGE);
});

test("walks every search page instead of stopping at the first cursor", async () => {
  const pages = 3;
  const requests: string[] = [];
  const client = new NotionClient("secret-test");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { start_cursor?: string };
    requests.push(body.start_cursor ?? "start");
    const index = requests.length;
    return new Response(JSON.stringify({
      results: Array.from({ length: 100 }, (unused, position) => ({
        object: "page",
        id: `page-${index}-${position}`,
        url: "https://notion.so/x",
        properties: { title: { type: "title", title: [{ plain_text: `Seite ${index}-${position}` }] } },
        parent: { type: "workspace", workspace: true },
      })),
      has_more: index < pages,
      next_cursor: index < pages ? `cursor-${index}` : null,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const results = await client.collect<{ id: string }>("/search", {});
    assert.equal(results.length, 300);
    assert.deepEqual(requests, ["start", "cursor-1", "cursor-2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolves the selected root through the parent chain", () => {
  const entries: NotionEntry[] = [
    { id: "root", object: "page", title: "Courses", url: "", lastEditedTime: null, parentId: null, parentType: "workspace" },
    { id: "course", object: "page", title: "AI Methods", url: "", lastEditedTime: null, parentId: "root", parentType: "page_id" },
    { id: "exercise", object: "page", title: "5. Übung", url: "", lastEditedTime: null, parentId: "course", parentType: "page_id" },
    { id: "private", object: "page", title: "Rezepte", url: "", lastEditedTime: null, parentId: null, parentType: "workspace" },
  ];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const selected = new Set(["root"]);

  assert.deepEqual(resolveRoot(byId.get("exercise")!, byId, selected), { rootId: "root", parentPath: ["AI Methods"] });
  assert.deepEqual(resolveRoot(byId.get("course")!, byId, selected), { rootId: "root", parentPath: [] });
  assert.equal(resolveRoot(byId.get("private")!, byId, selected), null);
});

test("maps search results to entries with titles and parents", () => {
  const entry = toEntry({
    object: "page",
    id: "p1",
    url: "https://notion.so/p1",
    last_edited_time: "2026-08-01T10:00:00.000Z",
    parent: { type: "data_source_id", data_source_id: "db1" },
    properties: { Name: { type: "title", title: [{ plain_text: "Transformer" }] } },
  });

  assert.equal(entry?.title, "Transformer");
  assert.equal(entry?.parentId, "db1");
  assert.equal(entryTitle({ object: "page", id: "x" }), "Ohne Titel");
  assert.deepEqual(parentReference({ type: "workspace", workspace: true }), { id: null, type: "workspace" });
});
