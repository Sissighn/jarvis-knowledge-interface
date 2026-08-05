/** Client-side bridge between indexed chunk retrieval and the local Ollama endpoint. */
import type { ConversationTurn, GeneratedAnswer, ModelContext } from "../types";
import type { KnowledgeAnswer } from "@/features/knowledge/answer";
import { selectRelevantPassages } from "@/features/knowledge/search";
import type { RetrievedChunk } from "@/features/knowledge/types";

type ErrorPayload = { error?: string };

export function mergeGeneratedAnswer(
  base: KnowledgeAnswer,
  generated: GeneratedAnswer,
  conversationTurns = 0,
): KnowledgeAnswer {
  return {
    ...base,
    status: generated.grounded ? "answered" : "uncertain",
    title: generated.grounded ? "Antwort von deinem lokalen Modell" : "Dazu fehlt mir Wissen",
    summary: generated.answer,
    evidence: [],
    caveat: generated.grounded
      ? "Lokal mit Ollama formuliert – ausschließlich aus den unten markierten Notion-Abschnitten."
      : "Das lokale Modell konnte aus den gefundenen Abschnitten keine ausreichend belegte Antwort ableiten.",
    generation: {
      provider: generated.provider,
      model: generated.model,
      citations: generated.citations,
      grounded: generated.grounded,
      conversationTurns,
      grounding: generated.grounding,
    },
  };
}

export function buildModelContexts(
  base: KnowledgeAnswer,
  chunks: RetrievedChunk[],
  history: ConversationTurn[] = [],
) {
  const chunkById = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  const contexts: ModelContext[] = [];
  const sourcePositions: number[] = [];
  const previousQueries = history.map((turn) => turn.question);

  base.sources.forEach((source, sourceIndex) => {
    const chunk = chunkById.get(source.chunkId);
    const content = chunk?.text.replace(/\s+/gu, " ").trim() ?? "";
    if (content.length < 18) return;
    contexts.push({
      chunkId: source.chunkId,
      sourceTitle: source.sourceTitle,
      headingPath: source.headingPath,
      content: selectRelevantPassages(content, base.query, previousQueries),
      retrievalScore: source.score,
      matchedTerms: source.matchedTerms,
    });
    sourcePositions.push(sourceIndex + 1);
  });
  return { contexts, sourcePositions };
}

export function remapCitations(generated: GeneratedAnswer, sourcePositions: number[]): GeneratedAnswer {
  const mapCitation = (citation: number) => sourcePositions[citation - 1];
  const citations = [...new Set(generated.citations.map(mapCitation).filter((value): value is number => Boolean(value)))];
  const answer = generated.answer.replace(/\[(\d+)\]/g, (marker, rawCitation: string) => {
    const mapped = mapCitation(Number(rawCitation));
    return mapped ? `[${mapped}]` : marker;
  });
  return { ...generated, answer, citations };
}

export async function generateKnowledgeAnswer(
  base: KnowledgeAnswer,
  chunks: RetrievedChunk[],
  history: ConversationTurn[] = [],
  signal?: AbortSignal,
): Promise<KnowledgeAnswer> {
  const { contexts, sourcePositions } = buildModelContexts(base, chunks, history);
  if (!contexts.length) return base;

  const response = await fetch("/api/ai/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: base.query, contexts, history: history.slice(-4) }),
    signal,
  });
  const payload = await response.json() as GeneratedAnswer & ErrorPayload;
  if (!response.ok) throw new Error(payload.error || "Die lokale KI-Antwort ist fehlgeschlagen.");

  return mergeGeneratedAnswer(base, remapCitations(payload, sourcePositions), history.length);
}
