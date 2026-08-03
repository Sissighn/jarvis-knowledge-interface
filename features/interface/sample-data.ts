import type { KnowledgeEdge, KnowledgeNode } from "./types";

export const sampleKnowledgeNodes: KnowledgeNode[] = [
  { id: "jarvis", label: "JARVIS", group: "System", kind: "system", x: 0, y: 0, size: 7 },
  { id: "uni", label: "Universität", group: "Universität", kind: "page", x: -0.31, y: -0.2, size: 6 },
  { id: "economics", label: "Wirtschaft", group: "Universität", kind: "page", x: -0.44, y: 0.1, size: 4 },
  { id: "statistics", label: "Statistik", group: "Universität", kind: "page", x: -0.24, y: 0.26, size: 4 },
  { id: "projects", label: "Projekte", group: "Projekte", kind: "page", x: 0.31, y: -0.24, size: 6 },
  { id: "notion", label: "Notion", group: "Projekte", kind: "page", x: 0.45, y: 0.02, size: 4 },
  { id: "ideas", label: "Ideen", group: "Ideen", kind: "page", x: 0.27, y: 0.27, size: 5 },
  { id: "learning", label: "Lernsystem", group: "Ideen", kind: "page", x: -0.04, y: 0.36, size: 4 },
  { id: "productivity", label: "Produktivität", group: "Ideen", kind: "page", x: 0.08, y: -0.37, size: 5 },
];

export const sampleGraphEdges: KnowledgeEdge[] = [
  { source: "jarvis", target: "uni", type: "root" },
  { source: "jarvis", target: "projects", type: "root" },
  { source: "jarvis", target: "ideas", type: "root" },
  { source: "jarvis", target: "productivity", type: "root" },
  { source: "uni", target: "economics", type: "parent" },
  { source: "uni", target: "statistics", type: "parent" },
  { source: "statistics", target: "learning", type: "mention" },
  { source: "projects", target: "notion", type: "parent" },
  { source: "notion", target: "ideas", type: "relation" },
  { source: "ideas", target: "learning", type: "relation" },
  { source: "learning", target: "productivity", type: "mention" },
  { source: "notion", target: "productivity", type: "relation" },
];
