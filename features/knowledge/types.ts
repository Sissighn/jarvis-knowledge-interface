export type KnowledgeNode = {
  id: string;
  label: string;
  group: string;
  kind: "system" | "page" | "data_source";
  x: number;
  y: number;
  size: number;
  url?: string;
  icon?: string;
  content?: string;
  lastEdited?: string;
  keywords?: string[];
};

export type KnowledgeEdge = {
  source: string;
  target: string;
  type: "root" | "parent" | "relation" | "mention" | "child" | "similarity";
  weight?: number;
  reason?: string;
};

export type NotionStatus = {
  configured: boolean;
  connected: boolean;
  botName?: string;
  workspaceName?: string | null;
  error?: string;
};

export type NotionGraph = {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  syncedAt: string;
  pageCount: number;
  dataSourceCount: number;
  contentScannedCount: number;
  similarityEdgeCount: number;
  clusterCount: number;
};
