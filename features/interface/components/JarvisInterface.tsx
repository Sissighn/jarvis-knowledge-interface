"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateKnowledgeAnswer } from "@/features/ai/client/generate-answer";
import { rememberConversationTurn, retrievalContextFromHistory } from "@/features/ai/client/conversation";
import type { ConversationTurn } from "@/features/ai/types";
import { answerFromChunks, type KnowledgeAnswer } from "@/features/knowledge/answer";
import { searchIndexedKnowledge } from "@/features/knowledge/client";
import { NeuralCanvas } from "./NeuralCanvas";
import { AppHeader } from "./AppHeader";
import { CommandCenter } from "./CommandCenter";
import { KnowledgePanels } from "./KnowledgePanels";
import { MorningBriefing } from "./MorningBriefing";
import { NotionSetupDialog } from "./NotionSetupDialog";
import { TechVocabularyCarousel } from "./TechVocabularyCarousel";
import { VoiceAssistant } from "./VoiceAssistant";
import { useJarvisData } from "../hooks/useJarvisData";
import { useKnowledgeIndex } from "../hooks/useKnowledgeIndex";
import { useVoiceAssistant } from "../hooks/useVoiceAssistant";
import type { ConceptDetail, ConceptNode, CoreState, NotionStatus, ViewMode } from "../types";

const DISCONNECTED_NOTION: NotionStatus = { configured: false, connected: false };
const NUMBER_FORMAT = new Intl.NumberFormat("de-DE");
const EMPTY_SYSTEM_NODE: ConceptNode = {
  id: "jarvis-knowledge-root",
  label: "WISSEN",
  description: "Wähle im Setup deine Notion-Datenbanken aus.",
  category: "System",
  aliases: [],
  importance: 1,
  sourceCount: 0,
  occurrenceCount: 0,
  lastSeenAt: "",
  kind: "system",
  group: "System",
  x: 0,
  y: 0,
  size: 7,
};

