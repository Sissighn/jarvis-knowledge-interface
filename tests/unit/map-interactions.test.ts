import assert from "node:assert/strict";
import test from "node:test";
import { mapBreathingScale, mapGroupMotion, mapNodeMotion, quadraticPoint } from "../../features/interface/map/map-motion";
import {
  MAP_MAX_ZOOM,
  MAP_MIN_ZOOM,
  createMapViewport,
  defaultMapZoom,
  focusMapOn,
  panMap,
  resetMapViewport,
  screenToWorld,
  stepMapViewport,
  worldToScreen,
  zoomMapAt,
} from "../../features/interface/map/map-viewport";

test("converts map coordinates to screen coordinates and back", () => {
  const viewport = createMapViewport(1200, 800);
  viewport.x = 84;
  viewport.y = -37;
  viewport.zoom = 1.72;
  const center = { x: 600, y: 400 };
  const world = { x: 735, y: 288 };

  const screen = worldToScreen(world, viewport, center);
  const restored = screenToWorld(screen, viewport, center);

  assert.ok(Math.abs(restored.x - world.x) < 0.000001);
  assert.ok(Math.abs(restored.y - world.y) < 0.000001);
});

test("zooms around the pointer and respects the zoom limits", () => {
  const viewport = createMapViewport(1000, 700);
  const center = { x: 500, y: 350 };
  const pointer = { x: 690, y: 240 };
  const worldBefore = screenToWorld(pointer, viewport, center);

  zoomMapAt(viewport, pointer, center, 1.8);
  viewport.x = viewport.targetX;
  viewport.y = viewport.targetY;
  viewport.zoom = viewport.targetZoom;
  const worldAfter = screenToWorld(pointer, viewport, center);

  assert.ok(Math.abs(worldAfter.x - worldBefore.x) < 0.000001);
  assert.ok(Math.abs(worldAfter.y - worldBefore.y) < 0.000001);
  zoomMapAt(viewport, pointer, center, 99);
  assert.equal(viewport.targetZoom, MAP_MAX_ZOOM);
  zoomMapAt(viewport, pointer, center, 0.01);
  assert.equal(viewport.targetZoom, MAP_MIN_ZOOM);
});

test("focus centers a world point and reset restores a responsive overview", () => {
  const viewport = createMapViewport(1100, 720);
  const center = { x: 550, y: 360 };
  const selected = { x: 710, y: 280 };

  focusMapOn(viewport, selected, center);
  viewport.x = viewport.targetX;
  viewport.y = viewport.targetY;
  viewport.zoom = viewport.targetZoom;
  assert.deepEqual(worldToScreen(selected, viewport, center), center);

  resetMapViewport(viewport, 420, 440, true);
  assert.equal(viewport.x, 0);
  assert.equal(viewport.y, 0);
  assert.equal(viewport.zoom, defaultMapZoom(420, 440));
  assert.ok(viewport.zoom < 1);
});

test("pan remains recoverable and camera transitions converge", () => {
  const viewport = createMapViewport(800, 600);
  panMap(viewport, 10_000, -10_000, 800, 600);
  assert.equal(viewport.targetX, 576);
  assert.equal(viewport.targetY, -432);

  for (let index = 0; index < 100; index++) stepMapViewport(viewport, false);
  assert.ok(Math.abs(viewport.x - viewport.targetX) < 0.01);
  assert.ok(Math.abs(viewport.y - viewport.targetY) < 0.01);
});

test("organic map motion is deterministic, subtle, and disabled for reduced motion", () => {
  const firstNode = mapNodeMotion("notion-page-42", 12.5);
  const secondNode = mapNodeMotion("notion-page-42", 12.5);
  const group = mapGroupMotion("Machine Learning", 12.5);

  assert.deepEqual(firstNode, secondNode);
  assert.ok(Math.hypot(firstNode.x, firstNode.y) < 5.2);
  assert.ok(Math.hypot(group.x, group.y) < 3.3);
  assert.equal(mapBreathingScale("Machine Learning", 12.5, true), 1);
  assert.deepEqual(mapNodeMotion("notion-page-42", 12.5, true), { x: 0, y: 0 });
});

test("quadratic edge pulse stays on its connection curve", () => {
  assert.deepEqual(
    quadraticPoint({ x: 0, y: 0 }, { x: 5, y: 10 }, { x: 10, y: 0 }, 0.5),
    { x: 5, y: 5 },
  );
});
