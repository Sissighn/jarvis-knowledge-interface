import assert from "node:assert/strict";
import test from "node:test";
import { buildDailyTechVocabulary } from "../../features/glossary/daily";

test("returns five complete and unique vocabulary terms per day", () => {
  const vocabulary = buildDailyTechVocabulary("2026-08-03");
  assert.equal(vocabulary.terms.length, 5);
  assert.equal(new Set(vocabulary.terms.map((term) => term.id)).size, 5);
  assert.equal(vocabulary.featuredTermIds.length, 2);
  for (const term of vocabulary.terms) {
    assert.ok(term.term);
    assert.ok(term.category);
    assert.ok(term.definition);
    assert.ok(term.purpose);
    assert.ok(term.professionalExample);
    assert.ok(term.everydayExample);
    assert.ok(term.conversationSentence);
    assert.ok(term.keyTakeaway);
  }
});

test("rotates to a different batch on the following day", () => {
  const today = buildDailyTechVocabulary("2026-08-03");
  const tomorrow = buildDailyTechVocabulary("2026-08-04");
  const todayIds = new Set(today.terms.map((term) => term.id));
  assert.equal(tomorrow.terms.some((term) => todayIds.has(term.id)), false);
});

test("rejects malformed dates", () => {
  assert.throws(() => buildDailyTechVocabulary("03.08.2026"), /Ungültiges Glossar-Datum/);
  assert.throws(() => buildDailyTechVocabulary("2026-02-31"), /Ungültiges Glossar-Datum/);
});
