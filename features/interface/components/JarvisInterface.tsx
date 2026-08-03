"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateKnowledgeAnswer } from "@/features/ai/client/generate-answer";
import { answerKnowledge, type KnowledgeAnswer } from "@/features/knowledge/answer";
import { NeuralCanvas } from "./NeuralCanvas";
import { AppHeader } from "./AppHeader";
import { CommandCenter } from "./CommandCenter";
import { KnowledgePanels } from "./KnowledgePanels";
import { MorningBriefing } from "./MorningBriefing";
import { NotionSetupDialog } from "./NotionSetupDialog";
import { useJarvisData } from "../hooks/useJarvisData";
import { useVoiceRecorder } from "../hooks/useVoiceRecorder";
import type { CoreState, ViewMode } from "../types";

export function JarvisInterface() {
  const [state, setState] = useState<CoreState>("idle");
  const [mode, setMode] = useState<ViewMode>("core");
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<KnowledgeAnswer | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const requestIdRef = useRef(0);
  const answerControllerRef = useRef<AbortController | null>(null);
  const {
    nodes,
    edges,
    selectedNode,
    setSelectedNode,
    notionStatus,
    graphMeta,
    syncing,
    notionError,
    loadNotion,
    briefing,
    briefingLoading,
    briefingError,
    visibleBriefingItems,
    savedBriefingIds,
    loadBriefing,
    hideBriefingItem,
    toggleSavedBriefingItem,
    weather,
    weatherLoading,
    weatherError,
    loadWeather,
    modelStatus,
    footerDate,
  } = useJarvisData();

  useEffect(() => () => answerControllerRef.current?.abort(), []);

  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      if (node.kind === "system") continue;
      counts.set(node.group, (counts.get(node.group) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
  }, [nodes]);

  const selectedConnections = useMemo(() => edges.filter(
    (edge) => edge.source === selectedNode.id || edge.target === selectedNode.id,
  ).length, [edges, selectedNode.id]);

  const highlightedNodeIds = useMemo(
    () => answer?.highlightedNodeIds ?? [],
    [answer],
  );

  const executeQuery = useCallback(async (rawQuery: string) => {
    const cleanQuery = rawQuery.trim();
    if (!cleanQuery) return;
    answerControllerRef.current?.abort();
    const controller = new AbortController();
    answerControllerRef.current = controller;
    const requestId = ++requestIdRef.current;
    setQuery("");
    setAnswer(null);
    setState("thinking");

    const baseAnswer = answerKnowledge(nodes, edges, cleanQuery);
    if (baseAnswer.sources.length) {
      const firstNode = nodes.find((node) => node.id === baseAnswer.sources[0].nodeId);
      if (firstNode) setSelectedNode(firstNode);
      setMode("map");
    }

    if (!baseAnswer.sources.length) {
      if (requestId === requestIdRef.current) {
        setAnswer(baseAnswer);
        setState("idle");
        answerControllerRef.current = null;
      }
      return;
    }

    try {
      const generatedAnswer = await generateKnowledgeAnswer(baseAnswer, nodes, controller.signal);
      if (requestId === requestIdRef.current) setAnswer(generatedAnswer);
    } catch (error) {
      if (controller.signal.aborted) return;
      const reason = error instanceof Error ? error.message : "Das lokale Modell ist nicht erreichbar.";
      if (requestId === requestIdRef.current) {
        setAnswer({
          ...baseAnswer,
          caveat: `Lokales Modell nicht verfügbar: ${reason} ${baseAnswer.caveat}`,
        });
      }
    } finally {
      if (requestId === requestIdRef.current) {
        answerControllerRef.current = null;
        setState("idle");
      }
    }
  }, [edges, nodes, setSelectedNode]);

  const {
    supported: speechSupported,
    error: speechError,
    toggle: toggleListening,
    clearError: clearSpeechError,
  } = useVoiceRecorder({
    onTranscript: setQuery,
    onPhaseChange: (voicePhase) => {
      if (voicePhase === "recording") {
        answerControllerRef.current?.abort();
        requestIdRef.current += 1;
        setAnswer(null);
      }
      setState(voicePhase === "recording"
        ? "listening"
        : voicePhase === "transcribing" ? "transcribing" : "idle");
    },
  });

  const selectGroup = (group: string) => {
    const node = nodes.find((candidate) => candidate.group === group);
    if (node) setSelectedNode(node);
    setMode("map");
  };

  const runQuery = (event: FormEvent) => {
    event.preventDefault();
    if (state === "idle") void executeQuery(query);
  };

  const statusText = state === "listening"
    ? "ICH HÖRE ZU"
    : state === "transcribing" ? "SPRACHE WIRD TRANSKRIBIERT" : state === "thinking" ? "ICH VERBINDE WISSEN" : "SYSTEM BEREIT";

  return (
    <main className="jarvis-shell">
      <div className="grid-noise" aria-hidden="true" />
      <AppHeader
        weather={weather}
        weatherLoading={weatherLoading}
        weatherError={weatherError}
        notionStatus={notionStatus}
        modelStatus={modelStatus}
        syncing={syncing}
        onRetryWeather={() => void loadWeather(true)}
        onOpenNotionSetup={() => setSetupOpen(true)}
      />

      <KnowledgePanels
        mode={mode}
        connected={notionStatus.connected}
        nodeCount={nodes.filter((node) => node.kind !== "system").length}
        groups={groupCounts}
        selectedNode={selectedNode}
        selectedConnections={selectedConnections}
        graphMeta={graphMeta}
        onSelectGroup={selectGroup}
      />

      <section className="visual-stage">
        <NeuralCanvas
          state={state}
          mode={mode}
          nodes={nodes}
          edges={edges}
          selectedNodeId={selectedNode.id}
          highlightedNodeIds={highlightedNodeIds}
          onSelect={setSelectedNode}
        />
        {mode === "core" && (
          <div className={`core-status state-${state}`}>
            <span>{statusText}</span>
            <i />
          </div>
        )}
        {mode === "core" && (
          <div className="core-copy">
            <span>{state === "listening"
              ? "SPRICH EINFACH LOS · STOPP WENN DU FERTIG BIST"
              : state === "transcribing" ? "WHISPER WANDELT DEINE AUFNAHME IN TEXT UM" : state === "thinking" ? "MUSTER WERDEN ANALYSIERT" : "DEIN WISSEN. VERBUNDEN."}</span>
          </div>
        )}
      </section>

      <MorningBriefing
        mode={mode}
        briefing={briefing}
        loading={briefingLoading}
        error={briefingError}
        visibleItems={visibleBriefingItems}
        savedIds={savedBriefingIds}
        onReload={() => void loadBriefing(true)}
        onHide={hideBriefingItem}
        onToggleSaved={toggleSavedBriefingItem}
      />

      <nav className="mode-switcher" aria-label="Ansicht wechseln">
        <button className={mode === "core" ? "active" : ""} onClick={() => setMode("core")}><i /> CORE</button>
        <button className={mode === "map" ? "active" : ""} onClick={() => setMode("map")}><i /> MAP</button>
      </nav>

      <CommandCenter
        query={query}
        state={state}
        connected={notionStatus.connected}
        speechSupported={speechSupported}
        speechError={speechError}
        answer={answer}
        nodes={nodes}
        selectedNodeId={selectedNode.id}
        onQueryChange={setQuery}
        onSubmit={runQuery}
        onToggleListening={toggleListening}
        onClearSpeechError={clearSpeechError}
        onCloseAnswer={() => setAnswer(null)}
        onRunPrompt={executeQuery}
        onSelectResult={(node) => {
          setSelectedNode(node);
          setMode("map");
        }}
      />

      <footer className="footer-line">
        <span>NOTION <i /> {notionStatus.connected ? `${graphMeta?.pageCount ?? 0} SEITEN` : "BEISPIELDATEN"}</span>
        <span>{briefing ? `BRIEFING ${visibleBriefingItems.length} NEWS` : graphMeta ? `SYNC ${new Date(graphMeta.syncedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}` : "LOCAL CORE / M4"}</span>
        <span>{footerDate}</span>
      </footer>

      <NotionSetupDialog
        open={setupOpen}
        status={notionStatus}
        graphMeta={graphMeta}
        syncing={syncing}
        error={notionError}
        onClose={() => setSetupOpen(false)}
        onSync={() => void loadNotion(true)}
      />
    </main>
  );
}
