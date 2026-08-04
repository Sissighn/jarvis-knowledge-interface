/** Pure, client-safe retrieval utilities for the loaded knowledge graph. */
import type { KnowledgeNode } from "./types";

export type SearchableKnowledgeNode = Pick<
  KnowledgeNode,
  "id" | "label" | "group" | "kind" | "url" | "content" | "keywords"
>;

export type KnowledgeSearchResult = {
  nodeId: string;
  label: string;
  group: string;
  url?: string;
  snippet: string;
  score: number;
  matchedTerms: string[];
};

export type KnowledgeRetrievalContext = {
  previousQueries?: string[];
  preferredNodeIds?: string[];
};

const STOP_WORDS = new Set([
  "aber", "alle", "also", "and", "auch", "auf", "aus", "bei", "bin", "bis", "das", "dass",
  "dein", "deine", "dem", "den", "der", "des", "die", "dies", "diese", "ein", "eine", "einem",
  "einen", "einer", "für", "gibt", "habe", "hat", "ich", "ihre", "im", "in", "ist", "kann",
  "mein", "meine", "mit", "nach", "nicht", "noch", "oder", "sich", "sind", "the", "und", "uns",
  "von", "warum", "was", "welche", "wie", "wir", "with", "you", "your", "zum", "zur", "über",
  "zeige", "zeig", "finde", "wissen", "notiz", "notizen", "notion",
]);

type SparseVector = Map<string, number>;

const FOLLOW_UP_PATTERN = /\b(?:das|dazu|davon|dies|diese|weiter|mehr|genau|vorher|funktioniert|beispiel)\b/iu;

export function tokenizeKnowledgeText(value: string) {
  return (value.toLocaleLowerCase("de-DE").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token) && !/^\d+$/.test(token));
}

function normalize(vector: SparseVector) {
  const magnitude = Math.sqrt([...vector.values()].reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) return vector;
  for (const [term, value] of vector) vector.set(term, value / magnitude);
  return vector;
}

function cosine(left: SparseVector, right: SparseVector) {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let score = 0;
  for (const [term, value] of small) score += value * (large.get(term) ?? 0);
  return score;
}

function relatedTerm(left: string, right: string) {
  if (left === right) return 1;
  if (left.length < 5 || right.length < 5) return 0;
  const prefixLength = Math.min(7, left.length - 1, right.length - 1);
  return left.slice(0, prefixLength) === right.slice(0, prefixLength) ? 0.72 : 0;
}

function matchingTerms(queryTerms: string[], documentTerms: string[]) {
  return queryTerms.filter((queryTerm) => documentTerms.some((documentTerm) => relatedTerm(queryTerm, documentTerm) > 0));
}

function jaccard(left: Set<string>, right: Set<string>) {
  let intersection = 0;
  for (const term of left) if (right.has(term)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union ? intersection / union : 0;
}

function makeSnippet(node: SearchableKnowledgeNode, terms: string[]) {
  const content = (node.content || node.label).replace(/\s+/g, " ").trim();
  if (content.length <= 230) return content;
  const lower = content.toLocaleLowerCase("de-DE");
  const matchIndex = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, Math.min(matchIndex - 70, content.length - 230));
  const raw = content.slice(start, start + 230);
  const firstSpace = start > 0 ? raw.indexOf(" ") : 0;
  const lastSpace = raw.lastIndexOf(" ");
  const clipped = raw.slice(Math.max(0, firstSpace), lastSpace > 0 ? lastSpace : undefined).trim();
  return `${start > 0 ? "…" : ""}${clipped}${start + 230 < content.length ? "…" : ""}`;
}

