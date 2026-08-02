import { getWeather } from "@/features/weather/server/weather";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const force = new URL(request.url).searchParams.get("force") === "1";
    const weather = await getWeather(force);
    return Response.json(weather, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Das Wetter konnte nicht geladen werden." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
