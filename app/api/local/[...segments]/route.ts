/**
 * Bridges the app routes to the local action layer during web development. The desktop
 * runtime answers `/api/local/*` before this route is reached, and hosted builds have no
 * Mac to act on at all.
 */
const FORWARDED_HEADERS = ["content-type", "accept"];

function localBaseUrl() {
  return process.env.JARVIS_INDEXER_URL?.trim().replace(/\/$/, "") ?? "";
}

function desktopRequired() {
  return Response.json(
    {
      error: "Aktionen auf diesem Mac sind nur in der lokalen JARVIS-App verfügbar.",
      code: "desktop_required",
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

async function proxy(request: Request) {
  const baseUrl = localBaseUrl();
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
      { error: "Die lokale Aktionsschicht läuft gerade nicht.", code: "actions_unavailable" },
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
