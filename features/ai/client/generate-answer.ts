/** Client-side bridge between local retrieval and the server-only Ollama endpoint. */
import type { GeneratedAnswer, ModelContext } from "../types";
import type { KnowledgeAnswer } from "@/features/knowledge/answer";
import type { KnowledgeNode } from "@/features/knowledge/types";

type ErrorPayload = { error?: string };

export function mergeGeneratedAnswer(
  base: KnowledgeAnswer,
  generated: GeneratedAnswer,
): KnowledgeAnswer {
  return {
    ...base,
    status: generated.grounded ? "answered" : "uncertain",
    title: generated.grounded ? "Antwort von deinem lokalen Modell" : "Dazu fehlt mir Wissen",
    summary: generated.answer,
    evidence: [],
    caveat: generated.grounded
      ? "Lokal mit Ollama formuliert – ausschließlich aus den unten markierten Notion-Quellen."
      : "Das lokale Modell konnte aus den gefundenen Notion-Inhalten keine ausreichend belegte Antwort ableiten.",
    generation: {
      provider: generated.provider,
      model: generated.model,
      citations: generated.citations,
      grounded: generated.grounded,
    },
  };
}

function buildContexts(base: KnowledgeAnswer, nodes: KnowledgeNode[]) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const contexts: ModelContext[] = [];
  const sourcePositions: number[] = [];
  base.sources.forEach((source, sourceIndex) => {
    const node = nodesById.get(source.nodeId);
    const content = node?.content?.replace(/\s+/g, " ").trim() ?? "";
    if (content.length < 18 || content.toLocaleLowerCase("de-DE") === source.label.toLocaleLowerCase("de-DE")) return;
    contexts.push({
      nodeId: source.nodeId,
      label: source.label,
      group: source.group,
      content,
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
  nodes: KnowledgeNode[],
  signal?: AbortSignal,
): Promise<KnowledgeAnswer> {
  const { contexts, sourcePositions } = buildContexts(base, nodes);
  if (!contexts.length) return base;

  const response = await fetch("/api/ai/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: base.query, contexts }),
    signal,
  });
  const payload = await response.json() as GeneratedAnswer & ErrorPayload;
  if (!response.ok) throw new Error(payload.error || "Die lokale KI-Antwort ist fehlgeschlagen.");

  return mergeGeneratedAnswer(base, remapCitations(payload, sourcePositions));
}
