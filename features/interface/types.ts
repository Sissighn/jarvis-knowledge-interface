export type CoreState = "idle" | "listening" | "transcribing" | "thinking";
export type ViewMode = "core" | "map";

export type { KnowledgeEdge, KnowledgeNode, NotionGraph as GraphPayload, NotionStatus } from "@/features/knowledge/types";
export type { BriefingItem, DailyBriefing } from "@/features/briefing/types";
export type { WeatherPayload } from "@/features/weather/types";
export type { LocalModelStatus } from "@/features/ai/types";
