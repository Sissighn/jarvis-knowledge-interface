/** Grounded, extractive answers built entirely from indexed Notion chunks. */
import { buildSnippet, matchingTerms, tokenizeKnowledgeText } from "./search";
import type { RetrievedChunk } from "./types";

export type KnowledgeAnswerStatus = "answered" | "uncertain" | "not_found";

export type KnowledgeSource = {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  rootTitle: string;
  headingPath: string;
  snippet: string;
  notionUrl: string;
  score: number;
  matchedTerms: string[];
};

export type KnowledgeEvidence = {
  chunkId: string;
  sourceTitle: string;
  headingPath: string;
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
  sources: KnowledgeSource[];
  highlightedConceptIds: string[];
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

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function shorten(value: string, max = 220) {
  const clean = value.replace(/\s+/gu, " ").trim();
  if (clean.length <= max) return clean;
  const clipped = clean.slice(0, max - 1);
  const boundary = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, Math.max(boundary, Math.floor(max * 0.72)))}…`;
}

function sentenceParts(value: string) {
  const clean = value.replace(/\s+/gu, " ").trim();
  if (!clean) return [];
  return clean.split(/(?<=[.!?])\s+|\s*[•·]\s*/u).filter((part) => part.trim().length >= 18);
}

function confidenceLabel(confidence: number): KnowledgeAnswer["confidenceLabel"] {
  if (confidence >= 0.66) return "HOCH";
  if (confidence >= 0.4) return "MITTEL";
  return "NIEDRIG";
}

export function toKnowledgeSource(chunk: RetrievedChunk): KnowledgeSource {
  return {
    chunkId: chunk.chunkId,
    sourceId: chunk.sourceId,
    sourceTitle: chunk.sourceTitle,
    rootTitle: chunk.rootTitle,
    headingPath: chunk.headingPath,
    snippet: chunk.snippet || buildSnippet(chunk.text, chunk.matchedTerms),
    notionUrl: chunk.notionUrl,
    score: chunk.score,
    matchedTerms: chunk.matchedTerms,
  };
}

function evidenceFromChunks(chunks: RetrievedChunk[], queryTerms: string[]): KnowledgeEvidence[] {
  const candidates = chunks.flatMap((chunk, chunkIndex) => sentenceParts(chunk.text).map((sentence) => {
    const sentenceTerms = tokenizeKnowledgeText(sentence);
    const matches = matchingTerms(queryTerms, sentenceTerms).length;
    return {
      chunkId: chunk.chunkId,
      sourceTitle: chunk.sourceTitle,
      headingPath: chunk.headingPath,
      text: shorten(sentence),
      score: matches * 2.2 + chunk.score + (chunks.length - chunkIndex) * 0.025,
      matches,
    };
  }));

  const seen = new Set<string>();
  return candidates
    .filter((candidate) => candidate.matches > 0)
    .sort((left, right) => right.score - left.score)
    .filter((candidate) => {
      const normalized = candidate.text.toLocaleLowerCase("de-DE");
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .slice(0, 3)
    .map(({ chunkId, sourceTitle, headingPath, text }) => ({ chunkId, sourceTitle, headingPath, text }));
}

/**
 * Turns the hybrid retrieval result into a grounded answer skeleton. The local model
 * refines it later; without indexed evidence the answer stays explicitly uncertain.
 */
export function answerFromChunks(
  query: string,
  chunks: RetrievedChunk[],
  highlightedConceptIds: string[] = [],
): KnowledgeAnswer {
  const cleanQuery = query.replace(/\s+/gu, " ").trim();
  const queryTerms = [...new Set(tokenizeKnowledgeText(cleanQuery))];
  const sources = chunks.map(toKnowledgeSource);

  if (!sources.length) {
    return {
      query: cleanQuery,
      status: "not_found",
      title: "Nichts Belastbares gefunden",
      summary: "Im lokalen Wissensindex finde ich keine ausreichend passende Fundstelle zu dieser Frage.",
      confidence: 0,
      confidenceLabel: "NIEDRIG",
      evidence: [],
      sources: [],
      highlightedConceptIds: [],
      caveat: "Versuche einen konkreteren Fachbegriff oder wähle weitere Notion-Datenbanken aus.",
    };
  }

  const evidence = evidenceFromChunks(chunks, queryTerms);
  const matchedTerms = new Set(chunks.flatMap((chunk) => chunk.matchedTerms));
  const coverage = queryTerms.length ? matchedTerms.size / queryTerms.length : 0;
  const contentSignal = Math.min(1, evidence.length / 2);
  const confidence = clamp(sources[0].score * 0.55 + coverage * 0.3 + contentSignal * 0.15);
  const distinctSources = new Set(sources.map((source) => source.sourceId)).size;

  if (!evidence.length || confidence < 0.3) {
    const sourceNames = [...new Set(sources.slice(0, 3).map((source) => `„${source.sourceTitle}“`))].join(", ");
    return {
      query: cleanQuery,
      status: "uncertain",
      title: "Dazu brauche ich mehr Kontext",
      summary: `Ich finde thematisch passende Abschnitte (${sourceNames}), aber nicht genug belegten Inhalt für eine verlässliche Antwort.`,
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      evidence: [],
      sources,
      highlightedConceptIds,
      caveat: "Ich zeige dir die Fundstellen, statt aus Seitentiteln eine Antwort zu erfinden.",
    };
  }

  return {
    query: cleanQuery,
    status: "answered",
    title: "Antwort aus deinem Wissen",
    summary: evidence.length === 1
      ? "Der stärkste belegte Hinweis aus deinem Index lautet:"
      : `Aus ${distinctSources} ${distinctSources === 1 ? "Quelle" : "Quellen"} ergeben sich diese belegten Hinweise:`,
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    evidence,
    sources,
    highlightedConceptIds,
    caveat: "Diese Antwort ist ausschließlich aus den unten genannten Notion-Abschnitten extrahiert.",
  };
}
