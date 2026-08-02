import { buildDailyBriefing } from "../../../lib/briefing";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const force = new URL(request.url).searchParams.get("force") === "1";
    const briefing = await buildDailyBriefing(force);
    return Response.json(briefing, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Das Morning Briefing konnte nicht geladen werden." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
