import assert from "node:assert/strict";
import test from "node:test";
import { resumeAssistantTurn, startAssistantTurn } from "../../features/assistant/client/run-assistant";
import type { AssistantChatResponse } from "../../features/assistant/types";

type FetchCall = { url: string; body: unknown };

const WEATHER = {
  location: "Regensburg",
  updatedAt: "2026-08-05T10:00:00Z",
  current: { temperature: 21.4, apparentTemperature: 20.2, weatherCode: 3, label: "bewölkt", symbol: "☁", windSpeed: 9 },
  today: { max: 24.1, min: 13.6, rainChance: 30 },
  forecast: [{ date: "2026-08-05", weatherCode: 3, label: "bewölkt", symbol: "☁", max: 24.1, min: 13.6, rainChance: 30 }],
  attribution: { label: "Open-Meteo", url: "https://open-meteo.com/" },
};

/** Replaces fetch with a scripted model plus real-looking dashboard and action answers. */
function withFetch(replies: AssistantChatResponse[], localResponse?: { status: number; payload: unknown }) {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  let chatIndex = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    calls.push({ url, body });

    if (url === "/api/assistant/chat") {
      const reply = replies[Math.min(chatIndex, replies.length - 1)];
      chatIndex += 1;
      return new Response(JSON.stringify(reply), { status: 200 });
    }
    if (url.startsWith("/api/weather")) return new Response(JSON.stringify(WEATHER), { status: 200 });
    if (url.startsWith("/api/local/")) {
      const local = localResponse ?? { status: 200, payload: { ok: true, summary: "Erledigt." } };
      return new Response(JSON.stringify(local.payload), { status: local.status });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  }) as typeof fetch;

  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

test("runs a dashboard tool and speaks the model's final sentence", async () => {
  const { calls, restore } = withFetch([
    { model: "qwen3.5:4b", content: "", toolCalls: [{ name: "get_temperature", arguments: {} }] },
    { model: "qwen3.5:4b", content: "In Regensburg sind es 21 Grad bei bewölktem Himmel.", toolCalls: [] },
  ]);

  try {
    const turn = await startAssistantTurn([], "Wie warm ist es gerade?");

    assert.equal(turn.pending, null);
    assert.equal(turn.text, "In Regensburg sind es 21 Grad bei bewölktem Himmel.");
    assert.deepEqual(turn.steps.map((step) => [step.name, step.ok]), [["get_temperature", true]]);
    assert.match(turn.steps[0].content, /21 Grad/u);
    assert.ok(calls.some((call) => call.url.startsWith("/api/weather")));

    // The tool result has to travel back to the model as a tool message.
    const lastChat = calls.filter((call) => call.url === "/api/assistant/chat").at(-1) as
      { body: { messages: Array<{ role: string; tool_name?: string }> } };
    const toolMessage = lastChat.body.messages.find((message) => message.role === "tool");
    assert.equal(toolMessage?.tool_name, "get_temperature");
  } finally {
    restore();
  }
});

test("stops before an irreversible action and asks the confirmation question", async () => {
  const { calls, restore } = withFetch([
    { model: "qwen3.5:4b", content: "", toolCalls: [{ name: "mac_empty_trash", arguments: {} }] },
  ]);

  try {
    const turn = await startAssistantTurn([], "Leere bitte den Papierkorb.");

    assert.equal(turn.pending?.name, "mac_empty_trash");
    assert.equal(turn.text, "Der Papierkorb wird endgültig geleert. Fortfahren?");
    assert.deepEqual(turn.steps, []);
    assert.equal(calls.some((call) => call.url.startsWith("/api/local/")), false);
  } finally {
    restore();
  }
});

