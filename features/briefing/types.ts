import type { DailyTechVocabulary } from "@/features/glossary/types";

export type BriefingSource = "techpresso" | "github" | "openai" | "hackernews";

export type BriefingItem = {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: BriefingSource;
  sourceLabel: string;
  publishedAt: string;
  score: number;
  priority: "important" | "worth_knowing";
  topics: string[];
  matchedTopics: string[];
};

export type BriefingSourceStatus = {
  source: BriefingSource;
  label: string;
  ok: boolean;
  count: number;
  error?: string;
};

export type DailyBriefing = {
  date: string;
  generatedAt: string;
  items: BriefingItem[];
  sourceStatus: BriefingSourceStatus[];
  vocabulary: DailyTechVocabulary;
};
