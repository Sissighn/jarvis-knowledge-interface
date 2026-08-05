/** Shared data contracts for the local, concept-based Notion knowledge index. */

export type NotionStatus = {
  configured: boolean;
  connected: boolean;
  botName?: string;
  workspaceName?: string | null;
  error?: string;
};

/** Relations extracted with evidence plus the two derived relation kinds. */
export type ConceptRelationType =
  | "co_occurrence"
  | "semantic"
  | "notion_relation"
  | "page_mention"
  | "shared_tag"
  | "is_a"
  | "part_of"
  | "uses"
  | "contrasts_with"
  | "prerequisite";

/** `root` only connects the visual hub with a category and never carries evidence. */
export type ConceptEdgeType = ConceptRelationType | "root";

export const MODEL_RELATION_TYPES: ConceptRelationType[] = [
  "is_a",
  "part_of",
  "uses",
  "contrasts_with",
  "prerequisite",
];

/**
 * A visible map node. `kind`, `group`, `x`, `y` and `size` stay renderer and camera
 * compatible so the existing map motion, zoom and focus keep working unchanged.
 */
export type ConceptNode = {
  id: string;
  label: string;
  description: string;
  category: string;
  aliases: string[];
  importance: number;
  sourceCount: number;
  occurrenceCount: number;
  lastSeenAt: string;
  kind: "concept" | "category" | "page" | "system";
  group: string;
  x: number;
  y: number;
  size: number;
  notionUrl?: string;
};

export type ConceptEdge = {
  source: string;
  target: string;
  type: ConceptEdgeType;
  weight: number;
  reason: string;
  evidenceCount: number;
  explicit?: boolean;
  confidence?: number;
  evidence?: RelationEvidence[];
};

export type RelationEvidence = {
  sourceId: string;
  sourceTitle: string;
  chunkId: string | null;
  snippet: string;
  notionUrl: string;
};

export type ConceptOccurrence = {
  sourceId: string;
  sourceTitle: string;
  rootTitle: string;
  headingPath: string;
  snippet: string;
  notionUrl: string;
  blockId: string | null;
  confidence: number;
};

export type ConceptDetail = {
  concept: ConceptNode;
  relations: Array<ConceptEdge & { label: string }>;
  occurrences: ConceptOccurrence[];
};

export type KnowledgeCoverage = {
  selectedRoots: number;
  selectedDatabases?: number;
  foundSources: number;
  indexedSources: number;
  chunks: number;
  concepts: number;
  relations: number;
  failedSources: number;
  unsupportedBlocks: number;
};

export type KnowledgeRoot = {
  id: string;
  type: "page" | "data_source";
  title: string;
  parentId?: string | null;
  parentTitle: string | null;
  url: string | null;
  lastEditedTime: string | null;
  selected: boolean;
  recommended: boolean;
};

/** Where a visible area name comes from; AI naming only ever improves labels. */
export type AreaLabelSource = "notion" | "ancestor" | "local_ai" | "fallback";

/**
 * One canonical, selectable knowledge area. The real Notion structure decides which
 * sources belong to it, so areas never overlap and subpages are not selectable.
 */
export type KnowledgeArea = {
  id: string;
  title: string;
  originalTitle: string | null;
  scopeIds: string[];
  contentCount: number;
  sampleTitles: string[];
  selected: boolean;
  recommended: boolean;
  labelSource: AreaLabelSource;
};

/** A real selectable Notion database. The stable database id is persisted; data
 * source ids are implementation details used to query its rows. */
export type NotionKnowledgeDatabase = {
  id: string;
  dataSourceIds: string[];
  title: string;
  originalTitle: string | null;
  icon: string | null;
  parentId: string | null;
  parentTitle: string | null;
  url: string | null;
  contentCount: number;
  selected: boolean;
  lastSeenAt: string;
};

export type KnowledgeGraph = {
  nodes: ConceptNode[];
  edges: ConceptEdge[];
  categories: string[];
  roots: Array<{ id: string; title: string }>;
  coverage: KnowledgeCoverage;
  graphVersion: number;
  syncedAt: string | null;
};

export type SyncPhase =
  | "idle"
  | "queued"
  | "discovering"
  | "fetching"
  | "indexing"
  | "embedding"
  | "ready"
  | "partial"
  | "error"
  | "cancelled"
  | "interrupted";

export type SyncProgress = {
  phase: SyncPhase;
  processedSources: number;
  totalSources: number;
  currentSource: string | null;
  currentDatabaseId: string | null;
  currentDatabaseTitle: string | null;
  processedDatabases: number;
  totalDatabases: number;
  failedSources: number;
  /** Kept for backwards-compatible status rendering; fast indexing never uses Qwen batches. */
  currentBatch: number;
  totalBatches: number;
  incompleteSources: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

export type KnowledgeModelStatus = {
  connected: boolean;
  chatModel: string;
  chatModelAvailable: boolean;
  embeddingModel: string;
  embeddingModelAvailable: boolean;
  embeddingDimension: number | null;
  pulling: boolean;
  pullProgress: string | null;
  error: string | null;
};

export type KnowledgeStatus = {
  available: boolean;
  notion: NotionStatus;
  models: KnowledgeModelStatus;
  sync: SyncProgress;
  running: boolean;
  /** A sync that is queued behind a cancelling run, so the UI never looks stuck. */
  syncScheduled: boolean;
  selectionVersion: number;
  coverage: KnowledgeCoverage;
  graphVersion: number;
  lastSuccessfulSyncAt: string | null;
  offline: boolean;
  databasePath: string;
  error?: string;
};

/** One indexed passage, the only fact source for generated answers. */
export type RetrievedChunk = {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  rootTitle: string;
  headingPath: string;
  text: string;
  snippet: string;
  notionUrl: string;
  blockId: string | null;
  score: number;
  matchedTerms: string[];
};

export type KnowledgeSearchResponse = {
  chunks: RetrievedChunk[];
  conceptIds: string[];
  graphVersion: number;
};
