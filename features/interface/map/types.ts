import type { KnowledgeNode } from "../types";

export type MapPoint = {
  node: KnowledgeNode;
  x: number;
  y: number;
  worldX: number;
  worldY: number;
};

export type CanvasSize = { width: number; height: number };
