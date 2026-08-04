import assert from "node:assert/strict";
import test from "node:test";
import {
  searchKnowledge,
  selectRelevantPassages,
  type SearchableKnowledgeNode,
} from "../../features/knowledge/search";

const nodes: SearchableKnowledgeNode[] = [
  {
    id: "system",
    label: "Notion",
    group: "System",
    kind: "system",
  },
  {
    id: "ml",
    label: "Machine Learning Prüfung",
    group: "Universität",
    kind: "page",
    content: "Zusammenfassung zu neuronalen Netzen, Optimierung und Backpropagation.",
    keywords: ["machine", "learning", "neuronale"],
  },
  {
    id: "recipes",
    label: "Rezepte",
    group: "Privat",
    kind: "page",
    content: "Schnelle vegetarische Gerichte für die Woche.",
  },
];

test("ranks the most relevant knowledge node first", () => {
  const results = searchKnowledge(nodes, "neuronale Netze Prüfung");

  assert.equal(results[0]?.nodeId, "ml");
  assert.ok((results[0]?.score ?? 0) > 0);
  assert.deepEqual(results[0]?.matchedTerms.sort(), ["netze", "neuronale", "prüfung"]);
});

test("ignores system nodes and empty queries", () => {
  assert.deepEqual(searchKnowledge(nodes, "Notion"), []);
  assert.deepEqual(searchKnowledge(nodes, "   "), []);
});

test("caps the result count at five", () => {
  const manyNodes = Array.from({ length: 8 }, (_, index): SearchableKnowledgeNode => ({
    id: `node-${index}`,
    label: `Coding Notiz ${index}`,
    group: "Projekte",
    kind: "page",
    content: "Coding TypeScript React",
  }));

  assert.equal(searchKnowledge(manyNodes, "Coding", 20).length, 5);
});

test("uses recent questions to resolve a short follow-up", () => {
  const results = searchKnowledge(nodes, "Wie funktioniert das genau?", 5, {
    previousQueries: ["Erkläre mir neuronale Netze für die Prüfung"],
    preferredNodeIds: ["ml"],
  });

  assert.equal(results[0]?.nodeId, "ml");
  assert.ok(results[0]?.matchedTerms.includes("neuronale"));
});

test("selects focused passages instead of sending the start of a long page", () => {
  const content = `${"Allgemeine organisatorische Hinweise ohne Fachinhalt. ".repeat(70)}\n\nBackpropagation berechnet den Gradienten des Fehlers vom Ausgang zum Eingang.`;
  const passage = selectRelevantPassages(content, "Wie funktioniert Backpropagation?", [], 420);

  assert.match(passage, /berechnet den Gradienten/);
  assert.ok(passage.length <= 420);
});
