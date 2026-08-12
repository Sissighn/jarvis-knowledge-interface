/**
 * Bridges the app routes to the local action layer during web development. The desktop
 * runtime answers `/api/local/*` before this route is reached, and hosted builds have no
 * Mac to act on at all.
 */
const FORWARDED_HEADERS = ["content-type", "accept"];
/** The spoken answer arrives as raw samples, and the interface needs to know their rate. */
const RETURNED_HEADERS = ["x-jarvis-sample-rate", "x-jarvis-voice"];

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
    const returned = new Headers({
      "Content-Type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    for (const name of RETURNED_HEADERS) {
      const value = response.headers.get(name);
      if (value) returned.set(name, value);
    }
    // Passed through as a stream: a spoken answer is still being generated while it is sent.
    return new Response(response.body, { status: response.status, headers: returned });
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
