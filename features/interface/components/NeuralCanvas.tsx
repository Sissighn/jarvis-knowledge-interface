"use client";

import type React from "react";
import { useEffect, useRef } from "react";
import type { ConceptEdge, ConceptNode, CoreState, ViewMode } from "../types";
import { renderCoreFrame } from "../renderers/core-renderer";
import { renderMapFrame } from "../renderers/map-renderer";
import { createMapViewport, resetMapViewport, stepMapViewport, type Point } from "../map/map-viewport";
import type { CanvasSize, MapPoint } from "../map/types";
import { useMapInteractions } from "../hooks/useMapInteractions";
import { MapControls } from "./MapControls";
import { createForceSimulation, syncForceSimulation } from "../map/force-simulation";

export function NeuralCanvas({ state, speechActivity, mode, nodes, edges, selectedNodeId, highlightedNodeIds, onSelect }: {
  state: CoreState;
  speechActivity: { current: number };
  mode: ViewMode;
  nodes: ConceptNode[];
  edges: ConceptEdge[];
  selectedNodeId: string;
  highlightedNodeIds: string[];
  onSelect: (node: ConceptNode) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef({ x: 0, y: 0, active: false });
  const rotationRef = useRef({
    targetX: 0,
    targetY: 0,
    currentX: 0,
    currentY: 0,
    velocityX: 0,
    velocityY: 0,
    dragging: false,
    lastX: 0,
    lastY: 0,
  });
  const coreBoundsRef = useRef({ x: 0, y: 0, radius: 0 });
  const mapPointsRef = useRef<MapPoint[]>([]);
  // Trails outlive the draw effect so a graph update does not wipe the motion history.
  const mapTrailsRef = useRef(new Map<string, Point[]>());
  const canvasSizeRef = useRef<CanvasSize>({ width: 0, height: 0 });
  const viewportRef = useRef(createMapViewport());
  const forceSimulationRef = useRef(createForceSimulation(nodes, edges));
  useEffect(() => syncForceSimulation(forceSimulationRef.current, nodes, edges), [nodes, edges]);
  const {
    hoveredNodeRef: mapHoveredNodeRef,
    focusActive: mapFocusActive,
    clearFocus: clearMapFocus,
    focusSelection,
    resetView: resetMapView,
    zoomIn: zoomMapIn,
    zoomOut: zoomMapOut,
    onPointerMove: moveMapPointer,
    onPointerDown: startMapPointer,
    onPointerUp: endMapPointer,
    onPointerCancel: cancelMapPointer,
    onPointerLeave: leaveMapPointer,
    onWheel: zoomMapWithWheel,
    onDoubleClick: openMapNode,
    onKeyDown: handleMapKey,
  } = useMapInteractions({
    mode,
    viewportRef,
    mapPointsRef,
    canvasSizeRef,
    selectedNodeId,
    onSelect,
    forceSimulationRef,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let animationFrame = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let backingWidth = 0;
    let backingHeight = 0;
    let time = 0;
    let hoverX = 0;
    let hoverY = 0;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const particleCount = window.innerWidth < 720 ? 190 : 320;
    const particles = Array.from({ length: particleCount }, () => {
      return {
        u: Math.random() * Math.PI * 2,
        v: Math.asin(Math.random() * 2 - 1),
        phase: Math.random() * Math.PI * 2,
        speedU: 0.45 + Math.random() * 0.85,
        speedV: (Math.random() - 0.5) * 0.55,
        drift: 0.65 + Math.random() * 1.9,
        bright: Math.random() > 0.9,
        trail: [] as Array<{ x: number; y: number }>,
      };
    });
    const filaments = Array.from({ length: window.innerWidth < 720 ? 24 : 42 }, () => ({
      u: Math.random() * Math.PI * 2,
      v: Math.asin(Math.random() * 2 - 1),
      phase: Math.random() * Math.PI * 2,
      speed: 0.2 + Math.random() * 0.42,
      span: 0.7 + Math.random() * 1.5,
      alpha: 0.035 + Math.random() * 0.09,
    }));

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      const nextWidth = Math.floor(width * dpr);
      const nextHeight = Math.floor(height * dpr);
      if (backingWidth === nextWidth && backingHeight === nextHeight) return;
      const firstMeasurement = canvasSizeRef.current.width === 0 || canvasSizeRef.current.height === 0;
      canvasSizeRef.current = { width, height };
      backingWidth = nextWidth;
      backingHeight = nextHeight;
      canvas.width = nextWidth;
      canvas.height = nextHeight;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      particles.forEach((particle) => { particle.trail.length = 0; });
      resetMapViewport(viewportRef.current, width, height, firstMeasurement);
    };



    const draw = () => {
      context.clearRect(0, 0, width, height);
      const vignette = context.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.7);
      vignette.addColorStop(0, "rgba(14,8,11,.08)");
      vignette.addColorStop(1, "rgba(0,0,0,.44)");
      context.fillStyle = vignette;
      context.fillRect(0, 0, width, height);
      // Only the map replaces the core; the task workspace keeps the sphere between its rails.
      if (mode !== "map") {
        const hover = renderCoreFrame({
          context,
          width,
          height,
          time,
          state,
          speechActivity: state === "speaking" ? speechActivity.current : 0,
          coreBounds: coreBoundsRef,
          rotation: rotationRef.current,
          pointer: pointerRef.current,
          hoverX,
          hoverY,
          particles,
          filaments,
        });
        hoverX = hover.hoverX;
        hoverY = hover.hoverY;
      } else {
        stepMapViewport(viewportRef.current, reduceMotion);
        renderMapFrame({
          context,
          width,
          height,
          time,
          nodes,
          edges,
          selectedNodeId,
          highlightedNodeIds,
          hoveredNodeId: mapHoveredNodeRef.current,
          mapPoints: mapPointsRef,
          trails: mapTrailsRef,
          viewport: viewportRef.current,
          focusActive: mapFocusActive,
          reducedMotion: reduceMotion,
          simulation: forceSimulationRef.current,
        });
      }
      if (!reduceMotion) time += 0.012;
      animationFrame = requestAnimationFrame(draw);
    };

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    window.addEventListener("resize", resize);
    draw();
    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [state, speechActivity, mode, nodes, edges, selectedNodeId, highlightedNodeIds, mapFocusActive, mapHoveredNodeRef]);

  const isInsideCore = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const bounds = coreBoundsRef.current;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return bounds.radius > 0 && Math.hypot(x - bounds.x, y - bounds.y) <= bounds.radius;
  };

  const updatePointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    if (mode !== "map") {
      const rotation = rotationRef.current;
      const insideCore = isInsideCore(event);
      pointerRef.current = {
        x: (localX / rect.width - 0.5) * 2,
        y: (localY / rect.height - 0.5) * 2,
        active: insideCore && !rotation.dragging,
      };
      if (rotation.dragging) {
        const deltaX = event.clientX - rotation.lastX;
        const deltaY = event.clientY - rotation.lastY;
        rotation.targetY += deltaX * 0.009;
        rotation.targetX = Math.max(-0.88, Math.min(0.88, rotation.targetX + deltaY * 0.009));
        rotation.velocityY = deltaX * 0.00075;
        rotation.velocityX = deltaY * 0.00075;
        rotation.lastX = event.clientX;
        rotation.lastY = event.clientY;
      }
      event.currentTarget.style.cursor = rotation.dragging ? "grabbing" : insideCore ? "grab" : "default";
      return;
    }
    moveMapPointer(event);
  };

  const startCanvasInteraction = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode === "map") {
      startMapPointer(event);
      return;
    }
    if (!isInsideCore(event)) {
      pointerRef.current.active = false;
      event.currentTarget.style.cursor = "default";
      return;
    }
    const rotation = rotationRef.current;
    rotation.dragging = true;
    rotation.lastX = event.clientX;
    rotation.lastY = event.clientY;
    rotation.velocityX = 0;
    rotation.velocityY = 0;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.style.cursor = "grabbing";
  };

  const endCanvasInteraction = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode === "map") {
      endMapPointer(event);
      return;
    }
    rotationRef.current.dragging = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.currentTarget.style.cursor = isInsideCore(event) ? "grab" : "default";
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        className={`neural-canvas mode-${mode}`}
        aria-label={mode === "map"
          ? "Interaktiver Wissensgraph. Ziehen zum Verschieben, Mausrad zum Zoomen."
          : "Animierter neuronaler Jarvis-Kern"}
        tabIndex={mode === "map" ? 0 : -1}
        onPointerMove={updatePointer}
        onPointerLeave={(event) => {
          pointerRef.current.active = false;
          if (mode === "map") {
            leaveMapPointer(event);
          } else {
            event.currentTarget.style.cursor = rotationRef.current.dragging ? "grabbing" : "default";
          }
        }}
        onPointerDown={startCanvasInteraction}
        onPointerUp={endCanvasInteraction}
        onPointerCancel={(event) => {
          if (mode === "map") cancelMapPointer(event);
          else endCanvasInteraction(event);
        }}
        onWheel={zoomMapWithWheel}
        onDoubleClick={openMapNode}
        onKeyDown={handleMapKey}
      />
      {mode === "map" ? (
        <MapControls
          canFocus={nodes.some((node) => node.id === selectedNodeId && node.kind !== "system")}
          focusActive={mapFocusActive}
          onZoomIn={zoomMapIn}
          onZoomOut={zoomMapOut}
          onReset={resetMapView}
          onFocus={focusSelection}
          onClearFocus={clearMapFocus}
        />
      ) : null}
    </>
  );
}