export function JarvisInterface() {
  const [queryState, setQueryState] = useState<"idle" | "thinking">("idle");
  const [mode, setMode] = useState<ViewMode>("core");
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<KnowledgeAnswer | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [loadedDetail, setLoadedDetail] = useState<{ conceptId: string; detail: ConceptDetail | null }>({
    conceptId: "",
    detail: null,
  });
  const requestIdRef = useRef(0);
  const answerControllerRef = useRef<AbortController | null>(null);
  const conversationRef = useRef<ConversationTurn[]>([]);

  const {
    briefing,
    briefingLoading,
    briefingError,
    visibleBriefingItems,
    savedBriefingIds,
    savedVocabularyIds,
    savingVocabularyId,
    vocabularySaveError,
    loadBriefing,
    hideBriefingItem,
    toggleSavedBriefingItem,
    saveVocabularyTerm,
    weather,
    weatherLoading,
    weatherError,
    loadWeather,
    modelStatus,
    footerDate,
  } = useJarvisData();

  const knowledge = useKnowledgeIndex();
  const { nodes, edges, coverage, status: indexStatus, loadConceptDetail } = knowledge;
  const notionStatus = indexStatus?.notion ?? DISCONNECTED_NOTION;
  const syncing = Boolean(indexStatus?.running);

  useEffect(() => () => answerControllerRef.current?.abort(), []);

  // Live updates keep the selection as long as the chosen concept still exists.
  const selectedNode = useMemo(() => {
    const selected = nodes.find((node) => node.id === selectedNodeId);
    return selected ?? nodes.find((node) => node.kind === "system") ?? EMPTY_SYSTEM_NODE;
  }, [nodes, selectedNodeId]);

  const conceptId = selectedNode?.kind === "concept" ? selectedNode.id : "";
  useEffect(() => {
    if (!conceptId) return;
    let active = true;
    void loadConceptDetail(conceptId).then((detail) => {
      if (active) setLoadedDetail({ conceptId, detail });
    });
    return () => { active = false; };
  }, [conceptId, loadConceptDetail]);

  const conceptDetail = loadedDetail.conceptId === conceptId ? loadedDetail.detail : null;
  const detailLoading = Boolean(conceptId) && loadedDetail.conceptId !== conceptId;

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      if (node.kind !== "concept") continue;
      counts.set(node.group, (counts.get(node.group) ?? 0) + 1);
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5);
  }, [nodes]);

  const highlightedNodeIds = useMemo(() => answer?.highlightedConceptIds ?? [], [answer]);

  const selectNode = useCallback((node: ConceptNode) => setSelectedNodeId(node.id), []);

  const executeQuery = useCallback(async (rawQuery: string) => {
    const cleanQuery = rawQuery.trim();
    if (!cleanQuery) return;
    answerControllerRef.current?.abort();
    const controller = new AbortController();
    answerControllerRef.current = controller;
    const requestId = ++requestIdRef.current;
    setQuery("");
    setAnswer(null);
    setQueryState("thinking");

    const conversation = conversationRef.current;
    try {
      const retrieval = await searchIndexedKnowledge(
        cleanQuery,
        retrievalContextFromHistory(conversation),
        controller.signal,
      );
      const baseAnswer = answerFromChunks(cleanQuery, retrieval.chunks, retrieval.conceptIds);
      if (retrieval.conceptIds.length) {
        setSelectedNodeId(retrieval.conceptIds[0]);
        setMode("map");
      }

      if (!baseAnswer.sources.length) {
        if (requestId === requestIdRef.current) {
          setAnswer(baseAnswer);
          conversationRef.current = rememberConversationTurn(conversation, baseAnswer);
        }
        return;
      }

      const generatedAnswer = await generateKnowledgeAnswer(
        baseAnswer,
        retrieval.chunks,
        conversation,
        controller.signal,
      );
      if (requestId === requestIdRef.current) {
        setAnswer(generatedAnswer);
        conversationRef.current = rememberConversationTurn(conversation, generatedAnswer);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const reason = error instanceof Error ? error.message : "Der lokale Index ist nicht erreichbar.";
      if (requestId === requestIdRef.current) {
        setAnswer({
          query: cleanQuery,
          status: "not_found",
          title: "Antwort nicht möglich",
          summary: reason,
          confidence: 0,
          confidenceLabel: "NIEDRIG",
          evidence: [],
          sources: [],
          highlightedConceptIds: [],
          caveat: "Prüfe den lokalen Index und das Modell im Setup-Dialog.",
        });
      }
    } finally {
      if (requestId === requestIdRef.current) {
        answerControllerRef.current = null;
        setQueryState("idle");
      }
    }
  }, []);

  const assistant = useVoiceAssistant();
  // The microphone drives the spoken assistant, the text field stays on Notion knowledge.
  const state: CoreState = assistant.phase === "idle" ? queryState : assistant.phase;

  const selectCategory = (category: string) => {
    const node = nodes.find((candidate) => candidate.group === category && candidate.kind === "concept");
    if (node) setSelectedNodeId(node.id);
    setMode("map");
  };

  const runQuery = (event: FormEvent) => {
    event.preventDefault();
    if (state === "listening" || state === "transcribing" || state === "thinking") return;
    assistant.stopSpeaking();
    void executeQuery(query);
  };

  const statusText = state === "listening"
    ? "ICH HÖRE ZU"
    : state === "transcribing"
      ? "SPRACHE WIRD TRANSKRIBIERT"
      : state === "speaking" ? "ICH ANTWORTE DIR" : state === "thinking" ? "ICH VERBINDE WISSEN" : "SYSTEM BEREIT";
  const conceptCount = nodes.filter((node) => node.kind === "concept").length;
  // Closing keeps the canvas mounted so the graph layout, zoom and trails survive.
  const closeSetup = useCallback(() => setSetupOpen(false), []);

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
        conceptCount={conceptCount}
        categories={categoryCounts}
        selectedNode={selectedNode}
        detail={conceptDetail}
        detailLoading={detailLoading}
        coverage={coverage}
        sync={indexStatus?.sync ?? null}
        onSelectCategory={selectCategory}
      />

      <section className="visual-stage">
        <NeuralCanvas
          key={mode}
          state={state}
          speechActivity={assistant.speechActivity}
          mode={mode}
          nodes={nodes}
          edges={edges}
          selectedNodeId={selectedNode.id}
          highlightedNodeIds={highlightedNodeIds}
          onSelect={selectNode}
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
              : state === "transcribing"
                ? "WHISPER WANDELT DEINE AUFNAHME IN TEXT UM"
                : state === "speaking"
                  ? "TIPPE AUF DAS MIKROFON, UM MICH ZU UNTERBRECHEN"
                  : state === "thinking" ? "MUSTER WERDEN ANALYSIERT" : "DEIN WISSEN. VERBUNDEN."}</span>
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

      {mode === "core" ? (
        <TechVocabularyCarousel
          key={briefing?.vocabulary?.date ?? "vocabulary-loading"}
          vocabulary={briefing?.vocabulary}
          notionConnected={notionStatus.connected}
          savedTermIds={savedVocabularyIds}
          savingTermId={savingVocabularyId}
          saveError={vocabularySaveError}
          onSave={(termId) => void saveVocabularyTerm(termId)}
        />
      ) : null}

      <nav className="mode-switcher" aria-label="Ansicht wechseln">
        <button className={mode === "core" ? "active" : ""} onClick={() => setMode("core")}><i /> CORE</button>
        <button className={mode === "map" ? "active" : ""} onClick={() => setMode("map")}><i /> MAP</button>
      </nav>

      <CommandCenter
        query={query}
        state={state}
        connected={notionStatus.connected}
        speechSupported={assistant.micSupported}
        speechError={assistant.active ? null : assistant.error}
        answer={answer}
        voicePanel={assistant.active ? (
          <VoiceAssistant
            phase={assistant.phase}
            transcript={assistant.transcript}
            reply={assistant.reply}
            steps={assistant.steps}
            pending={assistant.pending}
            error={assistant.error}
            settings={assistant.settings}
            voices={assistant.curatedVoices}
            voiceOutputSupported={assistant.voiceOutputSupported}
            activeVoice={assistant.activeVoice}
            captureMode={assistant.captureMode}
            localStatus={assistant.localStatus}
            connectingSpotify={assistant.connectingSpotify}
            connectingGoogle={assistant.connectingGoogle}
            onConfirm={assistant.answerConfirmation}
            onStopSpeaking={assistant.stopSpeaking}
            onSettingsChange={assistant.updateSettings}
            onConnectSpotify={() => void assistant.startSpotifyConnect()}
            onDisconnectSpotify={() => void assistant.stopSpotifyConnection()}
            onConnectGoogle={() => void assistant.startGoogleConnect()}
            onDisconnectGoogle={() => void assistant.stopGoogleConnection()}
            onClearError={assistant.clearError}
            onClose={assistant.reset}
          />
        ) : null}
        onQueryChange={setQuery}
        onSubmit={runQuery}
        onToggleListening={assistant.toggleListening}
        onClearSpeechError={assistant.clearError}
        onCloseAnswer={() => setAnswer(null)}
        onRunPrompt={executeQuery}
      />

      <footer className="footer-line">
        <span>NOTION <i /> {notionStatus.connected
          ? `${NUMBER_FORMAT.format(coverage.foundSources)} QUELLEN · ${NUMBER_FORMAT.format(coverage.chunks)} ABSCHNITTE · ${NUMBER_FORMAT.format(coverage.concepts)} KONZEPTE`
          : "NICHT VERBUNDEN"}</span>
        <span>{knowledge.syncedAt
          ? `SYNC ${new Date(knowledge.syncedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`
          : briefing ? `BRIEFING ${visibleBriefingItems.length} NEWS` : "LOCAL CORE / M4"}</span>
        <span>{footerDate}</span>
      </footer>

      {setupOpen ? (
        <NotionSetupDialog
          notionStatus={notionStatus}
          status={indexStatus}
          coverage={coverage}
          databases={knowledge.databases}
          databasesLoading={knowledge.databasesLoading}
          savingSelection={knowledge.savingSelection}
          selectionSavedAt={knowledge.selectionSavedAt}
          indexAvailable={knowledge.indexAvailable}
          error={knowledge.error}
          onClose={closeSetup}
          onLoadDatabases={knowledge.loadDatabases}
          onSaveDatabases={(databaseIds) => void knowledge.saveDatabases(databaseIds)}
          onSync={(syncMode) => void knowledge.startSync(syncMode)}
          onCancelSync={() => void knowledge.cancelSync()}
          onInstallEmbeddingModel={() => void knowledge.installEmbeddingModel()}
          onResetIndex={() => void knowledge.resetIndex()}
        />
      ) : null}
    </main>
  );
}
