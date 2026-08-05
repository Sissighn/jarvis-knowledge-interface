/**
 * The shared visual language of the JARVIS core sphere: additive pink ink, fine
 * drifting filaments, bowed links, short motion trails and small glowing points.
 * The knowledge map draws with the same primitives, so both views read as the
 * same object seen from two distances instead of two separate visualisations.
 */

export type StylePoint = { x: number; y: number };

/** Additive blending is what makes overlapping strands bloom instead of stack. */
export function beginNeuralInk(context: CanvasRenderingContext2D) {
  context.globalCompositeOperation = "lighter";
}

export function endNeuralInk(context: CanvasRenderingContext2D) {
  context.globalCompositeOperation = "source-over";
}

/** Long, faint strands that carry the hand-drawn neural silhouette. */
export function strokeNeuralFilament(
  context: CanvasRenderingContext2D,
  alpha: number,
  steps: number,
  pointAt: (progress: number, step: number) => StylePoint,
) {
  context.strokeStyle = `rgba(255, 218, 236, ${alpha})`;
  context.lineWidth = 0.42 + alpha * 4;
  context.beginPath();
  for (let step = 0; step <= steps; step++) {
    const point = pointAt(step / steps, step);
    if (step === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  }
  context.stroke();
}

/** Short trails make each point visibly travel through the structure. */
export function strokeNeuralTrail(context: CanvasRenderingContext2D, trail: StylePoint[], bright: boolean) {
  if (trail.length < 2) return;
  context.strokeStyle = `rgba(255, 211, 232, ${bright ? 0.22 : 0.038})`;
  context.lineWidth = bright ? 0.75 : 0.32;
  context.beginPath();
  for (const [index, point] of trail.entries()) {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  }
  context.stroke();
}

/**
 * Bowed links read as a living network rather than a construction grid.
 * Returns the control point so callers can send a pulse along the same curve.
 */
export function strokeNeuralLink(
  context: CanvasRenderingContext2D,
  a: StylePoint,
  b: StylePoint,
  opacity: number,
  bow: number,
): StylePoint {
  const control = { x: (a.x + b.x) / 2 + bow, y: (a.y + b.y) / 2 - bow };
  context.strokeStyle = `rgba(255, 216, 235, ${opacity})`;
  context.lineWidth = 0.34 + opacity * 1.8;
  context.beginPath();
  context.moveTo(a.x, a.y);
  context.quadraticCurveTo(control.x, control.y, b.x, b.y);
  context.stroke();
  return control;
}

/** A bright grain travelling along a strand. */
export function fillNeuralPulse(context: CanvasRenderingContext2D, point: StylePoint, radius: number) {
  const glow = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
  glow.addColorStop(0, "rgba(255,250,253,.95)");
  glow.addColorStop(1, "rgba(255,176,214,0)");
  context.fillStyle = glow;
  context.beginPath();
  context.arc(point.x, point.y, radius, 0, Math.PI * 2);
  context.fill();
}

export function fillNeuralPoint(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  { alpha, radius, bright, glowRadius = 10 }: { alpha: number; radius: number; bright: boolean; glowRadius?: number },
) {
  if (bright) {
    const glow = context.createRadialGradient(x, y, 0, x, y, glowRadius);
    glow.addColorStop(0, "rgba(255,255,255,.95)");
    glow.addColorStop(0.18, "rgba(255,205,229,.58)");
    glow.addColorStop(1, "rgba(255,205,229,0)");
    context.fillStyle = glow;
    context.beginPath();
    context.arc(x, y, glowRadius, 0, Math.PI * 2);
    context.fill();
  }
  context.fillStyle = `rgba(255, 240, 247, ${Math.min(1, alpha + (bright ? 0.35 : 0))})`;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
}

/** The soft field that gives the structure its volume. Drawn in source-over. */
export function fillNeuralHalo(
  context: CanvasRenderingContext2D,
  { x, y, radius, width, height, accent }:
    { x: number; y: number; radius: number; width: number; height: number; accent: string },
) {
  const halo = context.createRadialGradient(x, y, radius * 0.1, x, y, radius * 1.24);
  halo.addColorStop(0, "rgba(14, 7, 11, 0)");
  halo.addColorStop(0.67, accent);
  halo.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = halo;
  context.fillRect(0, 0, width, height);
}

/** The falloff the sphere uses to separate its front from its back. */
export function neuralDepthAlpha(depth: number) {
  return Math.max(0.06, 0.18 + (depth + 0.5) * 0.46);
}

/** The matching size falloff, so distant points also read as smaller. */
export function neuralDepthScale(depth: number) {
  return 0.92 + depth * 0.105;
}
