import { TECH_VOCABULARY_CATALOG } from "./catalog";
import type { DailyTechVocabulary } from "./types";

const TERMS_PER_DAY = 5;
const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(2026, 0, 1);

function parseDate(date: string) {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  const normalized = Number.isNaN(timestamp) ? "" : new Date(timestamp).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || normalized !== date) {
    throw new Error("Ungültiges Glossar-Datum.");
  }
  return timestamp;
}

export function buildDailyTechVocabulary(date: string): DailyTechVocabulary {
  const dayIndex = Math.max(0, Math.floor((parseDate(date) - EPOCH) / DAY_MS));
  const offset = (dayIndex * TERMS_PER_DAY) % TECH_VOCABULARY_CATALOG.length;
  const terms = Array.from({ length: TERMS_PER_DAY }, (_, index) => (
    TECH_VOCABULARY_CATALOG[(offset + index) % TECH_VOCABULARY_CATALOG.length]
  ));

  return {
    date,
    terms,
    featuredTermIds: terms.slice(0, 2).map((entry) => entry.id),
  };
}
