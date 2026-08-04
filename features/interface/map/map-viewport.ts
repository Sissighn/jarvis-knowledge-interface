export type Point = { x: number; y: number };

export type MapViewport = {
  x: number;
  y: number;
  zoom: number;
  targetX: number;
  targetY: number;
  targetZoom: number;
};

export const MAP_MIN_ZOOM = 0.65;
export const MAP_MAX_ZOOM = 2.5;

export function mapSceneCenter(width: number, height: number): Point {
  return { x: width / 2, y: height / 2 - Math.min(8, height * 0.015) };
}

export function clampMapZoom(zoom: number) {
  return Math.min(MAP_MAX_ZOOM, Math.max(MAP_MIN_ZOOM, zoom));
}

export function defaultMapZoom(width: number, height: number) {
  if (width < 520 || height < 470) return 0.86;
  if (width < 700 || height < 600) return 0.94;
  return 1;
}

export function createMapViewport(width = 0, height = 0): MapViewport {
  const zoom = defaultMapZoom(width, height);
  return { x: 0, y: 0, zoom, targetX: 0, targetY: 0, targetZoom: zoom };
}

export function worldToScreen(point: Point, viewport: MapViewport, center: Point): Point {
  return {
    x: center.x + (point.x - center.x) * viewport.zoom + viewport.x,
    y: center.y + (point.y - center.y) * viewport.zoom + viewport.y,
  };
}

export function screenToWorld(point: Point, viewport: MapViewport, center: Point): Point {
  return {
    x: center.x + (point.x - center.x - viewport.x) / viewport.zoom,
    y: center.y + (point.y - center.y - viewport.y) / viewport.zoom,
  };
}

export function zoomMapAt(viewport: MapViewport, point: Point, center: Point, requestedZoom: number) {
  const targetView = {
    ...viewport,
    x: viewport.targetX,
    y: viewport.targetY,
    zoom: viewport.targetZoom,
  };
  const worldPoint = screenToWorld(point, targetView, center);
  const nextZoom = clampMapZoom(requestedZoom);
  viewport.targetZoom = nextZoom;
  viewport.targetX = point.x - center.x - (worldPoint.x - center.x) * nextZoom;
  viewport.targetY = point.y - center.y - (worldPoint.y - center.y) * nextZoom;
}

export function panMap(viewport: MapViewport, deltaX: number, deltaY: number, width: number, height: number) {
  const maximumX = Math.max(120, width * 0.72);
  const maximumY = Math.max(100, height * 0.72);
  viewport.targetX = Math.min(maximumX, Math.max(-maximumX, viewport.targetX + deltaX));
  viewport.targetY = Math.min(maximumY, Math.max(-maximumY, viewport.targetY + deltaY));
}

export function focusMapOn(viewport: MapViewport, worldPoint: Point, center: Point, zoom = 1.35) {
  const nextZoom = clampMapZoom(Math.max(zoom, viewport.targetZoom));
  viewport.targetZoom = nextZoom;
  viewport.targetX = -(worldPoint.x - center.x) * nextZoom;
  viewport.targetY = -(worldPoint.y - center.y) * nextZoom;
}

export function resetMapViewport(viewport: MapViewport, width: number, height: number, immediate = false) {
  const zoom = defaultMapZoom(width, height);
  viewport.targetX = 0;
  viewport.targetY = 0;
  viewport.targetZoom = zoom;
  if (immediate) {
    viewport.x = 0;
    viewport.y = 0;
    viewport.zoom = zoom;
  }
}

export function stepMapViewport(viewport: MapViewport, reducedMotion: boolean) {
  const easing = reducedMotion ? 1 : 0.16;
  viewport.x += (viewport.targetX - viewport.x) * easing;
  viewport.y += (viewport.targetY - viewport.y) * easing;
  viewport.zoom += (viewport.targetZoom - viewport.zoom) * easing;
  if (Math.abs(viewport.targetX - viewport.x) < 0.01) viewport.x = viewport.targetX;
  if (Math.abs(viewport.targetY - viewport.y) < 0.01) viewport.y = viewport.targetY;
  if (Math.abs(viewport.targetZoom - viewport.zoom) < 0.0001) viewport.zoom = viewport.targetZoom;
}
