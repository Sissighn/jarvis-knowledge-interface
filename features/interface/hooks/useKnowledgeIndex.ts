"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConceptDetail,
  ConceptEdge,
  ConceptNode,
  NotionKnowledgeDatabase,
  KnowledgeCoverage,
  KnowledgeGraph,
  KnowledgeStatus,
} from "../types";

const ACTIVE_POLL_INTERVAL_MS = 1_000;
const IDLE_POLL_INTERVAL_MS = 20_000;

export type KnowledgeFilters = { databaseIds: string[]; categories: string[] };

const EMPTY_COVERAGE: KnowledgeCoverage = {
  selectedRoots: 0,
  foundSources: 0,
  indexedSources: 0,
  chunks: 0,
  concepts: 0,
  relations: 0,
  failedSources: 0,
  unsupportedBlocks: 0,
};

type ErrorPayload = { error?: string; code?: string };

async function requestIndex<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/knowledge${path}`, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({})) as T & ErrorPayload;
  if (!response.ok) {
    const error = new Error(payload.error || "Der lokale Wissensindex hat nicht geantwortet.");
    (error as Error & { code?: string }).code = payload.code;
    throw error;
  }
  return payload;
}

export function useKnowledgeIndex() {
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const [nodes, setNodes] = useState<ConceptNode[]>([]);
  const [edges, setEdges] = useState<ConceptEdge[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [coverage, setCoverage] = useState<KnowledgeCoverage>(EMPTY_COVERAGE);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [databases, setDatabases] = useState<NotionKnowledgeDatabase[]>([]);
  const [databasesLoading, setDatabasesLoading] = useState(false);
  const [savingSelection, setSavingSelection] = useState(false);
  const [selectionSavedAt, setSelectionSavedAt] = useState<number | null>(null);
  const [indexAvailable, setIndexAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<KnowledgeFilters>({ databaseIds: [], categories: [] });
  const loadedVersionRef = useRef(-1);
  const autoSyncRef = useRef(false);

  const loadGraph = useCallback(async (nextFilters: KnowledgeFilters) => {
    const query = new URLSearchParams();
    if (nextFilters.databaseIds.length) query.set("databases", nextFilters.databaseIds.join(","));
    if (nextFilters.categories.length) query.set("categories", nextFilters.categories.join(","));
    try {
      const graph = await requestIndex<KnowledgeGraph>(`/graph${query.size ? `?${query}` : ""}`);
      loadedVersionRef.current = graph.graphVersion;
      setCoverage(graph.coverage);
      setCategories(graph.categories);
      setSyncedAt(graph.syncedAt);
      setNodes(graph.nodes);
      setEdges(graph.edges);
      setError(null);
      return graph;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Der Wissensgraph konnte nicht geladen werden.");
      return null;
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const next = await requestIndex<KnowledgeStatus>("/status");
      setIndexAvailable(true);
      setStatus(next);
      if (next.graphVersion !== loadedVersionRef.current) await loadGraph(filters);
      return next;
    } catch (statusError) {
      const code = (statusError as Error & { code?: string }).code;
      if (code === "desktop_required" || code === "indexer_unavailable") setIndexAvailable(false);
      setError(statusError instanceof Error ? statusError.message : "Der lokale Index ist nicht erreichbar.");
      return null;
    }
  }, [filters, loadGraph]);

  const startSync = useCallback(async (mode: "incremental" | "full" = "incremental") => {
    setError(null);
    try {
      await requestIndex("/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      await loadStatus();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Die Synchronisierung konnte nicht starten.");
    }
  }, [loadStatus]);

  const cancelSync = useCallback(async () => {
    try {
      await requestIndex("/sync/cancel", { method: "POST" });
      await loadStatus();
    } catch {
      // A failed cancel simply leaves the run going; the status reflects it.
    }
  }, [loadStatus]);

  const loadDatabases = useCallback(async () => {
    setDatabasesLoading(true);
    try {
      const payload = await requestIndex<{ databases: NotionKnowledgeDatabase[] }>("/databases");
      setDatabases(payload.databases);
    } catch (databaseError) {
      setError(databaseError instanceof Error ? databaseError.message : "Die Notion-Datenbanken konnten nicht geladen werden.");
    } finally {
      setDatabasesLoading(false);
    }
  }, []);

  /** Saving returns as soon as the selection is stored; indexing continues in the background. */
  const saveDatabases = useCallback(async (selectedDatabaseIds: string[]) => {
    setSavingSelection(true);
    setError(null);
    try {
      const payload = await requestIndex<{ databases: NotionKnowledgeDatabase[] }>("/databases", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedDatabaseIds }),
      });
      setDatabases(payload.databases);
      setSelectionSavedAt(Date.now());
      await loadStatus();
      return payload.databases;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Die Auswahl konnte nicht gespeichert werden.");
      return [];
    } finally {
      setSavingSelection(false);
    }
  }, [loadStatus]);

  const installEmbeddingModel = useCallback(async () => {
    try {
      await requestIndex("/models/install", { method: "POST" });
      await loadStatus();
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : "Das Modell konnte nicht geladen werden.");
    }
  }, [loadStatus]);

  const resetIndex = useCallback(async () => {
    try {
      await requestIndex("/reset", { method: "POST" });
      loadedVersionRef.current = -1;
      await loadStatus();
      await startSync("full");
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Der Index konnte nicht gelöscht werden.");
    }
  }, [loadStatus, startSync]);

  const loadConceptDetail = useCallback(async (conceptId: string) => {
    try {
      return await requestIndex<ConceptDetail>(`/concepts/${encodeURIComponent(conceptId)}`);
    } catch {
      return null;
    }
  }, []);

  const applyFilters = useCallback(async (next: KnowledgeFilters) => {
    setFilters(next);
    await loadGraph(next);
  }, [loadGraph]);

  // The UI polls once per second during a run and stays quiet otherwise.
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    let initial = true;

    const tick = async () => {
      const next = await loadStatus();
      if (cancelled) return;
      const lastSyncAge = next?.lastSuccessfulSyncAt ? Date.now() - Date.parse(next.lastSuccessfulSyncAt) : Infinity;
      if (!initial && next?.notion.connected && !next.running && !autoSyncRef.current && next.coverage.selectedRoots > 0 && lastSyncAge > 15 * 60_000) {
        autoSyncRef.current = true;
        await startSync("incremental");
      }
      const delay = initial ? 8_000 : next?.running ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
      initial = false;
      timer = window.setTimeout(tick, delay);
    };

    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loadStatus, startSync]);

  return {
    status,
    nodes,
    edges,
    categories,
    coverage,
    syncedAt,
    databases,
    databasesLoading,
    savingSelection,
    selectionSavedAt,
    indexAvailable,
    error,
    filters,
    applyFilters,
    startSync,
    cancelSync,
    loadDatabases,
    saveDatabases,
    installEmbeddingModel,
    resetIndex,
    loadConceptDetail,
    refreshStatus: loadStatus,
  };
}
