import assert from "node:assert/strict";
import test from "node:test";
import {
  CHUNK_MAX_CHARACTERS,
  CHUNK_OVERLAP_CHARACTERS,
  chunkSourceBlocks,
  formatHeadingPath,
  groupIntoSections,
  overlapTail,
  type SourceBlockText,
} from "../../features/knowledge/chunking";

function blocks(): SourceBlockText[] {
  return [
    {
      blockId: "b1",
      headingPath: ["AI Methods", "Reinforcement Learning"],
      text: "Reinforcement Learning lernt aus Belohnung. ".repeat(12),
    },
    {
      blockId: "b2",
      headingPath: ["AI Methods", "Reinforcement Learning"],
      text: "Die Policy bildet Zustände auf Aktionen ab. ".repeat(12),
    },
    {
      blockId: "b3",
      headingPath: ["AI Methods", "Reinforcement Learning", "RL vs. Supervised Learning"],
      text: "Supervised Learning benötigt gelabelte Daten.",
    },
  ];
}

test("keeps the heading path readable", () => {
  assert.equal(
    formatHeadingPath(["AI Methods", " Reinforcement Learning ", "RL vs. Supervised Learning"]),
    "AI Methods / Reinforcement Learning / RL vs. Supervised Learning",
  );
});

test("chunks deterministically and stays inside the size limits", () => {
  const first = chunkSourceBlocks(blocks());
  const second = chunkSourceBlocks(blocks());

  assert.deepEqual(first, second);
  assert.ok(first.length >= 2);
  assert.ok(first.every((chunk) => chunk.text.length <= CHUNK_MAX_CHARACTERS));
  assert.ok(first.every((chunk, index) => chunk.order === index));
  assert.ok(first.every((chunk) => chunk.hash.length === 8));
});

test("never loses block content while chunking", () => {
  const source = blocks();
  const combined = chunkSourceBlocks(source).map((chunk) => chunk.text).join(" ").replace(/\s+/gu, " ");

  for (const block of source) {
    const sentence = block.text.trim().split(". ")[0];
    assert.ok(combined.includes(sentence), `missing content of ${block.blockId}`);
  }
});

test("splits an oversized block with a bounded overlap", () => {
  const long = "Transformer nutzen Self-Attention über Token-Sequenzen. ".repeat(80);
  const chunks = chunkSourceBlocks([{ blockId: "long", headingPath: ["Deep Learning"], text: long }]);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.text.length <= CHUNK_MAX_CHARACTERS));
  assert.ok(overlapTail("a".repeat(400)).length <= CHUNK_OVERLAP_CHARACTERS);
});

test("keeps separate heading paths in separate chunks", () => {
  const chunks = chunkSourceBlocks(blocks());
  const paths = new Set(chunks.map((chunk) => chunk.headingPath));

  assert.ok(paths.has("AI Methods / Reinforcement Learning"));
  assert.ok(paths.has("AI Methods / Reinforcement Learning / RL vs. Supervised Learning"));
});

test("groups consecutive chunks of one heading path into sections", () => {
  const chunks = chunkSourceBlocks(blocks()).map((chunk, index) => ({
    id: `page:${index}`,
    headingPath: chunk.headingPath,
    text: chunk.text,
  }));
  const sections = groupIntoSections(chunks, 6_000);

  assert.ok(sections.length >= 2);
  assert.ok(sections.every((section) => section.chunks.every((chunk) => chunk.headingPath === section.headingPath)));
});
