/** Local Ollama access for embeddings and structured concept extraction. */
import { chatModel, embeddingModel, ollamaBaseUrl } from "../config";

const STATUS_TIMEOUT_MS = 2_500;
const EMBED_TIMEOUT_MS = 120_000;
const CHAT_TIMEOUT_MS = 180_000;

export class OllamaError extends Error {
  code: "offline" | "model_missing" | "timeout" | "invalid_response";

  constructor(message: string, code: OllamaError["code"]) {
    super(message);
    this.name = "OllamaError";
    this.code = code;
  }
}

export class OllamaAbortError extends Error {
  constructor() {
    super("Der lokale Modellaufruf wurde abgebrochen.");
    this.name = "OllamaAbortError";
  }
}

/** Cancelling a sync must also stop the running generation, not just the loop. */
async function ollamaFetch(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal) {
  if (signal?.aborted) throw new OllamaAbortError();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    return await fetch(`${ollamaBaseUrl()}${path}`, { ...init, signal: controller.signal, cache: "no-store" });
  } catch (error) {
    if (signal?.aborted) throw new OllamaAbortError();
    if (error instanceof Error && error.name === "AbortError") {
      throw new OllamaError("Das lokale Modell hat zu lange gebraucht.", "timeout");
    }
    throw new OllamaError("Ollama ist auf diesem Mac momentan nicht erreichbar.", "offline");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

async function ollamaJson<T>(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const response = await ollamaFetch(path, init, timeoutMs, signal);
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : `Ollama antwortet mit HTTP ${response.status}.`;
    const missing = response.status === 404 || /model.*not found/iu.test(message);
    throw new OllamaError(
      missing ? "Das konfigurierte Ollama-Modell ist noch nicht installiert." : message,
      missing ? "model_missing" : "offline",
    );
  }
  return payload as T;
}

function modelMatches(installed: string, configured: string) {
  return installed === configured
    || installed === `${configured}:latest`
    || `${installed}:latest` === configured;
}

export async function installedModels() {
  const payload = await ollamaJson<{ models?: Array<{ name?: string; model?: string }> }>(
    "/api/tags",
    { method: "GET" },
    STATUS_TIMEOUT_MS,
  );
  return (payload.models ?? []).flatMap((entry) => [entry.name, entry.model])
    .filter((value): value is string => Boolean(value));
}

export async function modelAvailability() {
  const chat = chatModel();
  const embedding = embeddingModel();
  try {
    const installed = await installedModels();
    return {
      connected: true,
      chatModel: chat,
      chatModelAvailable: installed.some((entry) => modelMatches(entry, chat)),
      embeddingModel: embedding,
      embeddingModelAvailable: installed.some((entry) => modelMatches(entry, embedding)),
      error: null as string | null,
    };
  } catch (error) {
    return {
      connected: false,
      chatModel: chat,
      chatModelAvailable: false,
      embeddingModel: embedding,
      embeddingModelAvailable: false,
      error: error instanceof Error ? error.message : "Ollama ist nicht erreichbar.",
    };
  }
}

/** Embeds a batch of texts in one call; the returned dimension is stored dynamically. */
export async function embedTexts(texts: string[], model = embeddingModel(), signal?: AbortSignal) {
  if (!texts.length) return [] as Float32Array[];
  const payload = await ollamaJson<{ embeddings?: number[][] }>("/api/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts, truncate: true, keep_alive: "10m" }),
  }, EMBED_TIMEOUT_MS, signal);

  const embeddings = payload.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    throw new OllamaError("Das Embedding-Modell hat kein verwertbares Ergebnis geliefert.", "invalid_response");
  }
  return embeddings.map((vector) => Float32Array.from(vector));
}

export type PullProgress = { status: string; percent: number | null };

/**
 * Pulls exactly the configured embedding model. The model name never comes from
 * the request body, so the UI cannot trigger arbitrary downloads.
 */
export async function pullEmbeddingModel(onProgress: (progress: PullProgress) => void) {
  const response = await ollamaFetch("/api/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: embeddingModel(), stream: true }),
  }, CHAT_TIMEOUT_MS);

  if (!response.ok || !response.body) {
    throw new OllamaError("Das Embedding-Modell konnte nicht geladen werden.", "offline");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
        if (event.error) throw new OllamaError(event.error, "offline");
        const percent = event.total ? Math.round(((event.completed ?? 0) / event.total) * 100) : null;
        onProgress({ status: event.status ?? "lädt", percent });
      } catch (error) {
        if (error instanceof OllamaError) throw error;
      }
    }
  }
}

export type ChatMessage = { role: "system" | "user"; content: string };

export async function chatWithSchema<T>(
  messages: ChatMessage[],
  schema: Record<string, unknown>,
  options: { model?: string; numPredict?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const { model = chatModel(), numPredict = 900, signal } = options;
  const payload = await ollamaJson<{ message?: { content?: string } }>("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      keep_alive: "10m",
      format: schema,
      options: { temperature: 0.1, num_ctx: 8192, num_predict: numPredict },
      messages,
    }),
  }, CHAT_TIMEOUT_MS, signal);

  const content = payload.message?.content ?? "";
  try {
    return JSON.parse(content.replace(/^```json\s*|\s*```$/gu, "")) as T;
  } catch {
    throw new OllamaError("Das lokale Modell hat kein gültiges JSON geliefert.", "invalid_response");
  }
}
