/** Server-only Notion connection layer. Content indexing lives in the local indexer. */

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

type JsonRecord = Record<string, unknown>;

export class NotionConnectionError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 500, code?: string) {
    super(message);
    this.name = "NotionConnectionError";
    this.status = status;
    this.code = code;
  }
}

let requestQueue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

function getAccessToken() {
  return process.env.NOTION_ACCESS_TOKEN?.trim() ?? "";
}

export function isNotionConfigured() {
  return Boolean(getAccessToken());
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function takeRateLimitTurn() {
  const previous = requestQueue;
  let release = () => {};
  requestQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < 340) await wait(340 - elapsed);
  lastRequestAt = Date.now();
  release();
}

export async function notionRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAccessToken();
  if (!token) {
    throw new NotionConnectionError("Notion ist noch nicht lokal konfiguriert.", 503, "not_configured");
  }

  await takeRateLimitTurn();
  const response = await fetch(`${NOTION_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  const payload = await response.json().catch(() => ({})) as JsonRecord;
  if (!response.ok) {
    const message = typeof payload.message === "string"
      ? payload.message
      : "Notion konnte die Anfrage nicht verarbeiten.";
    const code = typeof payload.code === "string" ? payload.code : undefined;
    throw new NotionConnectionError(message, response.status, code);
  }
  return payload as T;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function getNotionConnectionStatus() {
  if (!isNotionConfigured()) return { configured: false, connected: false };

  const user = await notionRequest<JsonRecord>("/users/me");
  const bot = isRecord(user.bot) ? user.bot : null;
  return {
    configured: true,
    connected: true,
    botName: stringValue(user.name) || "Jarvis",
    workspaceName: stringValue(bot?.workspace_name) || null,
  };
}
