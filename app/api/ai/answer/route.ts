import { NextResponse } from "next/server";
import { generateGroundedAnswer, LocalModelError } from "@/features/ai/server/ollama";
import type { ModelContext } from "@/features/ai/types";

export const dynamic = "force-dynamic";

function isContext(value: unknown): value is ModelContext {
  if (!value || typeof value !== "object") return false;
  const context = value as Partial<ModelContext>;
  return typeof context.nodeId === "string"
    && typeof context.label === "string"
    && typeof context.group === "string"
    && typeof context.content === "string";
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { query?: unknown; contexts?: unknown };
    const query = typeof body.query === "string" ? body.query.trim() : "";
    const contexts = Array.isArray(body.contexts) ? body.contexts.filter(isContext).slice(0, 5) : [];
    if (!query || query.length > 500) {
      return NextResponse.json({ error: "Die Frage ist leer oder zu lang." }, { status: 400 });
    }
    if (!contexts.length) {
      return NextResponse.json({ error: "Es wurden keine verwendbaren Wissensquellen übergeben." }, { status: 400 });
    }

    return NextResponse.json(await generateGroundedAnswer(query, contexts), {
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
