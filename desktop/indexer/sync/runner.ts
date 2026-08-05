/** Fast incremental Notion sync. No chat model is used while indexing. */
import { chunkSourceBlocks, contentHash } from "@/features/knowledge/chunking";
import { extractCorpusConcepts } from "@/features/knowledge/term-extraction";
import {
  buildCoOccurrenceEdges,
  buildSemanticEdges,
  buildSourceSignalEdges,
  dedupeEdges,
  type ConceptVector,
} from "@/features/knowledge/relations";
import type { ConceptEdge, SyncPhase, SyncProgress } from "@/features/knowledge/types";
import { embedTexts, modelAvailability, OllamaAbortError } from "../ai/ollama";
import { embeddingModel, notionToken } from "../config";
import type { KnowledgeRepository, SourceRecord, StoredChunk } from "../db/repository";
import { NotionAbortError, NotionClient } from "../notion/client";
import { discoverNotionDatabases } from "../notion/databases";
import { queryDataSourcePages, readPageContent, type NotionEntry } from "../notion/crawl";

const EMBEDDING_BATCH_SIZE = 32;

export type SyncMode = "incremental" | "full";

export class SyncCancelledError extends Error {
  constructor() {
    super("Die Synchronisierung wurde abgebrochen.");
    this.name = "SyncCancelledError";
  }
}

function isCancellation(error: unknown) {
  return error instanceof SyncCancelledError || error instanceof NotionAbortError || error instanceof OllamaAbortError;
}

function isNetworkError(error: unknown) {
  const status = (error as { status?: number }).status;
  return status === 503 || status === 429 || (error as { code?: string }).code === "offline";
}

