/** Local-only runtime configuration for the knowledge indexer. */
import { homedir } from "node:os";
import { resolve } from "node:path";

export const DEFAULT_INDEXER_PORT = 4318;
export const DATABASE_FILE_NAME = "knowledge-index.sqlite3";
export const DEV_DATABASE_DIRECTORY = ".jarvis-dev";
export const PRODUCTION_DIRECTORY_NAME = "com.sissighn.jarvis";

export function indexerPort() {
  const configured = Number(process.env.JARVIS_INDEXER_PORT);
  return Number.isInteger(configured) && configured > 0 && configured <= 65535
    ? configured
    : DEFAULT_INDEXER_PORT;
}

/**
 * Production stores the index next to the other desktop application data, development
 * keeps it inside the ignored project folder. The index never leaves this Mac.
 */
export function databaseDirectory() {
  const configured = process.env.JARVIS_CONFIG_DIR?.trim();
  if (configured) return resolve(configured);
  if (process.env.JARVIS_INDEX_DIR?.trim()) return resolve(process.env.JARVIS_INDEX_DIR.trim());
  if (process.env.NODE_ENV === "production") {
    return resolve(homedir(), "Library/Application Support", PRODUCTION_DIRECTORY_NAME);
  }
  return resolve(process.cwd(), DEV_DATABASE_DIRECTORY);
}

export function databasePath() {
  return resolve(databaseDirectory(), DATABASE_FILE_NAME);
}

export function notionToken() {
  return process.env.NOTION_ACCESS_TOKEN?.trim() ?? "";
}

export function ollamaBaseUrl() {
  return (process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434").replace(/\/$/, "");
}

export function chatModel() {
  return process.env.OLLAMA_MODEL?.trim() || "qwen3.5:4b";
}

export function embeddingModel() {
  return process.env.OLLAMA_EMBEDDING_MODEL?.trim() || "embeddinggemma";
}

/** Recommended defaults; the user still confirms the final selection. */
export const RECOMMENDED_ROOT_TITLES = ["knowledge", "courses"];
