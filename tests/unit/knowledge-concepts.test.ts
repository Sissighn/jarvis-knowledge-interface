import assert from "node:assert/strict";
import test from "node:test";
import {
  conceptId,
  isNavigationTitle,
  isUsableConceptName,
  mergeConceptCandidates,
  normalizeConceptName,
  pageTitleHasContentEvidence,
  type ConceptCandidate,
} from "../../features/knowledge/concepts";

test("folds unicode, case, hyphen and spacing variants into one name", () => {
  const variants = ["Reinforcement Learning", "reinforcement-learning", "Reinforcement  Learning", "REINFORCEMENT LEARNING"];
  const normalized = new Set(variants.map(normalizeConceptName));

  assert.equal(normalized.size, 1);
  assert.equal([...normalized][0], "reinforcement learning");
});

test("rejects navigation and page titles as concepts", () => {
  for (const title of [
    "5. Übung",
    "Übung 5",
    "Lecture 2",
    "Vorlesung 7",
    "Zusammenfassung",
    "Ohne Titel",
    "Untitled",
    "12",
    "3.2",
    "Woche 4",
    "Kapitel 1",
    "Homework 3",
    "Übungsblatt 5",
  ]) {
    assert.ok(isNavigationTitle(title), `${title} should be navigation`);
    assert.equal(isUsableConceptName(title), false, `${title} should not be a concept`);
  }
});

test("keeps real technical terms usable", () => {
  for (const term of ["Reinforcement Learning", "Policy", "Reward", "Transformer", "Attention", "MDP", "Q-Learning"]) {
    assert.ok(isUsableConceptName(term), `${term} should be usable`);
  }
});

test("merges spelling variants and explicitly evidenced aliases", () => {
  const candidates: ConceptCandidate[] = [
    { name: "Reinforcement Learning", aliases: ["RL"], description: "Lernen aus Belohnung.", category: "Machine Learning", importance: 0.9, chunkId: "a:0" },
    { name: "reinforcement-learning", description: "Kurz.", category: "Machine Learning", importance: 0.7, chunkId: "a:1" },
    { name: "RL", description: "Abkürzung im Text.", category: "Machine Learning", importance: 0.6, chunkId: "a:2" },
    { name: "Policy", description: "Zustand auf Aktion.", category: "Machine Learning", importance: 0.8, chunkId: "a:1" },
  ];

  const merged = mergeConceptCandidates(candidates);
  const rl = merged.find((concept) => concept.normalized === "reinforcement learning");

  assert.equal(merged.length, 2);
  assert.ok(rl);
  assert.equal(rl.label, "Reinforcement Learning");
  assert.equal(rl.id, conceptId("reinforcement learning"));
  assert.deepEqual(rl.occurrences.map((occurrence) => occurrence.chunkId), ["a:0", "a:1", "a:2"]);
  assert.ok(rl.aliases.includes("RL"));
  assert.equal(rl.description, "Lernen aus Belohnung.");
});

test("does not merge unrelated abbreviations without evidence", () => {
  const merged = mergeConceptCandidates([
    { name: "Markov Decision Process", chunkId: "a:0" },
    { name: "MDP", chunkId: "b:0" },
  ]);

  assert.equal(merged.length, 2);
});

test("drops candidates without any chunk evidence and navigation names", () => {
  const merged = mergeConceptCandidates([
    { name: "5. Übung", chunkId: "a:0" },
    { name: "Lecture 2", chunkId: "a:1" },
    { name: "Transformer", chunkId: "a:2" },
  ]);

  assert.deepEqual(merged.map((concept) => concept.label), ["Transformer"]);
});

test("accepts a page title only with real content evidence", () => {
  assert.equal(pageTitleHasContentEvidence("5. Übung", ["Reinforcement Learning wird geübt."]), false);
  assert.equal(
    pageTitleHasContentEvidence("Reinforcement Learning", ["In dieser Einheit geht es um Reinforcement Learning."]),
    true,
  );
});
