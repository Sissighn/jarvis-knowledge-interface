/** Standalone local indexer process, used by `npm run dev` next to the web server. */
import { createServer, type IncomingMessage } from "node:http";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { handleKnowledgeRequest, isKnowledgeRequest } from "./api";
import { indexerPort } from "./config";
import { knowledgeService } from "./service";

function loadRuntimeEnvironment() {
  const candidates = [
    process.env.JARVIS_ENV_FILE?.trim(),
    resolve(process.cwd(), ".env.local"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      loadEnvFile(candidate);
      return;
    } catch {
      // Missing local configuration keeps the indexer usable with safe defaults.
    }
  }
}

async function requestBody(request: IncomingMessage) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

loadRuntimeEnvironment();

const port = indexerPort();
const server = createServer(async (incoming, response) => {
  const url = `http://127.0.0.1:${port}${incoming.url || "/"}`;
  try {
    const body = await requestBody(incoming);
    const request = new Request(url, {
      method: incoming.method,
      headers: incoming.headers as HeadersInit,
      body,
    });
    if (!isKnowledgeRequest(new URL(url).pathname)) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not Found");
      return;
    }
    const result = await handleKnowledgeRequest(request);
    response.statusCode = result.status;
    result.headers.forEach((value, name) => response.setHeader(name, value));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    console.error("Knowledge indexer request failed", error instanceof Error ? error.message : error);
    response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Der lokale Index hat die Anfrage nicht verarbeitet." }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`JARVIS_INDEXER_READY:${port}`);
});

function shutdown() {
  server.close(() => {
    knowledgeService().close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
