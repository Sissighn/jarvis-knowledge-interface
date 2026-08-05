/** Typed access to the local knowledge index. All writes stay on this Mac. */
import type { ContentChunk } from "@/features/knowledge/chunking";
import type {
  ConceptEdge,
  ConceptOccurrence,
  ConceptRelationType,
  KnowledgeArea,
  KnowledgeCoverage,
  KnowledgeRoot,
  NotionKnowledgeDatabase,
  RelationEvidence,
  SyncPhase,
} from "@/features/knowledge/types";
import type { KnowledgeDatabase } from "./database";

export type SourceRecord = {
  id: string;
  objectType: "page" | "data_source";
  title: string;
  rootId: string;
  rootTitle: string;
  parentPath: string;
  url: string;
  lastEditedTime: string | null;
  databaseId?: string | null;
  icon?: string | null;
  tags?: string[];
  relationIds?: string[];
  mentionIds?: string[];
};

export type StoredSource = SourceRecord & {
  contentHash: string | null;
  indexedAt: string | null;
  status: string;
  conceptsPending: boolean;
};

export type StoredChunk = {
  id: string;
  sourceId: string;
  blockId: string | null;
  headingPath: string;
  text: string;
  position: number;
  sourceTitle: string;
  rootTitle: string;
  url: string;
  databaseId?: string;
};

export type ConceptRecord = {
  id: string;
  label: string;
  normalized: string;
  aliases: string[];
  description: string;
  category: string;
  importance: number;
  lastSeenAt: string;
  sourceCount: number;
  occurrenceCount: number;
  notionUrl: string | null;
};

export type OccurrenceRecord = {
  conceptId: string;
  chunkId: string;
  sourceId: string;
  snippet: string;
  confidence: number;
};

export type SyncRunRecord = {
  id: number;
  status: string;
  phase: SyncPhase;
  processedSources: number;
  totalSources: number;
  currentSource: string | null;
  error: string | null;
  graphVersion: number;
  startedAt: string;
  finishedAt: string | null;
  currentDatabaseId: string | null;
  processedDatabases: number;
  totalDatabases: number;
  failedSources: number;
};

type Row = Record<string, unknown>;

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function optionalText(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : fallback;
}

function parseAliases(value: unknown) {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseNumberList(value: unknown) {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number).filter((entry) => Number.isFinite(entry)) : [];
  } catch {
    return [];
  }
}

export function vectorToBlob(vector: number[] | Float32Array) {
  const floats = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return new Uint8Array(floats.buffer.slice(0));
}

export function blobToVector(blob: unknown) {
  if (!(blob instanceof Uint8Array)) return new Float32Array();
  return new Float32Array(blob.slice().buffer);
}

export class KnowledgeRepository {
  constructor(private readonly database: KnowledgeDatabase) {}

  transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // A failed rollback must not mask the original error.
      }
      throw error;
    }
  }

  // -- meta -----------------------------------------------------------------

  getMeta(key: string) {
    const row = this.database.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as Row | undefined;
    return row ? text(row.value) : null;
  }

  setMeta(key: string, value: string) {
    this.database
      .prepare("INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  graphVersion() {
    return Number(this.getMeta("graph_version") ?? "0") || 0;
  }

  bumpGraphVersion() {
    const next = this.graphVersion() + 1;
    this.setMeta("graph_version", String(next));
    return next;
  }

  lastSuccessfulSyncAt() {
    return this.getMeta("last_successful_sync_at");
  }

  // -- roots ----------------------------------------------------------------

  listStoredRoots(): KnowledgeRoot[] {
    return (this.database.prepare("SELECT * FROM selected_roots ORDER BY title COLLATE NOCASE").all() as Row[])
      .map((row) => ({
        id: text(row.id),
        type: text(row.type) === "data_source" ? "data_source" : "page",
        title: text(row.title),
        parentTitle: optionalText(row.parent_title),
        url: optionalText(row.url),
        lastEditedTime: optionalText(row.last_edited_time),
        selected: numberValue(row.selected) === 1,
        recommended: false,
      }));
  }

  selectedRootIds() {
    return (this.database.prepare("SELECT id FROM selected_roots WHERE selected = 1").all() as Row[])
      .map((row) => text(row.id));
  }

  replaceSelectedRoots(roots: Array<Omit<KnowledgeRoot, "recommended" | "selected">>) {
    const now = new Date().toISOString();
    this.transaction(() => {
      const keep = new Set(roots.map((root) => root.id));
      for (const existing of this.listStoredRoots()) {
        if (!keep.has(existing.id)) {
          this.database.prepare("DELETE FROM selected_roots WHERE id = ?").run(existing.id);
        }
      }
      for (const root of roots) {
        this.database.prepare(
          `INSERT INTO selected_roots (id, type, title, parent_title, url, last_edited_time, selected, needs_reindex, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)
           ON CONFLICT (id) DO UPDATE SET
             type = excluded.type,
             title = excluded.title,
             parent_title = excluded.parent_title,
             url = excluded.url,
             last_edited_time = excluded.last_edited_time,
             selected = 1,
             updated_at = excluded.updated_at`,
        ).run(root.id, root.type, root.title, root.parentTitle, root.url, root.lastEditedTime, now);
      }
    });
  }

  /** Content of deselected roots disappears from the index at the next sync. */
  deleteSourcesOutsideRoots(rootIds: string[]) {
    const selected = new Set(rootIds);
    const orphaned = (this.database.prepare("SELECT id, root_id FROM notion_sources").all() as Row[])
      .filter((row) => !selected.has(text(row.root_id)))
      .map((row) => text(row.id));
    if (!orphaned.length) return 0;
    this.transaction(() => {
      for (const id of orphaned) this.deleteSourceInternal(id);
    });
    return orphaned.length;
  }

  // -- canonical areas ------------------------------------------------------

  listAreas(): KnowledgeArea[] {
    const scopes = new Map<string, string[]>();
    for (const row of this.database.prepare("SELECT area_id, scope_id FROM area_scopes").all() as Row[]) {
      const areaId = text(row.area_id);
      scopes.set(areaId, [...(scopes.get(areaId) ?? []), text(row.scope_id)]);
    }
    return (this.database.prepare("SELECT * FROM knowledge_areas").all() as Row[])
      .map((row) => {
        const aiTitle = optionalText(row.ai_title);
        const labelSource = text(row.label_source, "notion") as KnowledgeArea["labelSource"];
        const useAiTitle = labelSource === "fallback" && Boolean(aiTitle);
        return {
          id: text(row.id),
          title: useAiTitle ? (aiTitle as string) : text(row.title),
          originalTitle: optionalText(row.original_title),
          scopeIds: scopes.get(text(row.id)) ?? [],
          contentCount: numberValue(row.content_count),
          sampleTitles: parseAliases(row.sample_titles),
          selected: numberValue(row.selected) === 1,
          recommended: numberValue(row.recommended) === 1,
          labelSource: useAiTitle ? "local_ai" : labelSource,
        };
      })
      .sort((left, right) => right.contentCount - left.contentCount
        || left.title.localeCompare(right.title, "de"));
  }

  selectedAreaIds() {
    return (this.database.prepare("SELECT id FROM knowledge_areas WHERE selected = 1").all() as Row[])
      .map((row) => text(row.id));
  }

  /** Refreshes the discovered areas while keeping the selection and cached AI names. */
  replaceAreas(areas: Array<Omit<KnowledgeArea, "selected">>) {
    const now = new Date().toISOString();
    this.transaction(() => {
      const keep = new Set(areas.map((area) => area.id));
      for (const existing of this.database.prepare("SELECT id FROM knowledge_areas").all() as Row[]) {
        if (!keep.has(text(existing.id))) {
          this.database.prepare("DELETE FROM knowledge_areas WHERE id = ?").run(text(existing.id));
        }
      }
      const upsert = this.database.prepare(
        `INSERT INTO knowledge_areas (
           id, title, original_title, label_source, content_count, sample_titles, selected, recommended, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           title = excluded.title,
           original_title = excluded.original_title,
           label_source = excluded.label_source,
           content_count = excluded.content_count,
           sample_titles = excluded.sample_titles,
           recommended = excluded.recommended,
           updated_at = excluded.updated_at`,
      );
      for (const area of areas) {
        upsert.run(
          area.id,
          area.title,
          area.originalTitle,
          area.labelSource,
          area.contentCount,
          JSON.stringify(area.sampleTitles),
          area.recommended ? 1 : 0,
          now,
        );
        this.database.prepare("DELETE FROM area_scopes WHERE area_id = ?").run(area.id);
        const insertScope = this.database.prepare(
          "INSERT OR IGNORE INTO area_scopes (area_id, scope_id) VALUES (?, ?)",
        );
        for (const scopeId of area.scopeIds) insertScope.run(area.id, scopeId);
      }
    });
  }

  /** Selection is disjoint by construction: only canonical area ids are stored. */
  setSelectedAreas(areaIds: string[]) {
    const wanted = new Set(areaIds);
    this.transaction(() => {
      this.database.exec("UPDATE knowledge_areas SET selected = 0");
      const select = this.database.prepare("UPDATE knowledge_areas SET selected = 1 WHERE id = ?");
      for (const id of wanted) select.run(id);
    });
    const version = Number(this.getMeta("selection_version") ?? "0") + 1;
    this.setMeta("selection_version", String(version));
    return version;
  }

  selectionVersion() {
    return Number(this.getMeta("selection_version") ?? "0") || 0;
  }

  saveAreaAiTitle(areaId: string, title: string) {
    this.database.prepare("UPDATE knowledge_areas SET ai_title = ? WHERE id = ?").run(title, areaId);
  }

  areasWithoutName() {
    return (this.database.prepare(
      "SELECT * FROM knowledge_areas WHERE label_source = 'fallback' AND (ai_title IS NULL OR ai_title = '')",
    ).all() as Row[]).map((row) => ({
      id: text(row.id),
      sampleTitles: parseAliases(row.sample_titles),
    }));
  }

  // -- concrete Notion databases ------------------------------------------

  listDatabases(): NotionKnowledgeDatabase[] {
    const sources = new Map<string, string[]>();
    for (const row of this.database.prepare("SELECT id, database_id FROM notion_data_sources").all() as Row[]) {
      const databaseId = text(row.database_id);
      sources.set(databaseId, [...(sources.get(databaseId) ?? []), text(row.id)]);
    }
    return (this.database.prepare("SELECT * FROM notion_databases ORDER BY title COLLATE NOCASE").all() as Row[])
      .map((row) => ({
        id: text(row.id),
        dataSourceIds: (sources.get(text(row.id)) ?? []).sort(),
        title: text(row.title),
        originalTitle: optionalText(row.original_title),
        icon: optionalText(row.icon),
        parentId: optionalText(row.parent_id),
        parentTitle: optionalText(row.parent_title),
        url: optionalText(row.url),
        contentCount: numberValue(row.content_count),
        selected: numberValue(row.selected) === 1,
        lastSeenAt: text(row.last_seen_at),
      }));
  }

  selectedDatabaseIds() {
    return (this.database.prepare("SELECT id FROM notion_databases WHERE selected = 1 ORDER BY title COLLATE NOCASE").all() as Row[])
      .map((row) => text(row.id));
  }

  replaceDatabases(databases: NotionKnowledgeDatabase[]) {
    const now = new Date().toISOString();
    this.transaction(() => {
      const upsert = this.database.prepare(
        `INSERT INTO notion_databases (
           id, title, original_title, icon, parent_id, parent_title, url, content_count, selected, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT (id) DO UPDATE SET
           title = excluded.title,
           original_title = excluded.original_title,
           icon = excluded.icon,
           parent_id = excluded.parent_id,
           parent_title = excluded.parent_title,
           url = excluded.url,
           content_count = MAX(notion_databases.content_count, excluded.content_count),
           last_seen_at = excluded.last_seen_at`,
      );
      const upsertSource = this.database.prepare(
        `INSERT INTO notion_data_sources (id, database_id, title, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET database_id = excluded.database_id, title = excluded.title, last_seen_at = excluded.last_seen_at`,
      );
      for (const database of databases) {
        upsert.run(
          database.id,
          database.title,
          database.originalTitle,
          database.icon,
          database.parentId,
          database.parentTitle,
          database.url,
          database.contentCount,
          database.lastSeenAt || now,
        );
        for (const dataSourceId of database.dataSourceIds) upsertSource.run(dataSourceId, database.id, database.originalTitle ?? database.title, now);
      }
    });
  }

  /** One-time bridge from the old area picker: selected data-source scopes map to their database. */
  migrateAreaSelectionToDatabases() {
    if (this.selectedDatabaseIds().length) return this.selectedDatabaseIds();
    const rows = this.database.prepare(
      `SELECT DISTINCT ds.database_id
         FROM knowledge_areas a
         JOIN area_scopes scope ON scope.area_id = a.id
         JOIN notion_data_sources ds ON ds.id = scope.scope_id
        WHERE a.selected = 1`,
    ).all() as Row[];
    const ids = rows.map((row) => text(row.database_id)).filter(Boolean);
    if (ids.length) this.setSelectedDatabases(ids);
    return ids;
  }

  setSelectedDatabases(databaseIds: string[]) {
    const known = new Set(this.listDatabases().map((database) => database.id));
    const wanted = [...new Set(databaseIds)].filter((id) => known.has(id));
    this.transaction(() => {
      this.database.exec("UPDATE notion_databases SET selected = 0");
      const select = this.database.prepare("UPDATE notion_databases SET selected = 1 WHERE id = ?");
      for (const id of wanted) select.run(id);
    });
    const version = this.selectionVersion() + 1;
    this.setMeta("selection_version", String(version));
    return version;
  }

  updateDatabaseContentCount(databaseId: string, contentCount: number) {
    this.database.prepare("UPDATE notion_databases SET content_count = ? WHERE id = ?").run(contentCount, databaseId);
  }

  // -- sources --------------------------------------------------------------

  listSources(): StoredSource[] {
    return (this.database.prepare("SELECT * FROM notion_sources").all() as Row[]).map((row) => ({
      id: text(row.id),
      objectType: text(row.object_type) === "data_source" ? "data_source" : "page",
      title: text(row.title),
      rootId: text(row.root_id),
      rootTitle: text(row.root_title),
      parentPath: text(row.parent_path),
      url: text(row.url),
      lastEditedTime: optionalText(row.last_edited_time),
      contentHash: optionalText(row.content_hash),
      indexedAt: optionalText(row.indexed_at),
      status: text(row.status, "pending"),
      conceptsPending: numberValue(row.concepts_pending) === 1,
      databaseId: optionalText(row.database_id),
      icon: optionalText(row.icon),
      tags: parseAliases(row.tags_json),
      relationIds: parseAliases(row.relation_ids_json),
      mentionIds: parseAliases(row.mention_ids_json),
    }));
  }

  getSource(id: string) {
    return this.listSourcesById([id])[0] ?? null;
  }

  private listSourcesById(ids: string[]) {
    if (!ids.length) return [] as StoredSource[];
    const placeholders = ids.map(() => "?").join(", ");
    return (this.database.prepare(`SELECT * FROM notion_sources WHERE id IN (${placeholders})`).all(...ids) as Row[])
      .map((row) => ({
        id: text(row.id),
        objectType: text(row.object_type) === "data_source" ? "data_source" : "page",
        title: text(row.title),
        rootId: text(row.root_id),
        rootTitle: text(row.root_title),
        parentPath: text(row.parent_path),
        url: text(row.url),
        lastEditedTime: optionalText(row.last_edited_time),
        contentHash: optionalText(row.content_hash),
        indexedAt: optionalText(row.indexed_at),
        status: text(row.status, "pending"),
        conceptsPending: numberValue(row.concepts_pending) === 1,
        databaseId: optionalText(row.database_id),
        icon: optionalText(row.icon),
        tags: parseAliases(row.tags_json),
        relationIds: parseAliases(row.relation_ids_json),
        mentionIds: parseAliases(row.mention_ids_json),
      }));
  }

  /** One page is replaced atomically: a failure keeps the last good version. */
  replaceSourceContent(source: SourceRecord, chunks: ContentChunk[], unsupportedBlocks: number, contentHash: string) {
    this.transaction(() => {
      this.database.prepare(
        `INSERT INTO notion_sources (
           id, object_type, title, root_id, root_title, parent_path, url, last_edited_time,
           content_hash, indexed_at, status, error, unsupported_blocks, concepts_pending,
           database_id, icon, tags_json, relation_ids_json, mention_ids_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'indexed', NULL, ?, 0, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           object_type = excluded.object_type,
           title = excluded.title,
           root_id = excluded.root_id,
           root_title = excluded.root_title,
           parent_path = excluded.parent_path,
           url = excluded.url,
           last_edited_time = excluded.last_edited_time,
           content_hash = excluded.content_hash,
           indexed_at = excluded.indexed_at,
           status = 'indexed',
           error = NULL,
           unsupported_blocks = excluded.unsupported_blocks,
           concepts_pending = 0,
           database_id = excluded.database_id,
           icon = excluded.icon,
           tags_json = excluded.tags_json,
           relation_ids_json = excluded.relation_ids_json,
           mention_ids_json = excluded.mention_ids_json`,
      ).run(
        source.id,
        source.objectType,
        source.title,
        source.rootId,
        source.rootTitle,
        source.parentPath,
        source.url,
        source.lastEditedTime,
        contentHash,
        new Date().toISOString(),
        unsupportedBlocks,
        source.databaseId ?? source.rootId,
        source.icon ?? null,
        JSON.stringify(source.tags ?? []),
        JSON.stringify(source.relationIds ?? []),
        JSON.stringify(source.mentionIds ?? []),
      );

      this.deleteChunksForSource(source.id);
      const insertChunk = this.database.prepare(
        "INSERT INTO content_chunks (id, source_id, block_id, heading_path, text, position, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const insertFts = this.database.prepare("INSERT INTO chunks_fts (chunk_id, text, heading_path) VALUES (?, ?, ?)");
      for (const chunk of chunks) {
        const chunkId = `${source.id}:${chunk.order}`;
        insertChunk.run(chunkId, source.id, chunk.blockId, chunk.headingPath, chunk.text, chunk.order, chunk.hash);
        insertFts.run(chunkId, chunk.text, chunk.headingPath);
      }

      this.database.prepare("DELETE FROM source_links WHERE source_id = ?").run(source.id);
      const insertLink = this.database.prepare(
        "INSERT OR IGNORE INTO source_links (source_id, target_source_id, type, property_name) VALUES (?, ?, ?, ?)",
      );
      for (const target of source.relationIds ?? []) insertLink.run(source.id, target, "notion_relation", "");
      for (const target of source.mentionIds ?? []) insertLink.run(source.id, target, "page_mention", "");
    });
  }

  /** Refreshes Notion metadata without discarding unchanged chunks or embeddings. */
  updateSourceMetadata(source: SourceRecord) {
    this.transaction(() => {
      this.database.prepare(
        `UPDATE notion_sources SET
           object_type = ?, title = ?, root_id = ?, root_title = ?, parent_path = ?, url = ?,
           last_edited_time = ?, status = 'indexed', error = NULL, database_id = ?, icon = ?,
           tags_json = ?, relation_ids_json = ?, mention_ids_json = ?
         WHERE id = ?`,
      ).run(
        source.objectType,
        source.title,
        source.rootId,
        source.rootTitle,
        source.parentPath,
        source.url,
        source.lastEditedTime,
        source.databaseId ?? source.rootId,
        source.icon ?? null,
        JSON.stringify(source.tags ?? []),
        JSON.stringify(source.relationIds ?? []),
        JSON.stringify(source.mentionIds ?? []),
        source.id,
      );

      this.database.prepare("DELETE FROM source_links WHERE source_id = ?").run(source.id);
      const insertLink = this.database.prepare(
        "INSERT OR IGNORE INTO source_links (source_id, target_source_id, type, property_name) VALUES (?, ?, ?, ?)",
      );
      for (const target of source.relationIds ?? []) insertLink.run(source.id, target, "notion_relation", "");
      for (const target of source.mentionIds ?? []) insertLink.run(source.id, target, "page_mention", "");
    });
  }

  markSourceFailed(id: string, message: string) {
    this.database
      .prepare("UPDATE notion_sources SET status = 'failed', error = ? WHERE id = ?")
      .run(message.slice(0, 400), id);
  }

  /** A source whose extraction could not finish keeps its content and is retried later. */
  markSourcePartial(id: string, message: string) {
    this.database
      .prepare("UPDATE notion_sources SET status = 'partial', error = ? WHERE id = ?")
      .run(message.slice(0, 400), id);
  }

  /** Removes everything the finished run no longer found; old data survives failures. */
  deleteSourcesExcept(sourceIds: string[]) {
    const keep = new Set(sourceIds);
    const removable = this.listSources().filter((source) => !keep.has(source.id)).map((source) => source.id);
    if (!removable.length) return 0;
    this.transaction(() => {
      for (const id of removable) this.deleteSourceInternal(id);
    });
    return removable.length;
  }

  deleteSourcesForDatabaseExcept(databaseId: string, sourceIds: string[]) {
    const keep = new Set(sourceIds);
    const removable = this.listSources()
      .filter((source) => source.databaseId === databaseId && !keep.has(source.id))
      .map((source) => source.id);
    if (!removable.length) return 0;
    this.transaction(() => {
      for (const id of removable) this.deleteSourceInternal(id);
    });
    return removable.length;
  }

  // -- extraction checkpoints ------------------------------------------------

  getCheckpoint(sourceId: string) {
    const row = this.database
      .prepare("SELECT * FROM extraction_checkpoints WHERE source_id = ?")
      .get(sourceId) as Row | undefined;
    if (!row) return null;
    return {
      completedBatches: numberValue(row.completed_batches),
      totalBatches: numberValue(row.total_batches),
      failedBatches: parseNumberList(row.failed_batches),
    };
  }

  saveCheckpoint(sourceId: string, completedBatches: number, totalBatches: number, failedBatches: number[]) {
    this.database.prepare(
      `INSERT INTO extraction_checkpoints (source_id, completed_batches, total_batches, failed_batches, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (source_id) DO UPDATE SET
         completed_batches = excluded.completed_batches,
         total_batches = excluded.total_batches,
         failed_batches = excluded.failed_batches,
         updated_at = excluded.updated_at`,
    ).run(sourceId, completedBatches, totalBatches, JSON.stringify(failedBatches), new Date().toISOString());
  }

  clearCheckpoint(sourceId: string) {
    this.database.prepare("DELETE FROM extraction_checkpoints WHERE source_id = ?").run(sourceId);
  }

  markConceptsIndexed(sourceId: string) {
    this.database.prepare("UPDATE notion_sources SET concepts_pending = 0 WHERE id = ?").run(sourceId);
  }

  sourcesWithPendingConcepts() {
    return this.listSources().filter((source) => source.conceptsPending && source.status === "indexed");
  }

  private deleteChunksForSource(sourceId: string) {
    const chunkIds = (this.database.prepare("SELECT id FROM content_chunks WHERE source_id = ?").all(sourceId) as Row[])
      .map((row) => text(row.id));
    const deleteFts = this.database.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?");
    const deleteEmbedding = this.database.prepare("DELETE FROM embeddings WHERE owner_type = 'chunk' AND owner_id = ?");
    for (const chunkId of chunkIds) {
      deleteFts.run(chunkId);
      deleteEmbedding.run(chunkId);
    }
    this.database.prepare("DELETE FROM content_chunks WHERE source_id = ?").run(sourceId);
  }

  private deleteSourceInternal(sourceId: string) {
    this.deleteChunksForSource(sourceId);
    this.database.prepare("DELETE FROM notion_sources WHERE id = ?").run(sourceId);
  }

  deleteSource(sourceId: string) {
    this.transaction(() => this.deleteSourceInternal(sourceId));
  }

  // -- chunks ---------------------------------------------------------------

  private chunkSelect(where: string) {
    return `SELECT c.id, c.source_id, c.block_id, c.heading_path, c.text, c.position,
                   s.title AS source_title, s.root_title, s.url, COALESCE(s.database_id, '') AS database_id
            FROM content_chunks c
            JOIN notion_sources s ON s.id = c.source_id
            ${where}`;
  }

  private toChunk(row: Row): StoredChunk {
    return {
      id: text(row.id),
      sourceId: text(row.source_id),
      blockId: optionalText(row.block_id),
      headingPath: text(row.heading_path),
      text: text(row.text),
      position: numberValue(row.position),
      sourceTitle: text(row.source_title),
      rootTitle: text(row.root_title),
      url: text(row.url),
      databaseId: text(row.database_id),
    };
  }

  listChunksForSource(sourceId: string): StoredChunk[] {
    return (this.database
      .prepare(this.chunkSelect("WHERE c.source_id = ? ORDER BY c.position"))
      .all(sourceId) as Row[]).map((row) => this.toChunk(row));
  }

  chunksByIds(ids: string[]): StoredChunk[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(", ");
    return (this.database
      .prepare(this.chunkSelect(`JOIN notion_databases d ON d.id = s.database_id AND d.selected = 1 WHERE c.id IN (${placeholders})`))
      .all(...ids) as Row[]).map((row) => this.toChunk(row));
  }

  listSelectedChunks(): StoredChunk[] {
    return (this.database.prepare(this.chunkSelect(
      "JOIN notion_databases d ON d.id = s.database_id AND d.selected = 1 ORDER BY s.id, c.position",
    )).all() as Row[]).map((row) => this.toChunk(row));
  }

  countChunks() {
    const row = this.database.prepare("SELECT COUNT(*) AS total FROM content_chunks").get() as Row;
    return numberValue(row.total);
  }

  searchChunksByText(matchExpression: string, limit: number) {
    if (!matchExpression) return [] as string[];
    try {
      return (this.database.prepare(
        `SELECT f.chunk_id, bm25(chunks_fts, 4.0, 1.0) AS rank
         FROM chunks_fts f
         JOIN content_chunks c ON c.id = f.chunk_id
         JOIN notion_sources s ON s.id = c.source_id
         JOIN notion_databases d ON d.id = s.database_id AND d.selected = 1
         WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`,
      ).all(matchExpression, limit) as Row[]).map((row) => text(row.chunk_id));
    } catch {
      // A malformed FTS expression must never break retrieval.
      return [];
    }
  }

  // -- concepts -------------------------------------------------------------

  upsertConcept(concept: {
    id: string;
    label: string;
    normalized: string;
    aliases: string[];
    description: string;
    category: string;
    importance: number;
  }) {
    this.database.prepare(
      `INSERT INTO concepts (id, label, normalized, aliases, description, category, importance, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         label = excluded.label,
         aliases = excluded.aliases,
         description = CASE WHEN length(excluded.description) > length(concepts.description)
           THEN excluded.description ELSE concepts.description END,
         category = excluded.category,
         importance = MAX(concepts.importance, excluded.importance),
         last_seen_at = excluded.last_seen_at`,
    ).run(
      concept.id,
      concept.label,
      concept.normalized,
      JSON.stringify(concept.aliases),
      concept.description,
      concept.category,
      concept.importance,
      new Date().toISOString(),
    );
  }

  clearOccurrencesForSource(sourceId: string) {
    this.database.prepare("DELETE FROM concept_occurrences WHERE source_id = ?").run(sourceId);
    this.database.prepare("DELETE FROM model_relation_candidates WHERE chunk_id IN (SELECT id FROM content_chunks WHERE source_id = ?)").run(sourceId);
  }

  addOccurrences(occurrences: OccurrenceRecord[]) {
    const insert = this.database.prepare(
      `INSERT INTO concept_occurrences (concept_id, chunk_id, source_id, snippet, confidence)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (concept_id, chunk_id) DO UPDATE SET
         snippet = excluded.snippet,
         confidence = MAX(concept_occurrences.confidence, excluded.confidence)`,
    );
    for (const occurrence of occurrences) {
      insert.run(occurrence.conceptId, occurrence.chunkId, occurrence.sourceId, occurrence.snippet, occurrence.confidence);
    }
  }

  conceptIdsForSource(sourceId: string) {
    return [...new Set((this.database
      .prepare("SELECT DISTINCT concept_id FROM concept_occurrences WHERE source_id = ?")
      .all(sourceId) as Row[]).map((row) => text(row.concept_id)))];
  }

  /** Concepts without a single occurrence are not knowledge, they are noise. */
  deleteConceptsWithoutEvidence() {
    const removed = this.database.prepare(
      "DELETE FROM concepts WHERE id NOT IN (SELECT DISTINCT concept_id FROM concept_occurrences)",
    ).run();
    return numberValue(removed.changes);
  }

  listConcepts(): ConceptRecord[] {
    return (this.database.prepare(
      `SELECT c.*,
              COUNT(DISTINCT o.source_id) AS source_count,
              COUNT(o.chunk_id) AS occurrence_count,
              (SELECT s.url FROM concept_occurrences o2
                 JOIN notion_sources s ON s.id = o2.source_id
                WHERE o2.concept_id = c.id
                ORDER BY o2.confidence DESC LIMIT 1) AS notion_url
         FROM concepts c
         LEFT JOIN concept_occurrences o ON o.concept_id = c.id
        WHERE EXISTS (
          SELECT 1 FROM concept_occurrences so
          JOIN notion_sources ss ON ss.id = so.source_id
          JOIN notion_databases sd ON sd.id = ss.database_id AND sd.selected = 1
          WHERE so.concept_id = c.id
        )
        GROUP BY c.id
        ORDER BY c.label COLLATE NOCASE`,
    ).all() as Row[]).map((row) => ({
      id: text(row.id),
      label: text(row.label),
      normalized: text(row.normalized),
      aliases: parseAliases(row.aliases),
      description: text(row.description),
      category: text(row.category, "Allgemein"),
      importance: numberValue(row.importance, 0.5),
      lastSeenAt: text(row.last_seen_at),
      sourceCount: numberValue(row.source_count),
      occurrenceCount: numberValue(row.occurrence_count),
      notionUrl: optionalText(row.notion_url),
    }));
  }

  getConcept(id: string) {
    return this.listConcepts().find((concept) => concept.id === id) ?? null;
  }

  listOccurrences(conceptId: string): ConceptOccurrence[] {
    return (this.database.prepare(
      `SELECT o.snippet, o.confidence, c.heading_path, c.block_id,
              s.id AS source_id, s.title AS source_title, s.root_title, s.url
         FROM concept_occurrences o
         JOIN content_chunks c ON c.id = o.chunk_id
         JOIN notion_sources s ON s.id = o.source_id
         JOIN notion_databases d ON d.id = s.database_id AND d.selected = 1
        WHERE o.concept_id = ?
        ORDER BY s.root_title COLLATE NOCASE, s.title COLLATE NOCASE, c.position`,
    ).all(conceptId) as Row[]).map((row) => {
      const blockId = optionalText(row.block_id);
      const url = text(row.url);
      return {
        sourceId: text(row.source_id),
        sourceTitle: text(row.source_title),
        rootTitle: text(row.root_title),
        headingPath: text(row.heading_path),
        snippet: text(row.snippet),
        notionUrl: blockId ? `${url}#${blockId.replace(/-/gu, "")}` : url,
        blockId,
        confidence: numberValue(row.confidence, 0.5),
      };
    });
  }

  allOccurrenceRows() {
    return (this.database.prepare(
      `SELECT o.concept_id, o.chunk_id, o.source_id FROM concept_occurrences o
       JOIN notion_sources s ON s.id = o.source_id
       JOIN notion_databases d ON d.id = s.database_id AND d.selected = 1`,
    ).all() as Row[])
      .map((row) => ({
        conceptId: text(row.concept_id),
        chunkId: text(row.chunk_id),
        sourceId: text(row.source_id),
      }));
  }

  /** Maps every concept to the selected roots it was found in, for map filtering. */
  conceptRootIds() {
    const map = new Map<string, Set<string>>();
    for (const row of this.database.prepare(
      `SELECT DISTINCT o.concept_id, s.database_id AS root_id
         FROM concept_occurrences o
         JOIN notion_sources s ON s.id = o.source_id
         JOIN notion_databases d ON d.id = s.database_id AND d.selected = 1`,
    ).all() as Row[]) {
      const conceptId = text(row.concept_id);
      const entry = map.get(conceptId) ?? new Set<string>();
      entry.add(text(row.root_id));
      map.set(conceptId, entry);
    }
    return map;
  }

  conceptIdsForChunks(chunkIds: string[]) {
    if (!chunkIds.length) return [] as string[];
    const placeholders = chunkIds.map(() => "?").join(", ");
    return [...new Set((this.database
      .prepare(`SELECT DISTINCT o.concept_id FROM concept_occurrences o
        JOIN notion_sources s ON s.id = o.source_id
        JOIN notion_databases d ON d.id = s.database_id AND d.selected = 1
        WHERE o.chunk_id IN (${placeholders})`)
      .all(...chunkIds) as Row[]).map((row) => text(row.concept_id)))];
  }

  /** Atomically replaces the derived concept layer while keeping crawled Notion content intact. */
  replaceConceptIndex(concepts: Array<{
    id: string;
    label: string;
    normalized: string;
    aliases: string[];
    description: string;
    category: string;
    importance: number;
    occurrences: Array<{ chunkId: string; sourceId: string; snippet: string; confidence: number }>;
  }>) {
    this.transaction(() => {
      this.database.exec("DELETE FROM relation_evidence");
      this.database.exec("DELETE FROM concept_relations");
      this.database.exec("DELETE FROM model_relation_candidates");
      this.database.exec("DELETE FROM concept_occurrences");
      this.database.exec("DELETE FROM concepts");
      const insertConcept = this.database.prepare(
        `INSERT INTO concepts (id, label, normalized, aliases, description, category, importance, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertOccurrence = this.database.prepare(
        `INSERT INTO concept_occurrences (concept_id, chunk_id, source_id, snippet, confidence)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const now = new Date().toISOString();
      for (const concept of concepts) {
        insertConcept.run(
          concept.id,
          concept.label,
          concept.normalized,
          JSON.stringify(concept.aliases),
          concept.description,
          concept.category,
          concept.importance,
          now,
        );
        for (const occurrence of concept.occurrences) {
          insertOccurrence.run(concept.id, occurrence.chunkId, occurrence.sourceId, occurrence.snippet, occurrence.confidence);
        }
      }
    });
  }

  selectedSourceMetadata() {
    return (this.database.prepare(
      `SELECT s.id, s.title, s.url, s.tags_json, s.database_id
         FROM notion_sources s
         JOIN notion_databases d ON d.id = s.database_id AND d.selected = 1`,
    ).all() as Row[]).map((row) => ({
      id: text(row.id),
      title: text(row.title),
      url: text(row.url),
      databaseId: text(row.database_id),
      tags: parseAliases(row.tags_json),
    }));
  }

  selectedSourceLinks() {
    return (this.database.prepare(
      `SELECT l.source_id, l.target_source_id, l.type, l.property_name
         FROM source_links l
         JOIN notion_sources s ON s.id = l.source_id
         JOIN notion_databases d ON d.id = s.database_id AND d.selected = 1
         JOIN notion_sources target ON target.id = l.target_source_id
         JOIN notion_databases td ON td.id = target.database_id AND td.selected = 1`,
    ).all() as Row[]).map((row) => ({
      sourceId: text(row.source_id),
      targetSourceId: text(row.target_source_id),
      type: text(row.type) as "notion_relation" | "page_mention",
      propertyName: text(row.property_name),
    }));
  }

  // -- relations ------------------------------------------------------------

  saveModelRelationCandidates(candidates: Array<{ source: string; target: string; type: string; reason: string; chunkId: string }>) {
    const insert = this.database.prepare(
      `INSERT INTO model_relation_candidates (source_concept_id, target_concept_id, type, reason, chunk_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (source_concept_id, target_concept_id, type, chunk_id) DO UPDATE SET reason = excluded.reason`,
    );
    for (const candidate of candidates) {
      insert.run(candidate.source, candidate.target, candidate.type, candidate.reason, candidate.chunkId);
    }
  }

  listModelRelationCandidates() {
    return (this.database.prepare("SELECT * FROM model_relation_candidates").all() as Row[]).map((row) => ({
      source: text(row.source_concept_id),
      target: text(row.target_concept_id),
      type: text(row.type),
      reason: text(row.reason),
      chunkId: text(row.chunk_id),
    }));
  }

  replaceRelations(edges: ConceptEdge[]) {
    this.transaction(() => {
      this.database.exec("DELETE FROM concept_relations");
      this.database.exec("DELETE FROM relation_evidence");
      const insert = this.database.prepare(
        `INSERT INTO concept_relations (source_concept_id, target_concept_id, type, weight, reason, evidence_count)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_concept_id, target_concept_id, type) DO UPDATE SET
           weight = excluded.weight, reason = excluded.reason, evidence_count = excluded.evidence_count`,
      );
      for (const edge of edges) {
        insert.run(edge.source, edge.target, edge.type, edge.weight, edge.reason, edge.evidenceCount);
        const insertEvidence = this.database.prepare(
          `INSERT OR IGNORE INTO relation_evidence (
             source_concept_id, target_concept_id, relation_type, source_id, chunk_id, snippet, notion_url
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const evidence of edge.evidence ?? []) {
          insertEvidence.run(edge.source, edge.target, edge.type, evidence.sourceId, evidence.chunkId, evidence.snippet, evidence.notionUrl);
        }
      }
    });
  }

  listRelations(): ConceptEdge[] {
    const evidenceByKey = new Map<string, RelationEvidence[]>();
    for (const row of this.database.prepare("SELECT * FROM relation_evidence").all() as Row[]) {
      const key = `${text(row.source_concept_id)}\u0000${text(row.target_concept_id)}\u0000${text(row.relation_type)}`;
      const source = this.getSource(text(row.source_id));
      evidenceByKey.set(key, [...(evidenceByKey.get(key) ?? []), {
        sourceId: text(row.source_id),
        sourceTitle: source?.title ?? "Notion",
        chunkId: optionalText(row.chunk_id),
        snippet: text(row.snippet),
        notionUrl: text(row.notion_url),
      }]);
    }
    return (this.database.prepare(
      `SELECT r.* FROM concept_relations r
       WHERE EXISTS (SELECT 1 FROM concept_occurrences o JOIN notion_sources s ON s.id = o.source_id
         JOIN notion_databases d ON d.id = s.database_id AND d.selected = 1 WHERE o.concept_id = r.source_concept_id)
       AND EXISTS (SELECT 1 FROM concept_occurrences o JOIN notion_sources s ON s.id = o.source_id
         JOIN notion_databases d ON d.id = s.database_id AND d.selected = 1 WHERE o.concept_id = r.target_concept_id)`,
    ).all() as Row[]).map((row) => ({
      source: text(row.source_concept_id),
      target: text(row.target_concept_id),
      type: text(row.type) as ConceptRelationType,
      weight: numberValue(row.weight),
      confidence: numberValue(row.weight),
      explicit: ["notion_relation", "page_mention"].includes(text(row.type)),
      reason: text(row.reason),
      evidenceCount: numberValue(row.evidence_count),
      evidence: evidenceByKey.get(`${text(row.source_concept_id)}\u0000${text(row.target_concept_id)}\u0000${text(row.type)}`) ?? [],
    }));
  }

  listRelationsForConcept(conceptId: string): ConceptEdge[] {
    return this.listRelations().filter((edge) => edge.source === conceptId || edge.target === conceptId);
  }

  // -- embeddings -----------------------------------------------------------

  saveEmbedding(ownerType: "chunk" | "concept", ownerId: string, model: string, vector: Float32Array) {
    this.database.prepare(
      `INSERT INTO embeddings (owner_type, owner_id, model, dimension, vector, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_type, owner_id, model) DO UPDATE SET
         dimension = excluded.dimension, vector = excluded.vector, updated_at = excluded.updated_at`,
    ).run(ownerType, ownerId, model, vector.length, vectorToBlob(vector), new Date().toISOString());
  }

  listEmbeddings(ownerType: "chunk" | "concept", model: string, selectedOnly = false) {
    const entries = new Map<string, Float32Array>();
    const sql = !selectedOnly
      ? "SELECT owner_id, vector FROM embeddings WHERE owner_type = ? AND model = ?"
      : ownerType === "chunk"
      ? `SELECT e.owner_id, e.vector FROM embeddings e
         JOIN content_chunks c ON c.id = e.owner_id
         JOIN notion_sources s ON s.id = c.source_id
         JOIN notion_databases d ON d.id = s.database_id AND d.selected = 1
        WHERE e.owner_type = ? AND e.model = ?`
      : `SELECT e.owner_id, e.vector FROM embeddings e
        WHERE e.owner_type = ? AND e.model = ? AND EXISTS (
          SELECT 1 FROM concept_occurrences o JOIN notion_sources s ON s.id = o.source_id
          JOIN notion_databases d ON d.id = s.database_id AND d.selected = 1
          WHERE o.concept_id = e.owner_id
        )`;
    for (const row of this.database.prepare(sql).all(ownerType, model) as Row[]) {
      entries.set(text(row.owner_id), blobToVector(row.vector));
    }
    return entries;
  }

  ownersWithoutEmbedding(ownerType: "chunk" | "concept", ownerIds: string[], model: string) {
    const existing = new Set((this.database
      .prepare("SELECT owner_id FROM embeddings WHERE owner_type = ? AND model = ?")
      .all(ownerType, model) as Row[]).map((row) => text(row.owner_id)));
    return ownerIds.filter((id) => !existing.has(id));
  }

  embeddingDimension(model: string) {
    const row = this.database
      .prepare("SELECT dimension FROM embeddings WHERE model = ? LIMIT 1")
      .get(model) as Row | undefined;
    return row ? numberValue(row.dimension) : null;
  }

  clearEmbeddings(model?: string) {
    if (model) this.database.prepare("DELETE FROM embeddings WHERE model != ?").run(model);
    else this.database.exec("DELETE FROM embeddings");
  }

  // -- sync runs ------------------------------------------------------------

  startSyncRun(total: number) {
    const now = new Date().toISOString();
    const result = this.database.prepare(
      `INSERT INTO sync_runs (status, phase, processed_sources, total_sources, graph_version, started_at)
       VALUES ('running', 'queued', 0, ?, ?, ?)`,
    ).run(total, this.graphVersion(), now);
    return Number(result.lastInsertRowid);
  }

  updateSyncRun(id: number, patch: {
    phase?: SyncPhase;
    processedSources?: number;
    totalSources?: number;
    currentSource?: string | null;
    graphVersion?: number;
    currentDatabaseId?: string | null;
    processedDatabases?: number;
    totalDatabases?: number;
    failedSources?: number;
  }) {
    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.phase !== undefined) { fields.push("phase = ?"); values.push(patch.phase); }
    if (patch.processedSources !== undefined) { fields.push("processed_sources = ?"); values.push(patch.processedSources); }
    if (patch.totalSources !== undefined) { fields.push("total_sources = ?"); values.push(patch.totalSources); }
    if (patch.currentSource !== undefined) { fields.push("current_source = ?"); values.push(patch.currentSource); }
    if (patch.graphVersion !== undefined) { fields.push("graph_version = ?"); values.push(patch.graphVersion); }
    if (patch.currentDatabaseId !== undefined) { fields.push("current_database_id = ?"); values.push(patch.currentDatabaseId); }
    if (patch.processedDatabases !== undefined) { fields.push("processed_databases = ?"); values.push(patch.processedDatabases); }
    if (patch.totalDatabases !== undefined) { fields.push("total_databases = ?"); values.push(patch.totalDatabases); }
    if (patch.failedSources !== undefined) { fields.push("failed_sources = ?"); values.push(patch.failedSources); }
    if (!fields.length) return;
    this.database.prepare(`UPDATE sync_runs SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
  }

  finishSyncRun(id: number, status: "done" | "error" | "cancelled" | "interrupted", error?: string | null) {
    this.database.prepare("UPDATE sync_runs SET status = ?, phase = ?, error = ?, finished_at = ? WHERE id = ?")
      .run(status, status === "done" ? "ready" : status, error ?? null, new Date().toISOString(), id);
    if (status === "done") this.setMeta("last_successful_sync_at", new Date().toISOString());
  }

  latestSyncRun(): SyncRunRecord | null {
    const row = this.database.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1").get() as Row | undefined;
    if (!row) return null;
    return {
      id: numberValue(row.id),
      status: text(row.status),
      phase: text(row.phase, "idle") as SyncPhase,
      processedSources: numberValue(row.processed_sources),
      totalSources: numberValue(row.total_sources),
      currentSource: optionalText(row.current_source),
      error: optionalText(row.error),
      graphVersion: numberValue(row.graph_version),
      startedAt: text(row.started_at),
      finishedAt: optionalText(row.finished_at),
      currentDatabaseId: optionalText(row.current_database_id),
      processedDatabases: numberValue(row.processed_databases),
      totalDatabases: numberValue(row.total_databases),
      failedSources: numberValue(row.failed_sources),
    };
  }

  /** A run that never finished was interrupted; the next start resumes it. */
  markRunningSyncsInterrupted() {
    this.database.prepare(
      "UPDATE sync_runs SET status = 'interrupted', phase = 'interrupted', finished_at = ? WHERE status = 'running'",
    ).run(new Date().toISOString());
  }

  // -- coverage -------------------------------------------------------------

  coverage(): KnowledgeCoverage {
    const single = (sql: string) => numberValue((this.database.prepare(sql).get() as Row).total);
    return {
      selectedRoots: single("SELECT COUNT(*) AS total FROM notion_databases WHERE selected = 1"),
      selectedDatabases: single("SELECT COUNT(*) AS total FROM notion_databases WHERE selected = 1"),
      foundSources: single(`SELECT COUNT(*) AS total FROM notion_sources s JOIN notion_databases d ON d.id = s.database_id AND d.selected = 1`),
      indexedSources: single(`SELECT COUNT(*) AS total FROM notion_sources s JOIN notion_databases d ON d.id = s.database_id AND d.selected = 1 WHERE s.status IN ('indexed', 'partial')`),
      chunks: single(`SELECT COUNT(*) AS total FROM content_chunks c JOIN notion_sources s ON s.id = c.source_id JOIN notion_databases d ON d.id = s.database_id AND d.selected = 1`),
      concepts: this.listConcepts().length,
      relations: this.listRelations().length,
      failedSources: single(`SELECT COUNT(*) AS total FROM notion_sources s JOIN notion_databases d ON d.id = s.database_id AND d.selected = 1 WHERE s.status = 'failed'`),
      unsupportedBlocks: single(`SELECT COALESCE(SUM(s.unsupported_blocks), 0) AS total FROM notion_sources s JOIN notion_databases d ON d.id = s.database_id AND d.selected = 1`),
    };
  }

  /** Backs the "delete index and rebuild" action. */
  clearIndex() {
    this.transaction(() => {
      for (const table of [
        "chunks_fts",
        "relation_evidence",
        "source_links",
        "concept_occurrences",
        "model_relation_candidates",
        "concept_relations",
        "concepts",
        "extraction_checkpoints",
        "content_chunks",
        "notion_sources",
        "embeddings",
        "sync_runs",
      ]) {
        this.database.exec(`DELETE FROM ${table}`);
      }
      this.database.exec("DELETE FROM index_meta WHERE key NOT IN ('graph_version', 'selection_version')");
      this.database.prepare("UPDATE selected_roots SET needs_reindex = 1").run();
    });
    this.bumpGraphVersion();
  }
}
