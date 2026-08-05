/** Hybrid chunk retrieval: FTS5/BM25 plus embeddings, fused with reciprocal rank fusion. */
import { cosineSimilarity } from "@/features/knowledge/relations";
import {
  buildSnippet,
  matchingTerms,
  reciprocalRankFusion,
  retrievalTerms,
  tokenizeKnowledgeText,
  toFtsQuery,
  type KnowledgeRetrievalContext,
} from "@/features/knowledge/search";
import type { KnowledgeSearchResponse, RetrievedChunk } from "@/features/knowledge/types";
import { embedTexts } from "./ai/ollama";
import { embeddingModel } from "./config";
import type { KnowledgeRepository, StoredChunk } from "./db/repository";

export const MAX_ANSWER_CHUNKS = 8;
export const MAX_ANSWER_SOURCES = 5;
const CANDIDATE_LIMIT = 40;

export function chunkNotionUrl(chunk: StoredChunk) {
  if (!chunk.url) return "";
  return chunk.blockId ? `${chunk.url}#${chunk.blockId.replace(/-/gu, "")}` : chunk.url;
}

/** Keeps the answer diverse: at most eight chunks from at most five sources. */
export function selectDiverseChunks(
  ranked: Array<{ chunk: StoredChunk; score: number }>,
  maxChunks = MAX_ANSWER_CHUNKS,
  maxSources = MAX_ANSWER_SOURCES,
) {
  const selected: Array<{ chunk: StoredChunk; score: number }> = [];
  const sources = new Set<string>();
  for (const candidate of ranked) {
    if (selected.length >= maxChunks) break;
    if (!sources.has(candidate.chunk.sourceId) && sources.size >= maxSources) continue;
    sources.add(candidate.chunk.sourceId);
    selected.push(candidate);
  }
  return selected;
}

export async function searchKnowledgeChunks(
  repository: KnowledgeRepository,
  query: string,
  context: KnowledgeRetrievalContext = {},
): Promise<KnowledgeSearchResponse> {
  const { queryTerms, historyTerms } = retrievalTerms(query, context);
  const terms = [...queryTerms, ...historyTerms];
  if (!terms.length) return { chunks: [], conceptIds: [], graphVersion: repository.graphVersion() };

  const lexical = repository.searchChunksByText(toFtsQuery(terms), CANDIDATE_LIMIT);

  let semantic: string[] = [];
  try {
    const [queryVector] = await embedTexts([query], embeddingModel());
    if (queryVector?.length) {
      const embeddings = repository.listEmbeddings("chunk", embeddingModel(), true);
      semantic = [...embeddings.entries()]
        .map(([chunkId, vector]) => ({ chunkId, score: cosineSimilarity(queryVector, vector) }))
        .filter((entry) => entry.score > 0.25)
        .sort((left, right) => right.score - left.score)
        .slice(0, CANDIDATE_LIMIT)
        .map((entry) => entry.chunkId);
    }
  } catch {
    // Without a reachable embedding model the lexical ranking still answers.
  }

  const fused = reciprocalRankFusion([lexical, semantic]).slice(0, CANDIDATE_LIMIT);
  const chunks = new Map(repository.chunksByIds(fused.map((entry) => entry.id)).map((chunk) => [chunk.id, chunk]));
  const preferredSources = new Set(context.preferredSourceIds ?? []);
  const ranked = fused
    .map((entry) => {
      const chunk = chunks.get(entry.id);
      if (!chunk) return null;
      const bonus = preferredSources.has(chunk.sourceId) ? 0.004 : 0;
      return { chunk, score: entry.score + bonus };
    })
    .filter((entry): entry is { chunk: StoredChunk; score: number } => Boolean(entry))
    .sort((left, right) => right.score - left.score);

  const bestScore = ranked[0]?.score ?? 1;
  const selected = selectDiverseChunks(ranked);
  const retrieved: RetrievedChunk[] = selected.map(({ chunk, score }) => {
    const chunkTerms = tokenizeKnowledgeText(`${chunk.headingPath} ${chunk.text}`);
    const matched = matchingTerms(queryTerms, chunkTerms);
    return {
      chunkId: chunk.id,
      sourceId: chunk.sourceId,
      sourceTitle: chunk.sourceTitle,
      rootTitle: chunk.rootTitle,
      headingPath: chunk.headingPath,
      text: chunk.text,
      snippet: buildSnippet(chunk.text, matched.length ? matched : queryTerms),
      notionUrl: chunkNotionUrl(chunk),
      blockId: chunk.blockId,
      score: bestScore ? Math.min(1, score / bestScore) : 0,
      matchedTerms: matched,
    };
  });

  return {
    chunks: retrieved,
    conceptIds: repository.conceptIdsForChunks(retrieved.map((chunk) => chunk.chunkId)),
    graphVersion: repository.graphVersion(),
  };
}
