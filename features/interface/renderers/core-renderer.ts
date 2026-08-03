import type { CoreState } from "../types";

export type CoreBounds = { x: number; y: number; radius: number };
export type CorePointer = { x: number; y: number; active: boolean };
export type CoreRotation = {
  targetX: number;
  targetY: number;
  currentX: number;
  currentY: number;
  velocityX: number;
  velocityY: number;
  dragging: boolean;
  lastX: number;
  lastY: number;
};
export type CoreParticle = {
  u: number;
  v: number;
  phase: number;
  speedU: number;
  speedV: number;
  drift: number;
  bright: boolean;
  trail: Array<{ x: number; y: number }>;
};
export type CoreFilament = {
  u: number;
  v: number;
  phase: number;
  speed: number;
  span: number;
  alpha: number;
};

type CoreFrameOptions = {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  time: number;
  state: CoreState;
  coreBounds: { current: CoreBounds };
  rotation: CoreRotation;
  pointer: CorePointer;
  hoverX: number;
  hoverY: number;
  particles: CoreParticle[];
  filaments: CoreFilament[];
};

export function renderCoreFrame({
  context,
  width,
  height,
  time,
  state,
  coreBounds,
  rotation,
  pointer,
  hoverX,
  hoverY,
  particles,
  filaments,
}: CoreFrameOptions) {
  const cx = width / 2;
  const cy = height / 2 - Math.min(12, height * 0.02);
  const baseRadius = Math.min(width, height) * (width < 720 ? 0.34 : 0.37);
  const statePulse = state === "listening" ? 1.07 : state === "thinking" ? 0.95 : 1;
  const pulse = statePulse + Math.sin(time * (state === "thinking" ? 3.2 : 1.2)) * 0.018;
  coreBounds.current = { x: cx, y: cy, radius: baseRadius * 1.02 * pulse };
  const projected: Array<{ x: number; y: number; z: number; a: number; bright: boolean; trail: Array<{ x: number; y: number }> }> = [];
  const flowSpeed = state === "thinking" ? 1.7 : state === "listening" ? 1.25 : 1;
    if (!rotation.dragging) {
    rotation.targetY += rotation.velocityY;
    rotation.targetX = Math.max(-0.88, Math.min(0.88, rotation.targetX + rotation.velocityX));
    rotation.velocityX *= 0.92;
    rotation.velocityY *= 0.92;
  }
  rotation.currentX += (rotation.targetX - rotation.currentX) * 0.11;
  rotation.currentY += (rotation.targetY - rotation.currentY) * 0.11;
  hoverX += ((pointer.active ? pointer.x : 0) - hoverX) * 0.055;
  hoverY += ((pointer.active ? pointer.y : 0) - hoverY) * 0.055;
  const rotY = time * 0.16 * flowSpeed + rotation.currentY + hoverX * 0.24;
  const rotX = -0.16 + rotation.currentX + hoverY * 0.16;

  const projectFlowPoint = (u: number, v: number, phase: number) => {
    const longitude = u + Math.sin(v * 2.1 + time * 0.72 + phase) * 0.085;
    const movingLatitude = v
      + Math.sin(u * 2.7 - time * 0.38 + phase) * 0.11
      + Math.sin(time * 0.24 + phase) * 0.035;
    const latitude = Math.asin(Math.sin(movingLatitude));
    const radius = 0.88
      + Math.sin(longitude * 3 + phase + time * 0.34) * 0.045
      + Math.sin(latitude * 5 - time * 0.28 + phase) * 0.025;
    const latitudeRadius = Math.cos(latitude);
    let x = radius * latitudeRadius * Math.cos(longitude);
    let y = radius * Math.sin(latitude);
    const z = radius * latitudeRadius * Math.sin(longitude);

    x *= 1.015;
    y *= 0.985;

    const x1 = x * Math.cos(rotY) - z * Math.sin(rotY);
    const z1 = x * Math.sin(rotY) + z * Math.cos(rotY);
    const y1 = y * Math.cos(rotX) - z1 * Math.sin(rotX);
    const z2 = y * Math.sin(rotX) + z1 * Math.cos(rotX);
    const perspective = 0.92 + z2 * 0.105;
    return {
      x: cx + x1 * baseRadius * perspective * pulse,
      y: cy + y1 * baseRadius * perspective * pulse,
      z: z2,
      a: Math.max(0.06, 0.18 + (z2 + 0.5) * 0.46),
    };
  };

  for (const particle of particles) {
    const u = particle.u + time * particle.speedU * 0.22 * flowSpeed;
    const v = particle.v + time * particle.speedV * 0.075
      + Math.sin(time * particle.drift + particle.phase) * 0.075;
    const point = projectFlowPoint(u, v, particle.phase);
    particle.trail.push({ x: point.x, y: point.y });
    const maxTrail = particle.bright ? 18 : 7;
    if (particle.trail.length > maxTrail) particle.trail.shift();
    projected.push({ ...point, bright: particle.bright, trail: particle.trail });
  }

  context.globalCompositeOperation = "lighter";

  // Long, moving filaments create the fluid, hand-drawn neural silhouette.
  for (const filament of filaments) {
    context.strokeStyle = `rgba(255, 218, 236, ${filament.alpha})`;
    context.lineWidth = 0.42 + filament.alpha * 4;
    context.beginPath();
    for (let step = 0; step <= 34; step++) {
      const progress = step / 34;
      const u = filament.u + time * filament.speed * flowSpeed + progress * filament.span;
      const v = filament.v
        + progress * 0.32
        + Math.sin(progress * 8 + filament.phase + time * 0.8) * 0.24;
      const point = projectFlowPoint(u, v, filament.phase);
      if (step === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    }
    context.stroke();
  }

  // Short motion trails make each node visibly travel through the structure.
  for (const point of projected) {
    if (point.trail.length < 2) continue;
    context.strokeStyle = `rgba(255, 211, 232, ${point.bright ? 0.22 : 0.038})`;
    context.lineWidth = point.bright ? 0.75 : 0.32;
    context.beginPath();
    point.trail.forEach((trailPoint, index) => {
      if (index === 0) context.moveTo(trailPoint.x, trailPoint.y);
      else context.lineTo(trailPoint.x, trailPoint.y);
    });
    context.stroke();
  }

  // Connections are recalculated every frame, so the network never freezes.
  const linkDistance = baseRadius * 0.235;
  for (let i = 0; i < projected.length; i++) {
    const a = projected[i];
    let connections = 0;
    for (let offset = 1; offset <= 34 && connections < 4; offset++) {
      const b = projected[(i + offset * 17) % projected.length];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < linkDistance && Math.abs(a.z - b.z) < 0.42) {
        const opacity = Math.max(0, 1 - distance / linkDistance) * 0.19 * Math.min(a.a, b.a);
        context.strokeStyle = `rgba(255, 216, 235, ${opacity})`;
        context.lineWidth = 0.34 + opacity * 1.8;
        context.beginPath();
        context.moveTo(a.x, a.y);
        const bow = Math.sin(i * 1.7 + time * 1.7) * 4;
        context.quadraticCurveTo(
          (a.x + b.x) / 2 + bow,
          (a.y + b.y) / 2 - bow,
          b.x,
          b.y,
        );
        context.stroke();
        connections++;
      }
    }
  }

  for (const point of projected) {
    const pointRadius = point.bright ? 1.55 : 0.38 + point.a * 0.5;
    if (point.bright) {
      const glow = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, 10);
      glow.addColorStop(0, "rgba(255,255,255,.95)");
      glow.addColorStop(0.18, "rgba(255,205,229,.58)");
      glow.addColorStop(1, "rgba(255,205,229,0)");
      context.fillStyle = glow;
      context.beginPath();
      context.arc(point.x, point.y, 10, 0, Math.PI * 2);
      context.fill();
    }
    context.fillStyle = `rgba(255, 240, 247, ${Math.min(1, point.a + (point.bright ? .35 : 0))})`;
    context.beginPath();
    context.arc(point.x, point.y, pointRadius, 0, Math.PI * 2);
    context.fill();
  }

  context.globalCompositeOperation = "source-over";

  const halo = context.createRadialGradient(cx, cy, baseRadius * 0.1, cx, cy, baseRadius * 1.24);
  halo.addColorStop(0, "rgba(14, 7, 11, 0)");
  halo.addColorStop(0.67, state === "listening" ? "rgba(255,174,213,.065)" : "rgba(255,193,222,.035)");
  halo.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = halo;
  context.fillRect(0, 0, width, height);

  return { hoverX, hoverY };
}

