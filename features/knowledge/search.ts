/** Pure, client-safe retrieval helpers shared by the indexer, the UI and the answer layer. */

export type KnowledgeRetrievalContext = {
  previousQueries?: string[];
  preferredSourceIds?: string[];
};

export type RankedCandidate = { id: string; score: number };

const STOP_WORDS = new Set([
  "aber", "alle", "also", "and", "auch", "auf", "aus", "bei", "bin", "bis", "das", "dass",
  "dein", "deine", "dem", "den", "der", "des", "die", "dies", "diese", "ein", "eine", "einem",
  "einen", "einer", "für", "gibt", "habe", "hat", "ich", "ihre", "im", "in", "ist", "kann",
  "mein", "meine", "mit", "nach", "nicht", "noch", "oder", "sich", "sind", "the", "und", "uns",
  "von", "warum", "was", "welche", "wie", "wir", "with", "you", "your", "zum", "zur", "über",
  "zeige", "zeig", "finde", "wissen", "notiz", "notizen", "notion",
]);

const FOLLOW_UP_PATTERN = /\b(?:das|dazu|davon|dies|diese|weiter|mehr|genau|vorher|funktioniert|beispiel)\b/iu;

export function tokenizeKnowledgeText(value: string) {
  return (value.toLocaleLowerCase("de-DE").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token) && !/^\d+$/.test(token));
}

export function isFollowUpQuery(query: string) {
  return tokenizeKnowledgeText(query).length <= 2 || FOLLOW_UP_PATTERN.test(query);
}

/** Expands short follow-up questions with terms from the previous questions. */
export function retrievalTerms(query: string, context: KnowledgeRetrievalContext = {}) {
  const queryTerms = [...new Set(tokenizeKnowledgeText(query))];
  if (!isFollowUpQuery(query)) return { queryTerms, historyTerms: [] as string[] };
  const historyTerms = [...new Set((context.previousQueries ?? []).slice(-3).flatMap(tokenizeKnowledgeText))]
    .filter((term) => !queryTerms.includes(term))
    .slice(0, 18);
  return { queryTerms, historyTerms };
}

/** Builds a safe FTS5 MATCH expression; user input is quoted, never interpolated as syntax. */
export function toFtsQuery(terms: string[]) {
  const quoted = [...new Set(terms)]
    .map((term) => term.replace(/"/gu, ""))
    .filter((term) => term.length >= 3)
    .slice(0, 24)
    .map((term) => `"${term}"*`);
  return quoted.join(" OR ");
}

function relatedTerm(left: string, right: string) {
  if (left === right) return true;
  if (left.length < 5 || right.length < 5) return false;
  const prefixLength = Math.min(7, left.length - 1, right.length - 1);
  return left.slice(0, prefixLength) === right.slice(0, prefixLength);
}

export function matchingTerms(queryTerms: string[], documentTerms: string[]) {
  return queryTerms.filter((queryTerm) => documentTerms.some((documentTerm) => relatedTerm(queryTerm, documentTerm)));
}

export function buildSnippet(content: string, terms: string[], maxLength = 230) {
  const clean = content.replace(/\s+/gu, " ").trim();
  if (clean.length <= maxLength) return clean;
  const lower = clean.toLocaleLowerCase("de-DE");
  const matchIndex = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, Math.min(matchIndex - 70, clean.length - maxLength));
  const raw = clean.slice(start, start + maxLength);
  const firstSpace = start > 0 ? raw.indexOf(" ") : 0;
  const lastSpace = raw.lastIndexOf(" ");
  const clipped = raw.slice(Math.max(0, firstSpace), lastSpace > 0 ? lastSpace : undefined).trim();
  return `${start > 0 ? "…" : ""}${clipped}${start + maxLength < clean.length ? "…" : ""}`;
}

/**
 * Reciprocal Rank Fusion merges the lexical FTS5 ranking with the embedding ranking
 * without needing comparable score scales.
 */
export function reciprocalRankFusion(rankings: string[][], k = 60): RankedCandidate[] {
  const scores = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
      if (!firstSeen.has(id)) firstSeen.set(id, index);
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score
      || (firstSeen.get(left.id) ?? 0) - (firstSeen.get(right.id) ?? 0)
      || left.id.localeCompare(right.id));
}

function passageParts(content: string) {
  return content
    .replace(/\r/gu, "")
    .split(/\n{2,}|(?<=[.!?])\s+(?=[\p{Lu}\d])/u)
    .map((part) => part.replace(/\s+/gu, " ").trim())
    .filter((part) => part.length >= 18);
}

export function selectRelevantPassages(
  content: string,
  query: string,
  previousQueries: string[] = [],
  maxCharacters = 1_400,
) {
  const clean = content.replace(/\s+/gu, " ").trim();
  if (clean.length <= maxCharacters) return clean;

  const queryTerms = [...new Set(tokenizeKnowledgeText(query))];
  const historyTerms = [...new Set(previousQueries.slice(-3).flatMap(tokenizeKnowledgeText))]
    .filter((term) => !queryTerms.includes(term));
  const parts = passageParts(content);
  if (!parts.length) return clean.slice(0, maxCharacters).trim();

  const ranked = parts.map((text, index) => {
    const terms = tokenizeKnowledgeText(text);
    const currentMatches = matchingTerms(queryTerms, terms).length;
    const historyMatches = matchingTerms(historyTerms, terms).length;
    return { index, text, score: currentMatches * 3 + historyMatches * 0.6 };
  }).sort((left, right) => right.score - left.score || left.index - right.index);

  const selected: typeof ranked = [];
  let characters = 0;
  for (const candidate of ranked) {
    if (selected.length >= 5) break;
    if (candidate.score <= 0 && selected.length) break;
    const remaining = maxCharacters - characters;
    if (remaining < 80) break;
    const text = candidate.text.slice(0, remaining);
    selected.push({ ...candidate, text });
    characters += text.length + 2;
  }

  return selected
    .sort((left, right) => left.index - right.index)
    .map((passage) => passage.text)
    .join("\n\n")
    .trim();
}
