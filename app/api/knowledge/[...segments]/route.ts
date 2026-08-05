/**
 * Bridges the app routes to the local indexer during web development. The desktop
 * runtime answers `/api/knowledge/*` before this route is reached, and hosted builds
 * have no local index at all.
 */
const FORWARDED_HEADERS = ["content-type", "accept"];

function indexerBaseUrl() {
  return process.env.JARVIS_INDEXER_URL?.trim().replace(/\/$/, "") ?? "";
}

function desktopRequired() {
  return Response.json(
    {
      error: "Der lokale Wissensindex ist nur in der JARVIS-Desktop-App verfügbar.",
      code: "desktop_required",
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

async function proxy(request: Request) {
  const baseUrl = indexerBaseUrl();
  if (!baseUrl) return desktopRequired();

  const url = new URL(request.url);
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  try {
    const response = await fetch(`${baseUrl}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
    });
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json(
      { error: "Der lokale Index läuft gerade nicht.", code: "indexer_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return proxy(request);
}

export async function POST(request: Request) {
  return proxy(request);
}

export async function PUT(request: Request) {
  return proxy(request);
}
