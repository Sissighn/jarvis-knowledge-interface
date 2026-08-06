export type CoreState = "idle" | "listening" | "transcribing" | "thinking" | "speaking";
export type ViewMode = "core" | "map";

export type {
  AreaLabelSource,
  ConceptDetail,
  ConceptEdge,
  ConceptNode,
  ConceptOccurrence,
  KnowledgeArea,
  KnowledgeCoverage,
  KnowledgeGraph,
  KnowledgeRoot,
  KnowledgeStatus,
  NotionStatus,
  NotionKnowledgeDatabase,
  RetrievedChunk,
  SyncPhase,
  SyncProgress,
} from "@/features/knowledge/types";
export type { BriefingItem, DailyBriefing } from "@/features/briefing/types";
export type { WeatherPayload } from "@/features/weather/types";
export type { LocalModelStatus } from "@/features/ai/types";
