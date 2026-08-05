/** Numbered, idempotent schema migrations for the local knowledge index. */
import type { DatabaseSync } from "node:sqlite";

export type Migration = {
  version: number;
  name: string;
  statements: string[];
};

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "concept_index",
    statements: [
      `CREATE TABLE IF NOT EXISTS selected_roots (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        parent_title TEXT,
        url TEXT,
        last_edited_time TEXT,
        selected INTEGER NOT NULL DEFAULT 1,
        needs_reindex INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS notion_sources (
        id TEXT PRIMARY KEY,
        object_type TEXT NOT NULL,
        title TEXT NOT NULL,
        root_id TEXT NOT NULL,
        root_title TEXT NOT NULL,
        parent_path TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        last_edited_time TEXT,
        content_hash TEXT,
        indexed_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        unsupported_blocks INTEGER NOT NULL DEFAULT 0,
        concepts_pending INTEGER NOT NULL DEFAULT 1
      )`,
      "CREATE INDEX IF NOT EXISTS notion_sources_root ON notion_sources (root_id)",
      "CREATE INDEX IF NOT EXISTS notion_sources_status ON notion_sources (status)",
      `CREATE TABLE IF NOT EXISTS content_chunks (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES notion_sources (id) ON DELETE CASCADE,
        block_id TEXT,
        heading_path TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        position INTEGER NOT NULL,
        hash TEXT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS content_chunks_source ON content_chunks (source_id, position)",
      `CREATE TABLE IF NOT EXISTS concepts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        normalized TEXT NOT NULL UNIQUE,
        aliases TEXT NOT NULL DEFAULT '[]',
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'Allgemein',
        importance REAL NOT NULL DEFAULT 0.5,
        last_seen_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS concept_occurrences (
        concept_id TEXT NOT NULL REFERENCES concepts (id) ON DELETE CASCADE,
        chunk_id TEXT NOT NULL REFERENCES content_chunks (id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        snippet TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0.5,
        PRIMARY KEY (concept_id, chunk_id)
      )`,
      "CREATE INDEX IF NOT EXISTS concept_occurrences_chunk ON concept_occurrences (chunk_id)",
      "CREATE INDEX IF NOT EXISTS concept_occurrences_source ON concept_occurrences (source_id)",
      `CREATE TABLE IF NOT EXISTS concept_relations (
        source_concept_id TEXT NOT NULL REFERENCES concepts (id) ON DELETE CASCADE,
        target_concept_id TEXT NOT NULL REFERENCES concepts (id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0,
        reason TEXT NOT NULL DEFAULT '',
        evidence_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_concept_id, target_concept_id, type)
      )`,
      `CREATE TABLE IF NOT EXISTS model_relation_candidates (
        source_concept_id TEXT NOT NULL,
        target_concept_id TEXT NOT NULL,
        type TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        chunk_id TEXT NOT NULL REFERENCES content_chunks (id) ON DELETE CASCADE,
        PRIMARY KEY (source_concept_id, target_concept_id, type, chunk_id)
      )`,
      `CREATE TABLE IF NOT EXISTS embeddings (
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        model TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        vector BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_type, owner_id, model)
      )`,
      `CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        processed_sources INTEGER NOT NULL DEFAULT 0,
        total_sources INTEGER NOT NULL DEFAULT 0,
        current_source TEXT,
        error TEXT,
        graph_version INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5 (
        chunk_id UNINDEXED,
        text,
        heading_path,
        tokenize = 'unicode61 remove_diacritics 2'
      )`,
    ],
  },
  {
    // Canonical areas replace the raw root selection; existing index data is kept.
    version: 2,
    name: "canonical_areas_and_checkpoints",
    statements: [
      `CREATE TABLE IF NOT EXISTS knowledge_areas (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        original_title TEXT,
        label_source TEXT NOT NULL DEFAULT 'notion',
        ai_title TEXT,
        content_count INTEGER NOT NULL DEFAULT 0,
        sample_titles TEXT NOT NULL DEFAULT '[]',
        selected INTEGER NOT NULL DEFAULT 0,
        recommended INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS area_scopes (
        area_id TEXT NOT NULL REFERENCES knowledge_areas (id) ON DELETE CASCADE,
        scope_id TEXT NOT NULL,
        PRIMARY KEY (area_id, scope_id)
      )`,
      "CREATE INDEX IF NOT EXISTS area_scopes_scope ON area_scopes (scope_id)",
      `CREATE TABLE IF NOT EXISTS extraction_checkpoints (
        source_id TEXT PRIMARY KEY REFERENCES notion_sources (id) ON DELETE CASCADE,
        completed_batches INTEGER NOT NULL DEFAULT 0,
        total_batches INTEGER NOT NULL DEFAULT 0,
        failed_batches TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 3,
    name: "notion_databases_fast_index",
    statements: [
      `CREATE TABLE IF NOT EXISTS notion_databases (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        original_title TEXT,
        icon TEXT,
        parent_id TEXT,
        parent_title TEXT,
        url TEXT,
        content_count INTEGER NOT NULL DEFAULT 0,
        selected INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS notion_data_sources (
        id TEXT PRIMARY KEY,
        database_id TEXT NOT NULL REFERENCES notion_databases (id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '',
        last_seen_at TEXT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_notion_data_sources_database_id ON notion_data_sources (database_id)",
      "ALTER TABLE notion_sources ADD COLUMN database_id TEXT",
      "ALTER TABLE notion_sources ADD COLUMN icon TEXT",
      "ALTER TABLE notion_sources ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE notion_sources ADD COLUMN relation_ids_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE notion_sources ADD COLUMN mention_ids_json TEXT NOT NULL DEFAULT '[]'",
      "CREATE INDEX IF NOT EXISTS idx_notion_sources_database_status ON notion_sources (database_id, status)",
      `CREATE TABLE IF NOT EXISTS source_links (
        source_id TEXT NOT NULL REFERENCES notion_sources (id) ON DELETE CASCADE,
        target_source_id TEXT NOT NULL,
        type TEXT NOT NULL,
        property_name TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (source_id, target_source_id, type, property_name)
      )`,
      "CREATE INDEX IF NOT EXISTS idx_source_links_target ON source_links (target_source_id)",
      `CREATE TABLE IF NOT EXISTS relation_evidence (
        source_concept_id TEXT NOT NULL,
        target_concept_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        chunk_id TEXT,
        snippet TEXT NOT NULL DEFAULT '',
        notion_url TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (source_concept_id, target_concept_id, relation_type, source_id, chunk_id)
      )`,
      "CREATE INDEX IF NOT EXISTS idx_relation_evidence_pair ON relation_evidence (source_concept_id, target_concept_id, relation_type)",
      "ALTER TABLE sync_runs ADD COLUMN current_database_id TEXT",
      "ALTER TABLE sync_runs ADD COLUMN processed_databases INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sync_runs ADD COLUMN total_databases INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sync_runs ADD COLUMN failed_sources INTEGER NOT NULL DEFAULT 0",
    ],
  },
];

export function applyMigrations(database: DatabaseSync) {
  database.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(
    database.prepare("SELECT version FROM schema_version").all().map((row) => Number((row as { version: number }).version)),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    database.exec("BEGIN");
    try {
      for (const statement of migration.statements) database.exec(statement);
      database
        .prepare("INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)")
        .run(migration.version, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  return MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
}
