import type { ConceptNode } from "../types";

export type MapPoint = {
  node: ConceptNode;
  x: number;
  y: number;
  worldX: number;
  worldY: number;
};

export type CanvasSize = { width: number; height: number };
