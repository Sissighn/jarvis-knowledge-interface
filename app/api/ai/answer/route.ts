import { NextResponse } from "next/server";
import { generateGroundedAnswer, LocalModelError } from "@/features/ai/server/ollama";
import type { ConversationTurn, ModelContext } from "@/features/ai/types";

export const dynamic = "force-dynamic";

function parseContext(value: unknown): ModelContext | null {
  if (!value || typeof value !== "object") return null;
  const context = value as Partial<ModelContext>;
  if (typeof context.nodeId !== "string"
    || typeof context.label !== "string"
    || typeof context.group !== "string"
    || typeof context.content !== "string") return null;
  return {
    nodeId: context.nodeId,
    label: context.label,
    group: context.group,
    content: context.content,
    retrievalScore: typeof context.retrievalScore === "number" ? context.retrievalScore : 0,
    matchedTerms: Array.isArray(context.matchedTerms)
      ? context.matchedTerms.filter((term): term is string => typeof term === "string").slice(0, 20)
      : [],
  };
}

function parseTurn(value: unknown): ConversationTurn | null {
  if (!value || typeof value !== "object") return null;
  const turn = value as Partial<ConversationTurn>;
  if (typeof turn.question !== "string" || typeof turn.answer !== "string") return null;
  return {
    question: turn.question.replace(/\s+/g, " ").trim().slice(0, 500),
    answer: turn.answer.replace(/\s+/g, " ").trim().slice(0, 1_200),
    sourceNodeIds: Array.isArray(turn.sourceNodeIds)
      ? turn.sourceNodeIds.filter((id): id is string => typeof id === "string").slice(0, 5)
      : [],
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { query?: unknown; contexts?: unknown; history?: unknown };
    const query = typeof body.query === "string" ? body.query.trim() : "";
    const contexts = Array.isArray(body.contexts)
      ? body.contexts.map(parseContext).filter((context): context is ModelContext => Boolean(context)).slice(0, 5)
      : [];
    const history = Array.isArray(body.history)
      ? body.history.map(parseTurn).filter((turn): turn is ConversationTurn => Boolean(turn)).slice(-4)
      : [];
    if (!query || query.length > 500) {
      return NextResponse.json({ error: "Die Frage ist leer oder zu lang." }, { status: 400 });
    }
    if (!contexts.length) {
      return NextResponse.json({ error: "Es wurden keine verwendbaren Wissensquellen übergeben." }, { status: 400 });
    }

    return NextResponse.json(await generateGroundedAnswer(query, contexts, history), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof LocalModelError && error.code === "invalid_response" ? 502 : 503;
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Die lokale KI-Antwort ist fehlgeschlagen.",
      code: error instanceof LocalModelError ? error.code : "unknown",
    }, { status });
  }
}
