import type { KnowledgeEdge, KnowledgeNode } from "../types";
import { mapBreathingScale, mapGroupMotion, mapNodeMotion, quadraticPoint } from "../map/map-motion";
import type { MapPoint } from "../map/types";
import { mapSceneCenter, worldToScreen, type MapViewport } from "../map/map-viewport";

type MapFrameOptions = {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  time: number;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  selectedNodeId: string;
  highlightedNodeIds: string[];
  hoveredNodeId: string | null;
  mapPoints: { current: MapPoint[] };
  viewport: MapViewport;
  focusActive: boolean;
  reducedMotion: boolean;
};

export function renderMapFrame({
  context,
  width,
  height,
  time,
  nodes,
  edges,
  selectedNodeId,
  highlightedNodeIds,
  hoveredNodeId,
  mapPoints,
  viewport,
  focusActive,
  reducedMotion,
}: MapFrameOptions) {
  type PositionedNode = KnowledgeNode & {
    px: number;
    py: number;
    worldX: number;
    worldY: number;
    groupIndex: number;
    column: number;
    ring: number;
  };
  type MapGroup = {
    name: string;
    index: number;
    startAngle: number;
    endAngle: number;
    midAngle: number;
    hubX: number;
    hubY: number;
    members: PositionedNode[];
  };

  const center = mapSceneCenter(width, height);
  const { x: cx, y: cy } = center;
  const screenCenter = worldToScreen(center, viewport, center);
  const radius = Math.max(72, Math.min(width * 0.4, height * 0.39, 360));
  const pointOnMap = (angle: number, distance: number) => ({
    x: cx + Math.cos(angle) * radius * distance,
    y: cy + Math.sin(angle) * radius * distance,
  });
  const contentNodes = nodes.filter((node) => node.kind !== "system");
  const systemNode = nodes.find((node) => node.kind === "system");
  const membersByGroup = new Map<string, KnowledgeNode[]>();
  for (const node of contentNodes) {
    const members = membersByGroup.get(node.group) ?? [];
    members.push(node);
    membersByGroup.set(node.group, members);
  }
  const groupEntries = [...membersByGroup.entries()]
    .map(([name, members]) => ({ name, members: [...members].sort((a, b) => b.size - a.size || a.label.localeCompare(b.label, "de")) }))
    .sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name, "de"));
  const gap = Math.min(0.1, 0.52 / Math.max(1, groupEntries.length));
  const weights = groupEntries.map((group) => Math.sqrt(group.members.length) + 0.8);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
  const usableAngle = Math.PI * 2 - gap * groupEntries.length;
  let angleCursor = -Math.PI / 2 - Math.PI * 0.08;
  const positions: PositionedNode[] = [];
  const groups: MapGroup[] = [];

  if (systemNode) {
    const systemMotion = mapNodeMotion(systemNode.id, time, reducedMotion);
    const worldX = cx + systemMotion.x * 0.35;
    const worldY = cy + systemMotion.y * 0.35;
    const screen = worldToScreen({ x: worldX, y: worldY }, viewport, center);
    positions.push({ ...systemNode, px: screen.x, py: screen.y, worldX, worldY, groupIndex: -1, column: 0, ring: 0 });
  }

  groupEntries.forEach((group, groupIndex) => {
    const span = usableAngle * (weights[groupIndex] / totalWeight);
    const startAngle = angleCursor;
    const endAngle = angleCursor + span;
    const midAngle = (startAngle + endAngle) / 2;
    const baseHub = pointOnMap(midAngle, 0.29);
    const groupMotion = mapGroupMotion(group.name, time, reducedMotion);
    const breathingScale = mapBreathingScale(group.name, time, reducedMotion);
    const hubWorld = { x: baseHub.x + groupMotion.x * 0.65, y: baseHub.y + groupMotion.y * 0.65 };
    const hub = worldToScreen(hubWorld, viewport, center);
    const sectorMargin = Math.min(0.085, Math.max(0.02, span * 0.08));
    const columns = Math.max(1, Math.min(22, Math.ceil(Math.sqrt(group.members.length * span * 1.12))));
    const ringCount = Math.max(1, Math.ceil(group.members.length / columns));
    const positionedMembers = group.members.map((node, index) => {
      const ring = Math.floor(index / columns);
      const ringStart = ring * columns;
      const nodesInRing = Math.min(columns, group.members.length - ringStart);
      const column = index - ringStart;
      const stagger = ring % 2 === 0 ? 0 : 0.18;
      const usableSector = Math.max(0.03, span - sectorMargin * 2);
      const memberAngle = startAngle + sectorMargin
        + ((column + 0.5 + stagger) / Math.max(1, nodesInRing)) * usableSector;
      const radialPosition = ringCount === 1
        ? 0.76
        : 0.51 + (ring / Math.max(1, ringCount - 1)) * 0.43;
      const basePoint = pointOnMap(memberAngle, radialPosition * breathingScale);
      const nodeMotion = mapNodeMotion(node.id, time, reducedMotion);
      const worldX = basePoint.x + groupMotion.x + nodeMotion.x;
      const worldY = basePoint.y + groupMotion.y + nodeMotion.y;
      const point = worldToScreen({ x: worldX, y: worldY }, viewport, center);
      const positioned = { ...node, px: point.x, py: point.y, worldX, worldY, groupIndex, column, ring };
      positions.push(positioned);
      return positioned;
    });
    groups.push({
      name: group.name,
      index: groupIndex,
      startAngle,
      endAngle,
      midAngle,
      hubX: hub.x,
      hubY: hub.y,
      members: positionedMembers,
    });
    angleCursor += span + gap;
  });

  mapPoints.current = positions.map((node) => ({
    node,
    x: node.px,
    y: node.py,
    worldX: node.worldX,
    worldY: node.worldY,
  }));
  const positionById = new Map(positions.map((node) => [node.id, node]));
  const selected = positionById.get(selectedNodeId);
  const selectedGroup = selected?.kind === "system" ? null : selected?.group;
  const searchMatches = new Set(highlightedNodeIds);
  const relatedIds = new Set<string>([selectedNodeId]);
  for (const edge of edges) {
    if (edge.source === selectedNodeId) relatedIds.add(edge.target);
    if (edge.target === selectedNodeId) relatedIds.add(edge.source);
  }

  // Topic sectors make the graph readable as a hierarchy before individual links appear.
  for (const group of groups) {
    const isSelectedGroup = group.name === selectedGroup;
    context.strokeStyle = isSelectedGroup ? "rgba(255, 211, 232, .26)" : "rgba(255, 211, 232, .085)";
    context.lineWidth = isSelectedGroup ? 1 : 0.55;
    context.beginPath();
    context.arc(screenCenter.x, screenCenter.y, radius * viewport.zoom, group.startAngle, group.endAngle);
    context.stroke();

    const sectorStartInner = worldToScreen(pointOnMap(group.startAngle, 0.45), viewport, center);
    const sectorStartOuter = worldToScreen(pointOnMap(group.startAngle, 1), viewport, center);
    context.strokeStyle = "rgba(255, 211, 232, .045)";
    context.beginPath();
    context.moveTo(sectorStartInner.x, sectorStartInner.y);
    context.lineTo(sectorStartOuter.x, sectorStartOuter.y);
    context.stroke();

    const trunkGradient = context.createLinearGradient(screenCenter.x, screenCenter.y, group.hubX, group.hubY);
    trunkGradient.addColorStop(0, "rgba(255, 225, 239, .3)");
    trunkGradient.addColorStop(1, isSelectedGroup ? "rgba(255, 196, 224, .5)" : "rgba(255, 211, 232, .16)");
    context.strokeStyle = trunkGradient;
    context.lineWidth = isSelectedGroup ? 1.25 : 0.72;
    context.beginPath();
    context.moveTo(screenCenter.x, screenCenter.y);
    context.quadraticCurveTo(
      screenCenter.x + Math.cos(group.midAngle) * radius * viewport.zoom * 0.13,
      screenCenter.y + Math.sin(group.midAngle) * radius * viewport.zoom * 0.13,
      group.hubX,
      group.hubY,
    );
    context.stroke();

    const membersByColumn = new Map<number, PositionedNode[]>();
    for (const node of group.members) {
      const columnMembers = membersByColumn.get(node.column) ?? [];
      columnMembers.push(node);
      membersByColumn.set(node.column, columnMembers);
    }
    context.strokeStyle = isSelectedGroup ? "rgba(255, 211, 232, .15)" : "rgba(255, 211, 232, .065)";
    context.lineWidth = 0.55;
    for (const columnMembers of membersByColumn.values()) {
      columnMembers.sort((a, b) => a.ring - b.ring);
      context.beginPath();
      context.moveTo(group.hubX, group.hubY);
      for (const member of columnMembers) context.lineTo(member.px, member.py);
      context.stroke();
    }
  }

  // Real Notion relations stay quiet by default and become clear around the selected node.
  for (const edge of edges) {
    const a = positionById.get(edge.source);
    const b = positionById.get(edge.target);
    if (!a || !b || a.kind === "system" || b.kind === "system") continue;
    const directlySelected = edge.source === selectedNodeId || edge.target === selectedNodeId
      || edge.source === hoveredNodeId || edge.target === hoveredNodeId;
    const joinsSearchMatches = searchMatches.has(edge.source) && searchMatches.has(edge.target);
    const structural = edge.type === "parent" || edge.type === "child" || edge.type === "relation";
    if (!directlySelected && !joinsSearchMatches && (!structural || focusActive)) continue;
    const opacity = directlySelected ? 0.76 : joinsSearchMatches ? 0.34 : 0.07;
    context.strokeStyle = `rgba(255, 220, 237, ${opacity})`;
    context.lineWidth = directlySelected ? 1.25 : 0.6;
    context.setLineDash(edge.type === "similarity" ? [2, 5] : []);
    const control = { x: (a.px + b.px + screenCenter.x) / 3, y: (a.py + b.py + screenCenter.y) / 3 };
    context.beginPath();
    context.moveTo(a.px, a.py);
    context.quadraticCurveTo(control.x, control.y, b.px, b.py);
    context.stroke();
    if (!reducedMotion && directlySelected) {
      const progress = (time * 0.28 + edge.source.length * 0.07 + edge.target.length * 0.03) % 1;
      const pulse = quadraticPoint({ x: a.px, y: a.py }, control, { x: b.px, y: b.py }, progress);
      const pulseGlow = context.createRadialGradient(pulse.x, pulse.y, 0, pulse.x, pulse.y, 6);
      pulseGlow.addColorStop(0, "rgba(255, 250, 253, .95)");
      pulseGlow.addColorStop(0.25, "rgba(255, 181, 218, .58)");
      pulseGlow.addColorStop(1, "rgba(255, 181, 218, 0)");
      context.fillStyle = pulseGlow;
      context.beginPath();
      context.arc(pulse.x, pulse.y, 6, 0, Math.PI * 2);
      context.fill();
    }
  }
  context.setLineDash([]);

  // Topic hubs label the hierarchy without turning every page title into visual noise.
  const labelBoxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  for (const group of groups) {
    const active = group.name === selectedGroup;
    const hubPulse = 1 + Math.sin(time * 1.1 + group.index) * 0.08;
    const hubGlow = context.createRadialGradient(group.hubX, group.hubY, 0, group.hubX, group.hubY, 13 * hubPulse);
    hubGlow.addColorStop(0, active ? "rgba(255, 245, 250, .95)" : "rgba(255, 230, 242, .75)");
    hubGlow.addColorStop(0.2, active ? "rgba(255, 181, 216, .58)" : "rgba(255, 190, 221, .24)");
    hubGlow.addColorStop(1, "rgba(255, 190, 221, 0)");
    context.fillStyle = hubGlow;
    context.beginPath();
    context.arc(group.hubX, group.hubY, 13 * hubPulse, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = active ? "#fff4f9" : "rgba(255, 235, 244, .82)";
    context.beginPath();
    context.arc(group.hubX, group.hubY, active ? 2.4 : 1.8, 0, Math.PI * 2);
    context.fill();

    const label = group.name.toLocaleUpperCase("de-DE").slice(0, 26);
    context.font = `${active ? 9 : 8}px var(--font-geist-mono), monospace`;
    context.letterSpacing = ".65px";
    const labelWidth = context.measureText(label).width;
    const labelY = group.hubY + 18;
    context.fillStyle = active ? "rgba(255, 241, 248, .96)" : "rgba(201, 173, 187, .74)";
    context.textAlign = "center";
    context.fillText(label, group.hubX, labelY);
    context.font = "7px var(--font-geist-mono), monospace";
    context.fillStyle = "rgba(147, 119, 132, .75)";
    context.fillText(`${group.members.length} KNOTEN`, group.hubX, labelY + 11);
    labelBoxes.push({
      left: group.hubX - labelWidth / 2 - 5,
      right: group.hubX + labelWidth / 2 + 5,
      top: labelY - 10,
      bottom: labelY + 15,
    });
  }

  const representativeIds = new Set(groups.map((group) => group.members[0]?.id).filter(Boolean));
  positions.forEach((node, index) => {
    const isRoot = node.kind === "system";
    const isDirectlyRelated = relatedIds.has(node.id);
    const isSameGroup = Boolean(selectedGroup && node.group === selectedGroup);
    const isSearchMatch = searchMatches.has(node.id);
    const isActive = node.id === selectedNodeId || node.id === hoveredNodeId || isSearchMatch;
    context.globalAlpha = isRoot || isActive || !focusActive || isDirectlyRelated
      ? 1
      : isSameGroup ? 0.64 : 0.2;
    const pulse = isActive || isRoot ? 1 + Math.sin(time * 1.35 + index) * 0.1 : 1;
    const pointRadius = isRoot ? 3.4 : Math.max(1.15, Math.min(2.5, node.size * 0.38));
    const glowRadius = (isRoot ? 24 : isActive ? 17 : representativeIds.has(node.id) ? 9 : 5.5) * pulse;
    const glow = context.createRadialGradient(node.px, node.py, 0, node.px, node.py, glowRadius);
    glow.addColorStop(0, "rgba(255, 249, 252, .95)");
    glow.addColorStop(0.16, isActive ? "rgba(255, 183, 218, .72)" : "rgba(255, 195, 224, .3)");
    glow.addColorStop(1, "rgba(242, 143, 190, 0)");
    context.fillStyle = glow;
    context.beginPath();
    context.arc(node.px, node.py, glowRadius, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = isRoot ? "#fff6fa" : "rgba(255, 239, 247, .92)";
    context.beginPath();
    context.arc(node.px, node.py, pointRadius, 0, Math.PI * 2);
    context.fill();
    if (isActive && !isRoot) {
      context.strokeStyle = isSearchMatch ? "rgba(255, 210, 232, .82)" : "rgba(255, 222, 238, .62)";
      context.lineWidth = node.id === selectedNodeId ? 1.15 : 0.7;
      context.beginPath();
      context.arc(node.px, node.py, pointRadius + 5.5, 0, Math.PI * 2);
      context.stroke();
    }
  });
  context.globalAlpha = 1;

  if (systemNode) {
    context.font = "9px var(--font-geist-mono), monospace";
    context.letterSpacing = "1.2px";
    context.fillStyle = "rgba(255, 234, 244, .88)";
    context.textAlign = "center";
    context.fillText("NOTION", screenCenter.x, screenCenter.y + 20);
  }

  const labelCandidates = positions
    .filter((node) => node.kind !== "system" && (
      node.id === selectedNodeId
      || node.id === hoveredNodeId
      || searchMatches.has(node.id)
      || (!focusActive && representativeIds.has(node.id))
      || (focusActive && relatedIds.has(node.id) && node.size >= 3.8)
    ))
    .sort((a, b) => {
      const priority = (node: PositionedNode) => node.id === selectedNodeId
        ? 100 : searchMatches.has(node.id) ? 95 : node.id === hoveredNodeId ? 90 : representativeIds.has(node.id) ? 70 : node.size;
      return priority(b) - priority(a);
    });

  for (const node of labelCandidates) {
    const isActive = node.id === selectedNodeId || node.id === hoveredNodeId || searchMatches.has(node.id);
    const fontSize = isActive ? 10 : 8;
    context.font = `${fontSize}px var(--font-geist-mono), monospace`;
    context.letterSpacing = ".25px";
    const label = node.label.slice(0, isActive ? 42 : 28);
    const labelWidth = context.measureText(label).width + 10;
    const labelY = node.py + 15;
    const box = {
      left: node.px - labelWidth / 2,
      right: node.px + labelWidth / 2,
      top: labelY - fontSize,
      bottom: labelY + 4,
    };
    const collides = labelBoxes.some((other) => !(box.right < other.left || box.left > other.right || box.bottom < other.top || box.top > other.bottom));
    if (collides && !isActive) continue;
    labelBoxes.push(box);
    context.fillStyle = isActive ? "rgba(255,247,251,.98)" : "rgba(205,179,191,.68)";
    context.textAlign = "center";
    context.fillText(label, node.px, labelY);
  }

  context.font = "7px var(--font-geist-mono), monospace";
  context.letterSpacing = ".8px";
  context.fillStyle = "rgba(141, 113, 126, .58)";
  context.textAlign = "left";
  context.fillText("THEMEN  →  NOTIZEN   ·   AUSWAHL ZEIGT VERBINDUNGEN", 14, height - 14);
}
