import assert from "node:assert/strict";
import test from "node:test";
import { openExternalUrl } from "../../features/desktop/links";

type OpenCall = { url: string; target: string };

/** A window just complete enough for the helper: a `window.open` spy and an optional Tauri flag. */
function fakeWindow(desktop: boolean) {
  const opened: OpenCall[] = [];
  const value = {
    open: (url: string, target: string) => {
      opened.push({ url, target });
      return null;
    },
    ...(desktop ? { __TAURI_INTERNALS__: {} } : {}),
  };
  Object.defineProperty(globalThis, "window", { value, configurable: true, writable: true });
  return opened;
}

function fakeFetch(response: Response | Error) {
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "null")) });
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
  return calls;
}

test("in a browser tab an address simply opens in a new tab", async () => {
  const opened = fakeWindow(false);

  assert.equal(await openExternalUrl(" https://example.com/artikel "), "");
  assert.deepEqual(opened, [{ url: "https://example.com/artikel", target: "_blank" }]);
});

test("in the packaged app the address goes to the local action layer instead", async () => {
  // The desktop webview swallows window.open, so nothing may be routed through it there.
  const opened = fakeWindow(true);
  const calls = fakeFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }));

  assert.equal(await openExternalUrl("https://example.com/artikel"), "");
  assert.deepEqual(opened, []);
  assert.deepEqual(calls, [{
    url: "/api/local/browser/open-link",
    body: { url: "https://example.com/artikel" },
  }]);
});

test("a link that cannot be opened says so instead of failing silently", async () => {
  fakeWindow(true);
  fakeFetch(new Response(JSON.stringify({ error: "Der Mac konnte die Adresse nicht öffnen." }), { status: 500 }));
  assert.equal(await openExternalUrl("https://example.com"), "Der Mac konnte die Adresse nicht öffnen.");

  fakeFetch(new Error("offline"));
  assert.equal(await openExternalUrl("https://example.com"), "Der Link ließ sich nicht öffnen.");

  // An entry without an address never reaches the action layer at all.
  const calls = fakeFetch(new Response("{}", { status: 200 }));
  assert.equal(await openExternalUrl("   "), "Zu diesem Eintrag gibt es keine Adresse.");
  assert.deepEqual(calls, []);
});
