import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function request(pathname = "/", accept = "text/html") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the local JARVIS interface", async () => {
  const response = await request();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>JARVIS — Personal Knowledge Interface<\/title>/i);
  assert.match(html, /PERSONAL KNOWLEDGE INTERFACE/);
  assert.match(html, /NOTION SETUP/);
  assert.match(html, /SYSTEM BEREIT/);
  assert.match(html, /DEMO DATA/);
  assert.doesNotMatch(html, /NOTION_ACCESS_TOKEN|secret_dein_token/);
});

test("returns a safe disconnected Notion status without local credentials", async () => {
  const response = await request("/api/notion/status", "application/json");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: false, connected: false });
});

test("keeps the Notion token on the server side", async () => {
  const [page, notion, gitignore] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/notion.ts", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /process\.env\.NOTION_ACCESS_TOKEN/);
  assert.match(notion, /process\.env\.NOTION_ACCESS_TOKEN/);
  assert.match(notion, /Authorization: `Bearer \$\{token\}`/);
  assert.match(gitignore, /^\.env\*$/m);
});
