import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function request(pathname = "/", accept = "text/html") {
  const workerUrl = new URL("../../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the JARVIS interface", async () => {
  const response = await request();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>JARVIS — Personal Knowledge Interface<\/title>/i);
  assert.match(html, /PERSONAL KNOWLEDGE INTERFACE/);
  assert.match(html, /NOTION SETUP/);
  assert.match(html, /SYSTEM BEREIT/);
  assert.match(html, /BEISPIELDATEN/);
  assert.doesNotMatch(html, /NOTION_ACCESS_TOKEN|secret_your_internal_notion_token/);
});

test("returns a safe disconnected Notion status without local credentials", async () => {
  const response = await request("/api/notion/status", "application/json");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: false, connected: false });
});

test("exposes a stable local-model status contract", async () => {
  const response = await request("/api/ai/status", "application/json");
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.provider, "ollama");
  assert.equal(typeof payload.connected, "boolean");
  assert.equal(typeof payload.modelAvailable, "boolean");
  assert.equal(typeof payload.model, "string");
});

test("exposes a stable local speech status contract", async () => {
  const response = await request("/api/speech/status", "application/json");
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.provider, "whisper.cpp");
  assert.equal(typeof payload.connected, "boolean");
  assert.equal(typeof payload.model, "string");
});

test("rejects an invalid transcription upload before contacting Whisper", async () => {
  const workerUrl = new URL("../../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-speech-upload`);
  const { default: worker } = await import(workerUrl.href);
  const form = new FormData();
  form.append("audio", new Blob(["not audio"], { type: "text/plain" }), "note.txt");
  const response = await worker.fetch(
    new Request("http://localhost/api/speech/transcribe", { method: "POST", body: form }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 400);
});

test("rejects an invalid glossary export before contacting Notion", async () => {
  const workerUrl = new URL("../../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-glossary-export`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/api/glossary/notion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ termId: 42 }),
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 400);
});

test("keeps the Notion token on the server side", async () => {
  const [page, notion, glossary, gitignore] = await Promise.all([
    readFile(new URL("../../features/interface/components/JarvisInterface.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../features/knowledge/server/notion.ts", import.meta.url), "utf8"),
    readFile(new URL("../../features/glossary/server/notion-glossary.ts", import.meta.url), "utf8"),
    readFile(new URL("../../.gitignore", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /process\.env\.NOTION_ACCESS_TOKEN/);
  assert.match(notion, /process\.env\.NOTION_ACCESS_TOKEN/);
  assert.match(notion, /Authorization: `Bearer \$\{token\}`/);
  assert.doesNotMatch(glossary, /NOTION_ACCESS_TOKEN/);
  assert.match(gitignore, /^\.env\*$/m);
});
