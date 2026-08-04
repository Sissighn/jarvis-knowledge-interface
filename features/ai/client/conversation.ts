import type { ConversationTurn } from "../types";
import type { KnowledgeAnswer } from "@/features/knowledge/answer";
import type { KnowledgeRetrievalContext } from "@/features/knowledge/search";

const MAX_CONVERSATION_TURNS = 4;

export function retrievalContextFromHistory(history: ConversationTurn[]): KnowledgeRetrievalContext {
  return {
    previousQueries: history.slice(-MAX_CONVERSATION_TURNS).map((turn) => turn.question),
    preferredNodeIds: [...new Set(history.slice(-2).flatMap((turn) => turn.sourceNodeIds))],
  };
}

export function rememberConversationTurn(
  history: ConversationTurn[],
  answer: KnowledgeAnswer,
): ConversationTurn[] {
  if (!answer.sources.length) return history;
  const citedSources = answer.generation?.citations.length
    ? answer.generation.citations
      .map((citation) => answer.sources[citation - 1]?.nodeId)
      .filter((nodeId): nodeId is string => Boolean(nodeId))
    : answer.sources.slice(0, 3).map((source) => source.nodeId);
  const turn: ConversationTurn = {
    question: answer.query.slice(0, 500),
    answer: answer.summary.replace(/\s+/g, " ").trim().slice(0, 1_200),
    sourceNodeIds: [...new Set(citedSources)].slice(0, 5),
  };
  return [...history, turn].slice(-MAX_CONVERSATION_TURNS);
}
