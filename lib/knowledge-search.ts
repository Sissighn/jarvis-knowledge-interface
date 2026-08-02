export type SearchableKnowledgeNode = {
  id: string;
  label: string;
  group: string;
  kind: "system" | "page" | "data_source";
  url?: string;
  content?: string;
  keywords?: string[];
};

export type KnowledgeSearchResult = {
  nodeId: string;
  label: string;
  group: string;
  url?: string;
  snippet: string;
  score: number;
  matchedTerms: string[];
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

function tokenize(value: string) {
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
): KnowledgeSearchResult[] {
  const searchableNodes = nodes.filter((node) => node.kind !== "system");
  const queryTerms = [...new Set(tokenize(query))];
  if (!searchableNodes.length || !queryTerms.length) return [];

  const documents = searchableNodes.map((node) => {
    const title = tokenize(node.label);
    const body = tokenize(`${node.group} ${node.keywords?.join(" ") ?? ""} ${node.content ?? ""}`);
    return [...title, ...title, ...title, ...body];
  });
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(document)) {
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
  const queryVector = toVector(queryTerms);
  const normalizedQuery = query.trim().toLocaleLowerCase("de-DE");

  return searchableNodes
    .map((node, index) => {
      const documentTerms = documents[index];
      const termSet = new Set(documentTerms);
      const matchedTerms = queryTerms.filter((term) => termSet.has(term));
      const title = node.label.toLocaleLowerCase("de-DE");
      const exactTitleBonus = title.includes(normalizedQuery) ? 0.28 : 0;
      const titleTermBonus = queryTerms.filter((term) => title.includes(term)).length * 0.07;
      const coverageBonus = matchedTerms.length / queryTerms.length * 0.09;
      const score = Math.min(1, cosine(queryVector, toVector(documentTerms)) + exactTitleBonus + titleTermBonus + coverageBonus);
      return {
        nodeId: node.id,
        label: node.label,
        group: node.group,
        url: node.url,
        snippet: makeSnippet(node, matchedTerms.length ? matchedTerms : queryTerms),
        score,
        matchedTerms,
      };
    })
    .filter((result) => result.score >= 0.045 && result.matchedTerms.length > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, Math.min(limit, 5)));
}
