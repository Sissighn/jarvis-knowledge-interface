/** Opens the local SQLite index with safe defaults and applied migrations. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "./migrations";

export type KnowledgeDatabase = DatabaseSync;

export function openKnowledgeDatabase(path: string): KnowledgeDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA synchronous = NORMAL");
  applyMigrations(database);
  database.exec("PRAGMA optimize");
  return database;
}

export function closeKnowledgeDatabase(database: KnowledgeDatabase) {
  try {
    database.exec("PRAGMA optimize");
  } catch {
    // An optimisation hint must never block shutdown.
  }
  database.close();
}
