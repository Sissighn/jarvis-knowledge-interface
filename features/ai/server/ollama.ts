/** Server-only Ollama client for grounded local answer generation. */
import type { GeneratedAnswer, LocalModelStatus, ModelContext } from "../types";

type OllamaTagsResponse = {
  models?: Array<{ name?: string; model?: string }>;
};

type OllamaChatResponse = {
  model?: string;
  message?: { content?: string };
};

type StructuredAnswer = {
  answer?: unknown;
  citations?: unknown;
  sufficientContext?: unknown;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen3.5:4b";
const STATUS_TIMEOUT_MS = 2_500;
const GENERATION_TIMEOUT_MS = 90_000;

export class LocalModelError extends Error {
  code: "offline" | "model_missing" | "timeout" | "invalid_response";

  constructor(message: string, code: LocalModelError["code"]) {
    super(message);
    this.name = "LocalModelError";
    this.code = code;
  }
}

function configuration() {
  return {
    baseUrl: (process.env.OLLAMA_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, ""),
    model: process.env.OLLAMA_MODEL?.trim() || DEFAULT_MODEL,
  };
}

async function ollamaRequest<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const { baseUrl } = configuration();

  try {
    const response = await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal, cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const message = typeof payload.error === "string" ? payload.error : `Ollama antwortet mit HTTP ${response.status}.`;
      const missing = response.status === 404 || /model.*not found/i.test(message);
      throw new LocalModelError(
        missing ? "Das konfigurierte Ollama-Modell ist noch nicht installiert." : message,
        missing ? "model_missing" : "offline",
      );
    }
    return payload as T;
  } catch (error) {
    if (error instanceof LocalModelError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new LocalModelError("Das lokale Modell hat zu lange gebraucht.", "timeout");
    }
    throw new LocalModelError("Ollama ist auf diesem Mac momentan nicht erreichbar.", "offline");
  } finally {
    clearTimeout(timeout);
  }
}

function modelMatches(installed: string, configured: string) {
  return installed === configured
    || installed === `${configured}:latest`
    || `${installed}:latest` === configured;
}

export async function getLocalModelStatus(): Promise<LocalModelStatus> {
  const { model } = configuration();
  try {
    const payload = await ollamaRequest<OllamaTagsResponse>("/api/tags", { method: "GET" }, STATUS_TIMEOUT_MS);
    const installedModels = (payload.models ?? []).flatMap((entry) => [entry.name, entry.model]).filter(Boolean) as string[];
    return {
      provider: "ollama",
      configured: true,
      connected: true,
      model,
      modelAvailable: installedModels.some((installed) => modelMatches(installed, model)),
    };
  } catch (error) {
    return {
      provider: "ollama",
      configured: true,
      connected: false,
      model,
      modelAvailable: false,
      error: error instanceof Error ? error.message : "Ollama ist nicht erreichbar.",
    };
  }
}

function cleanContext(contexts: ModelContext[]) {
  return contexts.slice(0, 5).map((context, index) => ({
    index: index + 1,
    nodeId: context.nodeId.slice(0, 120),
    label: context.label.replace(/\s+/g, " ").trim().slice(0, 180),
    group: context.group.replace(/\s+/g, " ").trim().slice(0, 120),
    content: context.content.replace(/\s+/g, " ").trim().slice(0, 3_600),
  })).filter((context) => context.content.length >= 18);
}

function citationMarkers(value: string, sourceCount: number) {
  return [...new Set([...value.matchAll(/\[(\d+)\]/g)]
    .map((match) => Number(match[1]))
    .filter((citation) => Number.isInteger(citation) && citation >= 1 && citation <= sourceCount))];
}

export function parseStructuredAnswer(raw: string, sourceCount: number, model: string): GeneratedAnswer {
  let parsed: StructuredAnswer;
  try {
    parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, "")) as StructuredAnswer;
  } catch {
    throw new LocalModelError("Das lokale Modell hat kein gültiges Antwortformat geliefert.", "invalid_response");
  }

  let answer = typeof parsed.answer === "string" ? parsed.answer.replace(/\s+/g, " ").trim().slice(0, 2_500) : "";
  const structuredCitations = Array.isArray(parsed.citations)
    ? [...new Set(parsed.citations
      .map((value) => typeof value === "string" ? Number(value) : value)
      .filter((value): value is number => Number.isInteger(value) && value >= 1 && value <= sourceCount))]
    : [];
  const markers = citationMarkers(answer, sourceCount);
  let citations = [...new Set([...structuredCitations, ...markers])];
  const grounded = parsed.sufficientContext === true && citations.length > 0;
  if (!answer) throw new LocalModelError("Das lokale Modell hat keine Antwort geliefert.", "invalid_response");

  if (grounded && markers.length) {
    const citedSentences = answer
      .split(/(?<=[.!?])\s+/u)
      .filter((sentence) => citationMarkers(sentence, sourceCount).length > 0);
    answer = citedSentences.join(" ");
    citations = citationMarkers(answer, sourceCount);
  } else if (grounded) {
    answer = `${answer} ${citations.map((citation) => `[${citation}]`).join(" ")}`;
  }
  return { provider: "ollama", model, answer, citations, grounded };
}

export async function generateGroundedAnswer(query: string, contexts: ModelContext[]): Promise<GeneratedAnswer> {
  const { model } = configuration();
  const sources = cleanContext(contexts);
  if (!sources.length) {
    return {
      provider: "ollama",
      model,
      answer: "Die gefundenen Notion-Seiten enthalten nicht genug ausgelesenen Text für eine belastbare Antwort.",
      citations: [],
      grounded: false,
    };
  }

  const sourceText = sources.map((source) => [
    `[${source.index}] ${source.label}`,
    `Bereich: ${source.group}`,
    `Inhalt: ${source.content}`,
  ].join("\n")).join("\n\n");
  const response = await ollamaRequest<OllamaChatResponse>("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      keep_alive: "10m",
      format: {
        type: "object",
        properties: {
          answer: { type: "string" },
          citations: { type: "array", items: { type: "integer" } },
          sufficientContext: { type: "boolean" },
        },
        required: ["answer", "citations", "sufficientContext"],
      },
      options: { temperature: 0.15, num_ctx: 8192, num_predict: 420 },
      messages: [
        {
          role: "system",
          content: [
            "Du bist JARVIS, ein präziser Assistent für ein persönliches Notion-Wissensarchiv.",
            "Beantworte die Frage auf Deutsch, klar und direkt in zwei bis fünf Sätzen.",
            "Verwende ausschließlich Fakten aus den nummerierten Quellen. Nutze kein externes Wissen.",
            "Jede inhaltliche Aussage muss sich wortsinngemäß in mindestens einer Quelle wiederfinden; ergänze auch kein plausibles Allgemeinwissen.",
            "Setze nach belegten Aussagen Quellenmarker wie [1] oder [2].",
            "Jeder Satz mit einer inhaltlichen Aussage muss mindestens einen Quellenmarker enthalten; Sätze ohne Quellenmarker werden verworfen.",
            "Wenn die Quellen nicht reichen, sage das ehrlich und setze sufficientContext auf false.",
            "Wiederhole keine Überschriften und erkläre Fachbegriffe verständlich.",
          ].join(" "),
        },
        {
          role: "user",
          content: `Frage: ${query.replace(/\s+/g, " ").trim().slice(0, 500)}\n\nQuellen:\n${sourceText}`,
        },
      ],
    }),
  }, GENERATION_TIMEOUT_MS);

  return parseStructuredAnswer(response.message?.content ?? "", sources.length, response.model || model);
}