export function searchKnowledge(
  nodes: SearchableKnowledgeNode[],
  query: string,
  limit = 5,
  context: KnowledgeRetrievalContext = {},
): KnowledgeSearchResult[] {
  const searchableNodes = nodes.filter((node) => node.kind !== "system");
  const queryTerms = [...new Set(tokenizeKnowledgeText(query))];
  const followUp = queryTerms.length <= 2 || FOLLOW_UP_PATTERN.test(query);
  const historyTerms = followUp
    ? [...new Set((context.previousQueries ?? []).slice(-3).flatMap(tokenizeKnowledgeText))]
      .filter((term) => !queryTerms.includes(term))
      .slice(0, 18)
    : [];
  const retrievalTerms = [...queryTerms, ...historyTerms];
  if (!searchableNodes.length || !retrievalTerms.length) return [];

  const documents = searchableNodes.map((node) => {
    const title = tokenizeKnowledgeText(node.label);
    const group = tokenizeKnowledgeText(node.group);
    const keywords = tokenizeKnowledgeText(node.keywords?.join(" ") ?? "");
    const content = tokenizeKnowledgeText(node.content ?? "");
    return {
      title,
      group,
      keywords,
      content,
      all: [...title, ...title, ...title, ...keywords, ...keywords, ...group, ...content],
    };
  });
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(document.all)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const idf = (term: string) => Math.log((documents.length + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1;
  const toVector = (terms: string[]) => {
    const counts = new Map<string, number>();
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    const vector: SparseVector = new Map();
    for (const [term, count] of counts) vector.set(term, (1 + Math.log(count)) * idf(term));
    return normalize(vector);
  };
  const queryVector = toVector(retrievalTerms);
  const normalizedQuery = query.trim().toLocaleLowerCase("de-DE");
  const preferredNodeIds = new Set(context.preferredNodeIds ?? []);

  const candidates = searchableNodes
    .map((node, index) => {
      const document = documents[index];
      const termSet = new Set(document.all);
      const matchedTerms = matchingTerms(queryTerms, document.all);
      const matchedHistoryTerms = matchingTerms(historyTerms, document.all);
      const supportTerms = [...new Set([...matchedTerms, ...matchedHistoryTerms])];
      const title = node.label.toLocaleLowerCase("de-DE");
      const exactTitleBonus = title.includes(normalizedQuery) ? 0.28 : 0;
      const titleTermBonus = matchingTerms(queryTerms, document.title).length * 0.075;
      const keywordBonus = matchingTerms(queryTerms, document.keywords).length * 0.055;
      const coverageBonus = queryTerms.length ? matchedTerms.length / queryTerms.length * 0.1 : 0;
      const historySignal = historyTerms.length ? matchedHistoryTerms.length / historyTerms.length * 0.12 : 0;
      const preferredBonus = preferredNodeIds.has(node.id) ? (followUp ? 0.14 : 0.035) : 0;
      const score = Math.min(1,
        cosine(queryVector, toVector(document.all))
        + exactTitleBonus
        + titleTermBonus
        + keywordBonus
        + coverageBonus
        + historySignal
        + preferredBonus);
      return {
        nodeId: node.id,
        label: node.label,
        group: node.group,
        url: node.url,
        snippet: makeSnippet(node, supportTerms.length ? supportTerms : retrievalTerms),
        score,
        matchedTerms: supportTerms,
        termSet,
      };
    })
    .filter((result) => result.score >= 0.045 && result.matchedTerms.length > 0)
    .sort((left, right) => right.score - left.score);

  const selected: typeof candidates = [];
  const targetCount = Math.max(1, Math.min(limit, 5));
  while (selected.length < targetCount && candidates.length > selected.length) {
    const remaining = candidates.filter((candidate) => !selected.includes(candidate));
    const next = remaining.sort((left, right) => {
      const diversityPenalty = (candidate: typeof left) => selected.reduce(
        (maximum, chosen) => Math.max(maximum, jaccard(candidate.termSet, chosen.termSet)),
        0,
      ) * 0.1;
      return (right.score - diversityPenalty(right)) - (left.score - diversityPenalty(left));
    })[0];
    if (!next) break;
    selected.push(next);
  }

  return selected.map((result): KnowledgeSearchResult => ({
    nodeId: result.nodeId,
    label: result.label,
    group: result.group,
    url: result.url,
    snippet: result.snippet,
    score: result.score,
    matchedTerms: result.matchedTerms,
  }));
}

function passageParts(content: string) {
  return content
    .replace(/\r/g, "")
    .split(/\n{2,}|(?<=[.!?])\s+(?=[\p{Lu}\d])/u)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length >= 18);
}

export function selectRelevantPassages(
  content: string,
  query: string,
  previousQueries: string[] = [],
  maxCharacters = 1_400,
) {
  const clean = content.replace(/\s+/g, " ").trim();
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
