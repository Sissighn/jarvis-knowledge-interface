/** Grounded, extractive answers built entirely from the loaded knowledge graph. */
import {
  searchKnowledge,
  tokenizeKnowledgeText,
  type KnowledgeRetrievalContext,
  type KnowledgeSearchResult,
} from "./search";
import type { KnowledgeEdge, KnowledgeNode } from "./types";

export type KnowledgeAnswerStatus = "answered" | "uncertain" | "not_found";

export type KnowledgeEvidence = {
  nodeId: string;
  label: string;
  group: string;
  text: string;
};

export type KnowledgeAnswer = {
  query: string;
  status: KnowledgeAnswerStatus;
  title: string;
  summary: string;
  confidence: number;
  confidenceLabel: "HOCH" | "MITTEL" | "NIEDRIG";
  evidence: KnowledgeEvidence[];
  sources: KnowledgeSearchResult[];
  highlightedNodeIds: string[];
  caveat: string;
  generation?: {
    provider: "ollama";
    model: string;
    citations: number[];
    grounded: boolean;
    conversationTurns: number;
    grounding?: {
      acceptedClaims: number;
      rejectedClaims: number;
      supportRatio: number;
    };
  };
};

type SentenceCandidate = KnowledgeEvidence & { score: number };

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function shorten(value: string, max = 220) {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const clipped = clean.slice(0, max - 1);
  const boundary = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, Math.max(boundary, Math.floor(max * 0.72)))}…`;
}

function sentenceParts(value: string) {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?])\s+|\s*[•·]\s*/u).filter(Boolean);
  if (sentences.length > 1) return sentences.map((sentence) => shorten(sentence));

  const chunks: string[] = [];
  let remaining = clean;
  while (remaining.length > 220) {
    const window = remaining.slice(0, 220);
    const boundary = Math.max(window.lastIndexOf(";"), window.lastIndexOf(","), window.lastIndexOf(" "));
    const end = boundary > 145 ? boundary + 1 : 220;
    chunks.push(shorten(remaining.slice(0, end)));
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function evidenceCandidates(
  nodes: KnowledgeNode[],
  results: KnowledgeSearchResult[],
  queryTerms: string[],
) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const candidates: SentenceCandidate[] = [];

  results.forEach((result, resultIndex) => {
    const node = nodeById.get(result.nodeId);
    const content = node?.content?.trim() ?? "";
    if (!node || content.length < 18 || content.toLocaleLowerCase("de-DE") === node.label.toLocaleLowerCase("de-DE")) return;

    for (const sentence of sentenceParts(content)) {
      if (sentence.length < 18) continue;
      const sentenceTerms = new Set(tokenizeKnowledgeText(sentence));
      const matches = queryTerms.filter((term) => sentenceTerms.has(term));
      const labelMatches = queryTerms.filter((term) => node.label.toLocaleLowerCase("de-DE").includes(term));
      const score = matches.length * 2.2
        + labelMatches.length * 0.55
        + result.score
        + (results.length - resultIndex) * 0.025;
      candidates.push({
        nodeId: node.id,
        label: node.label,
        group: node.group,
        text: shorten(sentence),
        score,
      });
    }
  });

  const seen = new Set<string>();
  return candidates
    .sort((left, right) => right.score - left.score)
    .filter((candidate) => {
      const normalized = candidate.text.toLocaleLowerCase("de-DE");
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .slice(0, 3)
    .map((candidate): KnowledgeEvidence => ({
      nodeId: candidate.nodeId,
      label: candidate.label,
      group: candidate.group,
      text: candidate.text,
    }));
}

function highlightedNodes(results: KnowledgeSearchResult[], edges: KnowledgeEdge[]) {
  const ids = new Set(results.map((result) => result.nodeId));
  const primaryIds = new Set(results.slice(0, 3).map((result) => result.nodeId));
  const related = edges
    .filter((edge) => primaryIds.has(edge.source) || primaryIds.has(edge.target))
    .sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0));

  for (const edge of related) {
    ids.add(edge.source);
    ids.add(edge.target);
    if (ids.size >= 12) break;
  }
  return [...ids];
}

function confidenceLabel(confidence: number): KnowledgeAnswer["confidenceLabel"] {
  if (confidence >= 0.66) return "HOCH";
  if (confidence >= 0.4) return "MITTEL";
  return "NIEDRIG";
}

export function answerKnowledge(
  nodes: KnowledgeNode[],
  edges: KnowledgeEdge[],
  query: string,
  retrievalContext: KnowledgeRetrievalContext = {},
): KnowledgeAnswer {
  const cleanQuery = query.replace(/\s+/g, " ").trim();
  const currentTerms = tokenizeKnowledgeText(cleanQuery);
  const historyTerms = currentTerms.length <= 2
    ? (retrievalContext.previousQueries ?? []).slice(-3).flatMap(tokenizeKnowledgeText)
    : [];
  const queryTerms = [...new Set([...currentTerms, ...historyTerms])];
  const sources = searchKnowledge(nodes, cleanQuery, 5, retrievalContext);

  if (!sources.length) {
    return {
      query: cleanQuery,
      status: "not_found",
      title: "Nichts Belastbares gefunden",
      summary: "In den aktuell geladenen Notizen finde ich keine ausreichend passende Information zu dieser Frage.",
      confidence: 0,
      confidenceLabel: "NIEDRIG",
      evidence: [],
      sources: [],
      highlightedNodeIds: [],
      caveat: "Versuche einen konkreteren Begriff, einen Seitentitel oder synchronisiere weitere passende Notion-Inhalte.",
    };
  }

  const evidence = evidenceCandidates(nodes, sources, queryTerms);
  const matchedTerms = new Set(sources.flatMap((source) => source.matchedTerms));
  const coverage = queryTerms.length ? matchedTerms.size / queryTerms.length : 0;
  const contentSignal = Math.min(1, evidence.length / 2);
  const confidence = clamp(sources[0].score * 0.55 + coverage * 0.3 + contentSignal * 0.15);
  const hasGroundedAnswer = evidence.length > 0 && confidence >= 0.3;

  if (!hasGroundedAnswer) {
    const sourceNames = sources.slice(0, 3).map((source) => `„${source.label}“`).join(", ");
    return {
      query: cleanQuery,
      status: "uncertain",
      title: "Dazu brauche ich mehr Kontext",
      summary: `Ich finde thematisch passende Seiten (${sourceNames}), aber nicht genug ausgelesenen Inhalt für eine verlässliche Antwort.`,
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      evidence: [],
      sources,
      highlightedNodeIds: highlightedNodes(sources, edges),
      caveat: "Ich zeige dir die Fundstellen, statt aus Seitentiteln eine Antwort zu erfinden.",
    };
  }

  const evidenceSourceCount = new Set(evidence.map((item) => item.nodeId)).size;
  return {
    query: cleanQuery,
    status: "answered",
    title: "Antwort aus deinem Wissen",
    summary: evidence.length === 1
      ? "Der stärkste belegte Hinweis aus deinen Notizen lautet:"
      : `Aus ${evidenceSourceCount} ${evidenceSourceCount === 1 ? "Notiz" : "Notizen"} ergeben sich diese belegten Hinweise:`,
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    evidence,
    sources,
    highlightedNodeIds: highlightedNodes(sources, edges),
    caveat: "Diese Antwort ist ausschließlich aus den unten genannten Notion-Inhalten extrahiert.",
  };
}
