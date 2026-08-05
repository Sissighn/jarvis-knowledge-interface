/** Browser access to the local knowledge index. */
import type { KnowledgeRetrievalContext } from "./search";
import type { KnowledgeSearchResponse } from "./types";

export class KnowledgeIndexError extends Error {
  code: string;

  constructor(message: string, code = "index_error") {
    super(message);
    this.name = "KnowledgeIndexError";
    this.code = code;
  }
}

export async function searchIndexedKnowledge(
  query: string,
  context: KnowledgeRetrievalContext = {},
  signal?: AbortSignal,
): Promise<KnowledgeSearchResponse> {
  const response = await fetch("/api/knowledge/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    signal,
    body: JSON.stringify({
      query,
      previousQueries: context.previousQueries ?? [],
      preferredSourceIds: context.preferredSourceIds ?? [],
    }),
  });
  const payload = await response.json().catch(() => ({})) as KnowledgeSearchResponse & { error?: string; code?: string };
  if (!response.ok) {
    throw new KnowledgeIndexError(
      payload.error || "Der lokale Wissensindex hat nicht geantwortet.",
      payload.code || "index_error",
    );
  }
  return { chunks: payload.chunks ?? [], conceptIds: payload.conceptIds ?? [], graphVersion: payload.graphVersion ?? 0 };
}
