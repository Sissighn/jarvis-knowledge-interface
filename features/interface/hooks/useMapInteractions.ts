"use client";

import { useCallback, useRef, useState } from "react";
import type React from "react";
import type { KnowledgeNode, ViewMode } from "../types";
import type { CanvasSize, MapPoint } from "../map/types";
import {
  focusMapOn,
  mapSceneCenter,
  panMap,
  resetMapViewport,
  zoomMapAt,
  type MapViewport,
} from "../map/map-viewport";

type MapInteractionOptions = {
  mode: ViewMode;
  viewportRef: React.MutableRefObject<MapViewport>;
  mapPointsRef: React.MutableRefObject<MapPoint[]>;
  canvasSizeRef: React.MutableRefObject<CanvasSize>;
  selectedNodeId: string;
  onSelect: (node: KnowledgeNode) => void;
};

const HIT_RADIUS = 26;

export function useMapInteractions({
  mode,
  viewportRef,
  mapPointsRef,
  canvasSizeRef,
  selectedNodeId,
  onSelect,
}: MapInteractionOptions) {
  const hoveredNodeRef = useRef<string | null>(null);
  const [focusActive, setFocusActive] = useState(false);
  const gestureRef = useRef({
    dragging: false,
    moved: false,
    pointerId: -1,
    lastX: 0,
    lastY: 0,
    startX: 0,
    startY: 0,
  });

  const localPoint = useCallback((event: React.PointerEvent<HTMLCanvasElement> | React.WheelEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const closestPoint = useCallback((x: number, y: number, threshold = HIT_RADIUS) => {
    let closest: MapPoint | null = null;
    let closestDistance = threshold;
    for (const point of mapPointsRef.current) {
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance < closestDistance) {
        closest = point;
        closestDistance = distance;
      }
    }
    return closest;
  }, [mapPointsRef]);

  const clearFocus = useCallback(() => setFocusActive(false), []);

  const resetView = useCallback(() => {
    const { width, height } = canvasSizeRef.current;
    resetMapViewport(viewportRef.current, width, height);
    setFocusActive(false);
  }, [canvasSizeRef, viewportRef]);

  const zoomAtCenter = useCallback((factor: number) => {
    const { width, height } = canvasSizeRef.current;
    const center = mapSceneCenter(width, height);
    zoomMapAt(
      viewportRef.current,
      center,
      center,
      viewportRef.current.targetZoom * factor,
    );
  }, [canvasSizeRef, viewportRef]);

  const focusSelection = useCallback(() => {
    const selected = mapPointsRef.current.find((point) => point.node.id === selectedNodeId);
    if (!selected) return;
    const { width, height } = canvasSizeRef.current;
    const center = mapSceneCenter(width, height);
    focusMapOn(
      viewportRef.current,
      { x: selected.worldX, y: selected.worldY },
      center,
    );
    setFocusActive(true);
  }, [canvasSizeRef, mapPointsRef, selectedNodeId, viewportRef]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode !== "map") return;
    const gesture = gestureRef.current;
    const point = localPoint(event);
    if (gesture.dragging) {
      const deltaX = event.clientX - gesture.lastX;
      const deltaY = event.clientY - gesture.lastY;
      if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 4) gesture.moved = true;
      const { width, height } = canvasSizeRef.current;
      panMap(viewportRef.current, deltaX, deltaY, width, height);
      viewportRef.current.x = viewportRef.current.targetX;
      viewportRef.current.y = viewportRef.current.targetY;
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
      hoveredNodeRef.current = null;
      event.currentTarget.style.cursor = "grabbing";
      return;
    }
    const closest = closestPoint(point.x, point.y);
    hoveredNodeRef.current = closest?.node.id ?? null;
    event.currentTarget.style.cursor = closest ? "pointer" : "grab";
  }, [canvasSizeRef, closestPoint, localPoint, mode, viewportRef]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode !== "map" || event.button !== 0) return;
    const point = localPoint(event);
    const hit = closestPoint(point.x, point.y);
    if (hit) {
      onSelect(hit.node);
      setFocusActive(true);
      return;
    }
    const gesture = gestureRef.current;
    gesture.dragging = true;
    gesture.moved = false;
    gesture.pointerId = event.pointerId;
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
    gesture.startX = event.clientX;
    gesture.startY = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.style.cursor = "grabbing";
  }, [closestPoint, localPoint, mode, onSelect]);

  const endPointer = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode !== "map") return;
    const gesture = gestureRef.current;
    if (!gesture.dragging) return;
    const wasMoved = gesture.moved;
    gesture.dragging = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    event.currentTarget.style.cursor = "grab";
    if (!wasMoved) setFocusActive(false);
  }, [mode]);

  const onWheel = useCallback((event: React.WheelEvent<HTMLCanvasElement>) => {
    if (mode !== "map") return;
    event.preventDefault();
    const point = localPoint(event);
    const { width, height } = canvasSizeRef.current;
    const factor = Math.exp(-event.deltaY * 0.0014);
    zoomMapAt(
      viewportRef.current,
      point,
      mapSceneCenter(width, height),
      viewportRef.current.targetZoom * factor,
    );
  }, [canvasSizeRef, localPoint, mode, viewportRef]);

  const onDoubleClick = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== "map") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const hit = closestPoint(event.clientX - rect.left, event.clientY - rect.top, 32);
    if (hit?.node.kind !== "system" && hit?.node.url) {
      window.open(hit.node.url, "_blank", "noopener,noreferrer");
    }
  }, [closestPoint, mode]);

  const onPointerLeave = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    hoveredNodeRef.current = null;
    if (mode === "map" && !gestureRef.current.dragging) event.currentTarget.style.cursor = "grab";
  }, [mode]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (mode !== "map") return;
    if (event.key === "Escape") {
      clearFocus();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomAtCenter(1.18);
    } else if (event.key === "-") {
      event.preventDefault();
      zoomAtCenter(1 / 1.18);
    } else if (event.key === "0") {
      event.preventDefault();
      resetView();
    } else if (event.key.toLocaleLowerCase("de-DE") === "f") {
      event.preventDefault();
      focusSelection();
    }
  }, [clearFocus, focusSelection, mode, resetView, zoomAtCenter]);

  return {
    hoveredNodeRef,
    focusActive,
    clearFocus,
    focusSelection,
    resetView,
    zoomIn: () => zoomAtCenter(1.18),
    zoomOut: () => zoomAtCenter(1 / 1.18),
    onPointerMove,
    onPointerDown,
    onPointerUp: endPointer,
    onPointerCancel: endPointer,
    onPointerLeave,
    onWheel,
    onDoubleClick,
    onKeyDown,
  };
}
