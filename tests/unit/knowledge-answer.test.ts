import assert from "node:assert/strict";
import test from "node:test";
import { answerFromChunks } from "../../features/knowledge/answer";
import type { RetrievedChunk } from "../../features/knowledge/types";

function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunkId: "ai-methods:2",
    sourceId: "ai-methods",
    sourceTitle: "5. Übung",
    rootTitle: "Courses",
    headingPath: "AI Methods / Reinforcement Learning",
    text: "Reinforcement Learning optimiert eine Policy anhand von Belohnung aus der Umgebung. "
      + "Supervised Learning benötigt dagegen gelabelte Daten.",
    snippet: "Reinforcement Learning optimiert eine Policy anhand von Belohnung.",
    notionUrl: "https://notion.so/ai-methods#block",
    blockId: "block-1",
    score: 0.92,
    matchedTerms: ["reinforcement", "learning", "policy"],
    ...overrides,
  };
}

test("answers from indexed chunks and keeps every citation traceable", () => {
  const answer = answerFromChunks("Wie optimiert Reinforcement Learning die Policy?", [chunk()], ["concept:policy"]);

  assert.equal(answer.status, "answered");
  assert.equal(answer.sources.length, 1);
  assert.equal(answer.sources[0].chunkId, "ai-methods:2");
  assert.equal(answer.sources[0].headingPath, "AI Methods / Reinforcement Learning");
  assert.equal(answer.sources[0].notionUrl, "https://notion.so/ai-methods#block");
  assert.deepEqual(answer.highlightedConceptIds, ["concept:policy"]);
  assert.ok(answer.evidence.length > 0);
  assert.ok(answer.evidence.every((evidence) => evidence.chunkId === "ai-methods:2"));
});

test("reports missing evidence instead of inventing an answer", () => {
  const answer = answerFromChunks("Was ist Quantenverschränkung?", []);

  assert.equal(answer.status, "not_found");
  assert.equal(answer.sources.length, 0);
  assert.equal(answer.confidence, 0);
  assert.match(answer.summary, /keine ausreichend passende Fundstelle/);
});

test("stays uncertain when the retrieved text does not match the question", () => {
  const answer = answerFromChunks("Wie plane ich meinen Umzug?", [chunk({
    score: 0.2,
    matchedTerms: [],
    text: "Kurz.",
    snippet: "Kurz.",
  })]);

  assert.equal(answer.status, "uncertain");
  assert.equal(answer.evidence.length, 0);
  assert.ok(answer.sources.length > 0);
  assert.match(answer.caveat, /statt aus Seitentiteln/);
});

test("counts distinct sources for the summary", () => {
  const answer = answerFromChunks("Was ist Reinforcement Learning?", [
    chunk(),
    chunk({ chunkId: "exam:1", sourceId: "exam", sourceTitle: "Klausurvorbereitung" }),
  ]);

  assert.match(answer.summary, /Aus 2 Quellen/);
});
