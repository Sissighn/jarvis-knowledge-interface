import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import { handleLocalActionRequest, isLocalActionRequest } from "../../desktop/actions/api";
import { normalizeAppName, resolveAllowedApp } from "../../desktop/actions/config";
import { LocalActionError, resolveHomePath } from "../../desktop/actions/macos";
import type { LocalActionStatus } from "../../features/assistant/types";

function request(path: string, init?: RequestInit) {
  return new Request(`http://127.0.0.1:4318${path}`, init);
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("routes only the local action namespace", () => {
  assert.ok(isLocalActionRequest("/api/local/status"));
  assert.ok(isLocalActionRequest("/api/local"));
  assert.equal(isLocalActionRequest("/api/knowledge/status"), false);
  assert.equal(isLocalActionRequest("/api/locally"), false);
});

test("rejects requests from a page that is not the local app", async () => {
  const foreign = await handleLocalActionRequest(post("/api/local/mac/empty-trash", { confirmed: true }, {
    origin: "https://example.com",
  }));
  const crossSite = await handleLocalActionRequest(post("/api/local/mac/empty-trash", { confirmed: true }, {
    "sec-fetch-site": "cross-site",
  }));

  assert.equal(foreign.status, 403);
  assert.equal(crossSite.status, 403);
  assert.equal((await foreign.json() as { code: string }).code, "forbidden_origin");
});

test("accepts the loopback interface and same-process calls", async () => {
  const response = await handleLocalActionRequest(request("/api/local/status", {
    headers: { origin: "http://127.0.0.1:4317" },
  }));
  const payload = await response.json() as LocalActionStatus;

  assert.equal(response.status, 200);
  assert.ok(payload.allowedApps.includes("Spotify"));
  assert.equal(typeof payload.spotify.configured, "boolean");
  assert.equal(typeof payload.google.configured, "boolean");
});

test("an irreversible action without an explicit confirmation never runs", async () => {
  const response = await handleLocalActionRequest(post("/api/local/mac/empty-trash", {}));
  const payload = await response.json() as { code: string; error: string };

  assert.equal(response.status, 428);
  assert.equal(payload.code, "confirmation_required");
  assert.match(payload.error, /Bestätigung/u);
});

test("a confirmation flag that is not exactly true stays rejected", async () => {
  for (const confirmed of ["true", 1, "ja", null]) {
    const response = await handleLocalActionRequest(post("/api/local/mac/empty-trash", { confirmed }));
    assert.equal(response.status, 428, `confirmed=${JSON.stringify(confirmed)} must not pass`);
  }
});

test("unknown actions and methods are refused", async () => {
  const unknown = await handleLocalActionRequest(post("/api/local/mac/format-disk", {}));
  const method = await handleLocalActionRequest(request("/api/local/status", { method: "DELETE" }));

  assert.equal(unknown.status, 404);
  assert.equal(method.status, 405);
});

test("invalid volume values are refused before touching the system", async () => {
  const response = await handleLocalActionRequest(post("/api/local/mac/volume", { percent: "laut" }));

  assert.equal(response.status, 400);
  assert.equal((await response.json() as { code: string }).code, "invalid_percent");
});

test("resolves spoken program names only inside the allowlist", () => {
  assert.equal(resolveAllowedApp("Spotify")?.name, "Spotify");
  assert.equal(resolveAllowedApp("spotify")?.name, "Spotify");
  assert.equal(resolveAllowedApp("VS Code")?.name, "Visual Studio Code");
  assert.equal(resolveAllowedApp("kalender")?.name, "Calendar");
  assert.equal(resolveAllowedApp("Terminal"), null);
  assert.equal(resolveAllowedApp(""), null);
  assert.equal(normalizeAppName("Google Chrome.app"), "google chrome");
});

test("file access stays inside the personal home directory", () => {
  assert.equal(resolveHomePath("~"), homedir());
  assert.throws(() => resolveHomePath("/etc/passwd"), LocalActionError);
  assert.throws(() => resolveHomePath("/System"), LocalActionError);
  assert.throws(() => resolveHomePath("~/gibt-es-nicht-12345"), LocalActionError);
});
