import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { assets } from "../../.desktop-build/assets.generated.mjs";
import worker from "../../dist/server/index.js";
import { handleKnowledgeRequest, isKnowledgeRequest } from "../indexer/api";

type AssetEntry = {
  contentType: string;
  body: string;
};

type DesktopEnvironment = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  IMAGES: { input(): never };
};

type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
};

const DEFAULT_PORT = 4317;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function loadRuntimeEnvironment() {
  const configuredDirectory = process.env.JARVIS_CONFIG_DIR?.trim();
  const candidates = [
    process.env.JARVIS_ENV_FILE?.trim(),
    configuredDirectory ? resolve(configuredDirectory, ".env.local") : undefined,
    resolve(process.cwd(), ".env.local"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      loadEnvFile(candidate);
      return;
    } catch {
      // A missing optional runtime file keeps the app usable with safe defaults.
    }
  }
}

function normalizedAssetPath(url: URL) {
  try {
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.includes("\0") || decoded.split("/").includes("..")) return null;
    return decoded.replace(/^\/+/, "");
  } catch {
    return null;
  }
}

function assetEntry(request: Request) {
  const path = normalizedAssetPath(new URL(request.url));
  if (!path) return null;

  const entry = (assets as Record<string, AssetEntry>)[path];
  return entry ? { entry, path } : null;
}

function assetResponse(request: Request) {
  const asset = assetEntry(request);
  if (!asset) return new Response("Not Found", { status: 404 });

  return new Response(request.method === "HEAD" ? null : Buffer.from(asset.entry.body, "base64"), {
    status: 200,
    headers: {
      "Cache-Control": asset.path.startsWith("assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      "Content-Type": asset.entry.contentType,
    },
  });
}

async function requestBody(request: IncomingMessage) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function requestUrl(request: IncomingMessage, port: number) {
  const host = request.headers.host || `127.0.0.1:${port}`;
  return `http://${host}${request.url || "/"}`;
}

async function toWebRequest(request: IncomingMessage, port: number) {
  const body = await requestBody(request);
  return new Request(requestUrl(request, port), {
    method: request.method,
    headers: request.headers as HeadersInit,
    body,
  });
}

async function sendResponse(response: Response, target: ServerResponse) {
  target.statusCode = response.status;
  target.statusMessage = response.statusText;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  target.end(Buffer.from(await response.arrayBuffer()));
}

loadRuntimeEnvironment();

const pendingTasks = new Set<Promise<unknown>>();
const environment: DesktopEnvironment = {
  ASSETS: { fetch: async (request) => assetResponse(request) },
  IMAGES: {
    input() {
      throw new Error("Image optimization is not enabled in the desktop runtime.");
    },
  },
};
const context: ExecutionContext = {
  waitUntil(promise) {
    pendingTasks.add(promise);
    void promise.finally(() => pendingTasks.delete(promise));
  },
  passThroughOnException() {},
};

const configuredPort = Number(process.env.JARVIS_SERVER_PORT);
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
  ? configuredPort
  : DEFAULT_PORT;

const server = createServer(async (request, response) => {
  try {
    const webRequest = await toWebRequest(request, port);
    if (assetEntry(webRequest)) {
      await sendResponse(assetResponse(webRequest), response);
      return;
    }
    // The local knowledge index runs in this Node process, never inside the worker.
    if (isKnowledgeRequest(new URL(webRequest.url).pathname)) {
      await sendResponse(await handleKnowledgeRequest(webRequest), response);
      return;
    }
    await sendResponse(await worker.fetch(webRequest, environment, context), response);
  } catch (error) {
    if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") {
      response.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Request body too large");
      return;
    }
    console.error("Desktop server request failed", error);
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Internal Server Error");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`JARVIS_SERVER_READY:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
