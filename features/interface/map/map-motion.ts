import type { Point } from "./map-viewport";

function stableUnit(value: string, salt: number) {
  let hash = 2166136261 ^ salt;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

export function mapGroupMotion(group: string, time: number, reducedMotion = false): Point {
  if (reducedMotion) return { x: 0, y: 0 };
  const phase = stableUnit(group, 17) * Math.PI * 2;
  const phaseY = stableUnit(group, 53) * Math.PI * 2;
  return {
    x: Math.sin(time * 0.31 + phase) * 2.4,
    y: Math.cos(time * 0.27 + phaseY) * 2.1,
  };
}

export function mapNodeMotion(nodeId: string, time: number, reducedMotion = false): Point {
  if (reducedMotion) return { x: 0, y: 0 };
  const phase = stableUnit(nodeId, 101) * Math.PI * 2;
  const phaseY = stableUnit(nodeId, 211) * Math.PI * 2;
  const amplitude = 1.4 + stableUnit(nodeId, 307) * 2.2;
  return {
    x: Math.sin(time * (0.48 + stableUnit(nodeId, 401) * 0.18) + phase) * amplitude,
    y: Math.cos(time * (0.42 + stableUnit(nodeId, 503) * 0.17) + phaseY) * amplitude * 0.82,
  };
}

export function mapBreathingScale(group: string, time: number, reducedMotion = false) {
  if (reducedMotion) return 1;
  const phase = stableUnit(group, 701) * Math.PI * 2;
  return 1 + Math.sin(time * 0.22 + phase) * 0.012;
}

export function quadraticPoint(start: Point, control: Point, end: Point, progress: number): Point {
  const inverse = 1 - progress;
  return {
    x: inverse * inverse * start.x + 2 * inverse * progress * control.x + progress * progress * end.x,
    y: inverse * inverse * start.y + 2 * inverse * progress * control.y + progress * progress * end.y,
  };
}