function yieldToUi() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export function idleProgress(): SyncProgress {
  return {
    phase: "idle",
    processedSources: 0,
    totalSources: 0,
    currentSource: null,
    currentDatabaseId: null,
    currentDatabaseTitle: null,
    processedDatabases: 0,
    totalDatabases: 0,
    failedSources: 0,
    currentBatch: 0,
    totalBatches: 0,
    incompleteSources: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

export class SyncRunner {
  private running = false;
  private controller: AbortController | null = null;
  private scheduledMode: SyncMode | null = null;
  private progress: SyncProgress = idleProgress();
  private offline = false;

  constructor(private readonly repository: KnowledgeRepository) {
    this.repository.markRunningSyncsInterrupted();
    const previous = this.repository.latestSyncRun();
    if (previous) {
      this.progress = {
        ...idleProgress(),
        phase: previous.status === "running" ? "interrupted" : previous.status === "done" ? "ready" : previous.phase,
        processedSources: previous.processedSources,
        totalSources: previous.totalSources,
        currentDatabaseId: previous.currentDatabaseId,
        processedDatabases: previous.processedDatabases,
        totalDatabases: previous.totalDatabases,
        failedSources: previous.failedSources,
        startedAt: previous.startedAt,
        finishedAt: previous.finishedAt,
        error: previous.error,
      };
    }
  }

  isRunning() { return this.running; }
  isScheduled() { return this.scheduledMode !== null; }
  isOffline() { return this.offline; }
  currentProgress() { return { ...this.progress }; }

  cancel() {
    if (!this.running) return false;
    this.controller?.abort();
    return true;
  }

  private checkCancelled() {
    if (this.controller?.signal.aborted) throw new SyncCancelledError();
  }

  private setPhase(runId: number, phase: SyncPhase, patch: Partial<SyncProgress> = {}) {
    this.progress = { ...this.progress, phase, ...patch };
    this.repository.updateSyncRun(runId, {
      phase,
      processedSources: this.progress.processedSources,
      totalSources: this.progress.totalSources,
      currentSource: this.progress.currentSource,
      currentDatabaseId: this.progress.currentDatabaseId,
      processedDatabases: this.progress.processedDatabases,
      totalDatabases: this.progress.totalDatabases,
      failedSources: this.progress.failedSources,
    });
  }

  async start(mode: SyncMode = "incremental") {
    if (this.running) return { started: false, reason: "already_running" as const };
    if (!notionToken()) return { started: false, reason: "not_configured" as const };
    this.running = true;
    this.controller = new AbortController();
    const runId = this.repository.startSyncRun(0);
    this.progress = { ...idleProgress(), phase: "queued", startedAt: new Date().toISOString() };
    void this.run(runId, mode).catch(() => undefined);
    return { started: true as const };
  }

  /** Coalesces repeated selection changes into one clean follow-up run. */
  async restart(mode: SyncMode = "incremental") {
    if (!this.running) return this.start(mode);
    this.scheduledMode = mode;
    this.cancel();
    return { started: true as const, queued: true as const };
  }

  private async run(runId: number, mode: SyncMode) {
    const client = new NotionClient(notionToken());
    client.signal = this.controller?.signal;
    try {
      this.setPhase(runId, "discovering");
      const discovered = await discoverNotionDatabases(client);
      this.checkCancelled();
      this.repository.replaceDatabases(discovered);
      this.repository.migrateAreaSelectionToDatabases();
      const selectedIds = new Set(this.repository.selectedDatabaseIds());
      const selected = this.repository.listDatabases().filter((database) => selectedIds.has(database.id));
      this.progress = { ...this.progress, totalDatabases: selected.length };

      if (!selected.length) {
        this.repository.replaceConceptIndex([]);
        const graphVersion = this.repository.bumpGraphVersion();
        this.repository.updateSyncRun(runId, { graphVersion });
        this.finish(runId, "ready");
        return;
      }

      const stored = new Map(this.repository.listSources().map((source) => [source.id, source]));
      let processedSources = 0;
      let totalSources = 0;
      let failedSources = 0;

      for (const [databaseIndex, database] of selected.entries()) {
        this.checkCancelled();
        this.setPhase(runId, "fetching", {
          currentDatabaseId: database.id,
          currentDatabaseTitle: database.title,
          processedDatabases: databaseIndex,
          totalDatabases: selected.length,
          currentSource: null,
        });

        const rowMap = new Map<string, NotionEntry>();
        for (const dataSourceId of database.dataSourceIds) {
          const rows = await queryDataSourcePages(client, dataSourceId);
          for (const row of rows) rowMap.set(row.id, row);
        }
        const rows = [...rowMap.values()];
        this.repository.updateDatabaseContentCount(database.id, rows.length);
        totalSources += rows.length;
        this.progress = { ...this.progress, totalSources };

        for (const row of rows) {
          this.checkCancelled();
          this.progress = { ...this.progress, currentSource: row.title };
          const existing = stored.get(row.id);
          const unchanged = mode === "incremental" && existing?.status !== "failed"
            && existing?.lastEditedTime === row.lastEditedTime && existing.databaseId === database.id;
          if (!unchanged) {
            try {
              const content = await readPageContent(client, row.id);
              const chunks = chunkSourceBlocks(content.blocks);
              const hash = contentHash(chunks.map((chunk) => chunk.hash).join("|"));
              const source: SourceRecord = {
                id: row.id,
                objectType: "page",
                title: row.title,
                rootId: database.id,
                rootTitle: database.title,
                parentPath: database.parentTitle ? `${database.parentTitle} / ${database.title}` : database.title,
                url: row.url,
                lastEditedTime: row.lastEditedTime,
                databaseId: database.id,
                icon: row.icon ?? null,
                tags: row.tags ?? [],
                relationIds: row.relationIds ?? [],
                mentionIds: [...new Set(content.mentionIds)],
              };
              if (existing?.contentHash !== hash || existing.databaseId !== database.id || mode === "full") {
                this.repository.replaceSourceContent(source, chunks, content.unsupportedBlocks, hash);
              } else {
                this.repository.updateSourceMetadata(source);
              }
            } catch (error) {
              if (isCancellation(error)) throw error;
              failedSources += 1;
              if (existing) this.repository.markSourceFailed(row.id, error instanceof Error ? error.message : "Quelle konnte nicht gelesen werden.");
            }
          }
          processedSources += 1;
          this.progress = { ...this.progress, processedSources, failedSources };
          if (processedSources % 5 === 0) this.setPhase(runId, "fetching");
          await yieldToUi();
        }

        this.repository.deleteSourcesForDatabaseExcept(database.id, rows.map((row) => row.id));
        this.setPhase(runId, "indexing", { currentSource: null });
        this.rebuildFastIndex(false);
        const graphVersion = this.repository.bumpGraphVersion();
        this.repository.updateSyncRun(runId, { graphVersion, processedDatabases: databaseIndex + 1 });
        this.progress = { ...this.progress, processedDatabases: databaseIndex + 1 };
        await yieldToUi();
      }

      await this.addEmbeddings(runId);
      this.rebuildRelations(true);
      const graphVersion = this.repository.bumpGraphVersion();
      this.repository.updateSyncRun(runId, { graphVersion });
      this.finish(runId, failedSources ? "partial" : "ready", failedSources ? `${failedSources} Quellen konnten nicht aktualisiert werden.` : null);
      this.offline = false;
    } catch (error) {
      if (isCancellation(error)) {
        this.repository.finishSyncRun(runId, "cancelled");
        this.progress = { ...this.progress, phase: "cancelled", finishedAt: new Date().toISOString() };
      } else {
        const message = error instanceof Error ? error.message : "Die Synchronisierung ist fehlgeschlagen.";
        this.offline = isNetworkError(error);
        this.repository.finishSyncRun(runId, "error", message);
        this.progress = { ...this.progress, phase: "error", error: message, finishedAt: new Date().toISOString() };
      }
    } finally {
      this.running = false;
      this.controller = null;
      const queued = this.scheduledMode;
      this.scheduledMode = null;
      if (queued) void this.start(queued);
    }
  }

  private finish(runId: number, phase: "ready" | "partial", error: string | null = null) {
    this.repository.finishSyncRun(runId, "done", error);
    this.progress = { ...this.progress, phase, currentSource: null, currentDatabaseId: null, currentDatabaseTitle: null, error, finishedAt: new Date().toISOString() };
  }

  private rebuildFastIndex(includeSemantic: boolean) {
    const chunks = this.repository.listSelectedChunks();
    const concepts = extractCorpusConcepts(chunks.map((chunk) => ({
      id: chunk.id,
      sourceId: chunk.sourceId,
      sourceTitle: chunk.sourceTitle,
      databaseTitle: chunk.rootTitle,
      headingPath: chunk.headingPath,
      text: chunk.text,
    })));
    this.repository.replaceConceptIndex(concepts);
    this.rebuildRelations(includeSemantic);
  }

  private rebuildRelations(includeSemantic: boolean) {
    const occurrences = this.repository.allOccurrenceRows();
    const chunks = new Map(this.repository.listSelectedChunks().map((chunk) => [chunk.id, chunk]));
    const coOccurrence = buildCoOccurrenceEdges(occurrences).map((edge): ConceptEdge => {
      const evidenceOccurrence = occurrences.find((occurrence) => occurrence.conceptId === edge.source
        && occurrences.some((other) => other.chunkId === occurrence.chunkId && other.conceptId === edge.target));
      const chunk = evidenceOccurrence ? chunks.get(evidenceOccurrence.chunkId) : null;
      return {
        ...edge,
        evidence: chunk ? [{
          sourceId: chunk.sourceId,
          sourceTitle: chunk.sourceTitle,
          chunkId: chunk.id,
          snippet: chunk.text.slice(0, 240),
          notionUrl: chunk.blockId ? `${chunk.url}#${chunk.blockId.replace(/-/gu, "")}` : chunk.url,
        }] : [],
      };
    });
    const sourceSignals = buildSourceSignalEdges(
      occurrences,
      this.repository.selectedSourceMetadata(),
      this.repository.selectedSourceLinks(),
    );
    const semantic = includeSemantic ? this.semanticRelations(occurrences) : [];
    this.repository.replaceRelations(dedupeEdges([...coOccurrence, ...semantic, ...sourceSignals]));
  }

  private semanticRelations(occurrences: ReturnType<KnowledgeRepository["allOccurrenceRows"]>) {
    const vectors = this.repository.listEmbeddings("chunk", embeddingModel(), true);
    const concepts = new Map(this.repository.listConcepts().map((concept) => [concept.id, concept]));
    const sums = new Map<string, { values: Float64Array; count: number }>();
    for (const occurrence of occurrences) {
      const vector = vectors.get(occurrence.chunkId);
      if (!vector?.length) continue;
      const entry = sums.get(occurrence.conceptId) ?? { values: new Float64Array(vector.length), count: 0 };
      for (let index = 0; index < vector.length; index++) entry.values[index] += vector[index];
      entry.count += 1;
      sums.set(occurrence.conceptId, entry);
    }
    const conceptVectors: ConceptVector[] = [...sums.entries()].map(([conceptId, entry]) => ({
      conceptId,
      label: concepts.get(conceptId)?.label ?? conceptId,
      vector: Float32Array.from(entry.values, (value) => value / entry.count),
    }));
    return buildSemanticEdges(conceptVectors);
  }

  private async addEmbeddings(runId: number) {
    const models = await modelAvailability();
    if (!models.connected || !models.embeddingModelAvailable) return;
    const chunks = this.repository.listSelectedChunks();
    const missingIds = this.repository.ownersWithoutEmbedding("chunk", chunks.map((chunk) => chunk.id), embeddingModel());
    if (!missingIds.length) return;
    const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    this.setPhase(runId, "embedding", { processedSources: 0, totalSources: missingIds.length, currentSource: null });
    for (let offset = 0; offset < missingIds.length; offset += EMBEDDING_BATCH_SIZE) {
      this.checkCancelled();
      const ids = missingIds.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      const batch = ids.map((id) => byId.get(id)).filter((chunk): chunk is StoredChunk => Boolean(chunk));
      const vectors = await embedTexts(batch.map((chunk) => `${chunk.headingPath}\n${chunk.text}`), embeddingModel());
      vectors.forEach((vector, index) => this.repository.saveEmbedding("chunk", batch[index].id, embeddingModel(), vector));
      this.progress = { ...this.progress, processedSources: Math.min(missingIds.length, offset + ids.length) };
      this.setPhase(runId, "embedding");
      await yieldToUi();
    }
  }
}