test("a declined confirmation changes nothing on this Mac", async () => {
  const { calls, restore } = withFetch([
    { model: "qwen3.5:4b", content: "", toolCalls: [{ name: "mac_empty_trash", arguments: {} }] },
  ]);

  try {
    const pendingTurn = await startAssistantTurn([], "Leere den Papierkorb.");
    const declined = await resumeAssistantTurn(pendingTurn, false);

    assert.equal(declined.pending, null);
    assert.equal(declined.text, "Alles klar, ich habe nichts verändert.");
    assert.deepEqual(declined.steps.map((step) => step.ok), [false]);
    assert.equal(calls.some((call) => call.url.startsWith("/api/local/")), false);
  } finally {
    restore();
  }
});

test("an approved confirmation sends the explicit flag to the action layer", async () => {
  const { calls, restore } = withFetch(
    [
      { model: "qwen3.5:4b", content: "", toolCalls: [{ name: "mac_empty_trash", arguments: {} }] },
      { model: "qwen3.5:4b", content: "Der Papierkorb ist jetzt leer.", toolCalls: [] },
    ],
    { status: 200, payload: { ok: true, summary: "Der Papierkorb ist geleert, 3 Objekte wurden entfernt." } },
  );

  try {
    const pendingTurn = await startAssistantTurn([], "Leere den Papierkorb.");
    const approved = await resumeAssistantTurn(pendingTurn, true);

    assert.equal(approved.pending, null);
    // What actually happened is spoken verbatim, not a paraphrase the model might distort.
    assert.equal(approved.text, "Der Papierkorb ist geleert, 3 Objekte wurden entfernt.");
    const localCall = calls.find((call) => call.url === "/api/local/mac/empty-trash");
    assert.deepEqual(localCall?.body, { confirmed: true });
  } finally {
    restore();
  }
});

test("an action result is spoken exactly as the action layer reported it", async () => {
  const { calls, restore } = withFetch(
    [
      { model: "qwen3.5:4b", content: "", toolCalls: [{ name: "mac_change_volume", arguments: { direction: "down" } }] },
      { model: "qwen3.5:4b", content: "Der Mac ist jetzt lauter, 85 Prozent.", toolCalls: [] },
    ],
    { status: 200, payload: { ok: true, summary: "Die Systemlautstärke steht jetzt auf 30 Prozent." } },
  );

  try {
    const turn = await startAssistantTurn([], "Mach den Mac leiser.");

    assert.equal(turn.text, "Die Systemlautstärke steht jetzt auf 30 Prozent.");
    // No second model round happens, so the model cannot invent a different number.
    assert.equal(calls.filter((call) => call.url === "/api/assistant/chat").length, 1);
  } finally {
    restore();
  }
});

test("a failing action becomes an honest spoken answer instead of a silent turn", async () => {
  const { restore } = withFetch(
    [
      { model: "qwen3.5:4b", content: "", toolCalls: [{ name: "spotify_pause", arguments: {} }] },
      { model: "qwen3.5:4b", content: "", toolCalls: [] },
    ],
    { status: 403, payload: { error: "Dafür braucht Spotify ein Premium-Konto." } },
  );

  try {
    const turn = await startAssistantTurn([], "Pausiere die Musik.");

    assert.equal(turn.steps[0].ok, false);
    assert.equal(turn.text, "Dafür braucht Spotify ein Premium-Konto.");
  } finally {
    restore();
  }
});

test("an unknown tool name never reaches an executor", async () => {
  const { calls, restore } = withFetch([
    { model: "qwen3.5:4b", content: "", toolCalls: [{ name: "delete_everything", arguments: {} }] },
    { model: "qwen3.5:4b", content: "Das kann ich nicht.", toolCalls: [] },
  ]);

  try {
    const turn = await startAssistantTurn([], "Lösch alles.");

    assert.deepEqual(turn.steps.map((step) => step.ok), [false]);
    assert.equal(turn.steps[0].content, "Dieses Werkzeug gibt es nicht.");
    assert.equal(calls.some((call) => call.url.startsWith("/api/local/")), false);
  } finally {
    restore();
  }
});
