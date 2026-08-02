import {
  getNotionConnectionStatus,
  isNotionConfigured,
  NotionConnectionError,
} from "@/features/knowledge/server/notion";

export async function GET() {
  if (!isNotionConfigured()) return Response.json({ configured: false, connected: false });
  try {
    const status = await getNotionConnectionStatus();
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof NotionConnectionError ? error.status : 500;
    return Response.json(
      {
        configured: true,
        connected: false,
        error: error instanceof Error ? error.message : "Notion-Verbindung fehlgeschlagen.",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
