import { buildDailyTechVocabulary } from "@/features/glossary/daily";
import { saveVocabularyTermToNotion } from "@/features/glossary/server/notion-glossary";
import { NotionConnectionError } from "@/features/knowledge/server/notion";

type SaveRequest = { termId?: unknown; date?: unknown };

export async function POST(request: Request) {
  try {
    const body = await request.json() as SaveRequest;
    if (typeof body.termId !== "string" || typeof body.date !== "string") {
      return Response.json({ error: "Begriff und Datum fehlen." }, { status: 400 });
    }

    const vocabulary = buildDailyTechVocabulary(body.date);
    const term = vocabulary.terms.find((entry) => entry.id === body.termId);
    if (!term) return Response.json({ error: "Dieser Begriff gehört nicht zur angefragten Tagesauswahl." }, { status: 400 });

    return Response.json(await saveVocabularyTermToNotion(term), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof NotionConnectionError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Der Begriff konnte nicht in Notion gespeichert werden.";
    return Response.json({ error: message }, { status });
  }
}
