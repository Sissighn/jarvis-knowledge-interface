import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSnippet,
  isFollowUpQuery,
  matchingTerms,
  reciprocalRankFusion,
  retrievalTerms,
  selectRelevantPassages,
  toFtsQuery,
  tokenizeKnowledgeText,
} from "../../features/knowledge/search";

test("tokenises German technical text without stop words", () => {
  const terms = tokenizeKnowledgeText("Was ist die Policy im Reinforcement Learning?");

  assert.deepEqual(terms, ["policy", "reinforcement", "learning"]);
});

test("expands short follow-up questions with previous queries", () => {
  const { queryTerms, historyTerms } = retrievalTerms("Und dazu?", {
    previousQueries: ["Was ist Reinforcement Learning?"],
  });

  assert.ok(isFollowUpQuery("Und dazu?"));
  assert.deepEqual(queryTerms, ["dazu"]);
  assert.deepEqual(historyTerms, ["reinforcement", "learning"]);
});

test("keeps a full question independent from the history", () => {
  const { historyTerms } = retrievalTerms("Wie unterscheidet sich Supervised Learning von Reinforcement Learning?", {
    previousQueries: ["Rezepte für die Woche"],
  });

  assert.deepEqual(historyTerms, []);
});

test("quotes FTS terms instead of interpolating query syntax", () => {
  const expression = toFtsQuery(["policy", "reward*", "rein\"forcement"]);

  assert.equal(expression, '"policy"* OR "reward*"* OR "reinforcement"*');
});

test("fuses lexical and semantic rankings with reciprocal rank fusion", () => {
  const fused = reciprocalRankFusion([
    ["c1", "c2", "c3"],
    ["c3", "c1", "c9"],
  ]);

  assert.equal(fused[0].id, "c1");
  assert.deepEqual(fused.map((entry) => entry.id).slice(0, 3), ["c1", "c3", "c2"]);
  assert.ok(fused.every((entry) => entry.score > 0));
});

test("builds a snippet around the matched term", () => {
  const content = `${"Vorlauf ".repeat(40)}Die Policy bildet Zustände auf Aktionen ab. ${"Nachlauf ".repeat(40)}`;
  const snippet = buildSnippet(content, ["policy"]);

  assert.ok(snippet.toLocaleLowerCase("de-DE").includes("policy"));
  assert.ok(snippet.length <= 236);
});

test("selects the most relevant passages of a long chunk", () => {
  const content = [
    "Ein Kapitel über Kochrezepte und Einkaufslisten. ".repeat(12),
    "Reinforcement Learning optimiert eine Policy anhand von Belohnung.",
    "Weitere unwichtige Randnotizen ohne Bezug. ".repeat(12),
  ].join("\n\n");

  const passages = selectRelevantPassages(content, "Wie optimiert Reinforcement Learning die Policy?", [], 400);

  assert.ok(passages.includes("Reinforcement Learning optimiert eine Policy"));
  assert.ok(passages.length <= 400);
});

test("matches related word forms", () => {
  assert.deepEqual(matchingTerms(["learning"], ["learnings", "policy"]), ["learning"]);
  assert.deepEqual(matchingTerms(["policy"], ["reward"]), []);
});
