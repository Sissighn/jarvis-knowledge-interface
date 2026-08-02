import { buildNotionGraph, isNotionConfigured, NotionConnectionError } from "@/features/knowledge/server/notion";

export async function GET(request: Request) {
  if (!isNotionConfigured()) {
    return Response.json({ error: "Notion ist noch nicht lokal konfiguriert.", code: "not_configured" }, { status: 503 });
  }
  try {
    const force = new URL(request.url).searchParams.get("force") === "1";
    return Response.json(await buildNotionGraph(force), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof NotionConnectionError ? error.status : 500;
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Der Wissensgraph konnte nicht erstellt werden.",
        code: error instanceof NotionConnectionError ? error.code : "unknown_error",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
