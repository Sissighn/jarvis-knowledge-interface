import type { FormEvent } from "react";
import type { KnowledgeAnswer } from "@/features/knowledge/answer";
import type { CoreState, KnowledgeNode } from "../types";
import { KnowledgeAnswerPanel } from "./KnowledgeAnswerPanel";

type CommandCenterProps = {
  query: string;
  state: CoreState;
  connected: boolean;
  speechSupported: boolean;
  speechError: string | null;
  answer: KnowledgeAnswer | null;
  nodes: KnowledgeNode[];
  selectedNodeId: string;
  onQueryChange(query: string): void;
  onSubmit(event: FormEvent): void;
  onToggleListening(): void;
  onClearSpeechError(): void;
  onCloseAnswer(): void;
  onSelectResult(node: KnowledgeNode): void;
  onRunPrompt(prompt: string): void;
};

export function CommandCenter({
  query,
  state,
  connected,
  speechSupported,
  speechError,
  answer,
  nodes,
  selectedNodeId,
  onQueryChange,
  onSubmit,
  onToggleListening,
  onClearSpeechError,
  onCloseAnswer,
  onSelectResult,
  onRunPrompt,
}: CommandCenterProps) {
  return (
    <section className="command-area">
      {answer && (
        <KnowledgeAnswerPanel
          answer={answer}
          connected={connected}
          nodes={nodes}
          selectedNodeId={selectedNodeId}
          onClose={onCloseAnswer}
          onSelectNode={onSelectResult}
        />
      )}
      {speechError && <div className="speech-error" role="status">{speechError}<button onClick={onClearSpeechError} aria-label="Hinweis schließen">×</button></div>}
      {(state === "thinking" || state === "transcribing") && (
        <div className="model-progress" role="status" aria-live="polite">
          <span className="model-spinner" aria-hidden="true"><i /><i /><i /></span>
          <span>{state === "transcribing" ? "WHISPER TRANSKRIBIERT DEINE AUFNAHME" : "LOKALES MODELL VERARBEITET DEINE FRAGE"}</span>
          <b>{state === "transcribing" ? "LOCAL STT" : "QWEN 3.5"}</b>
        </div>
      )}
      <form className={`command-bar state-${state}`} onSubmit={onSubmit} aria-busy={state === "thinking" || state === "transcribing"}>
        <span className="prompt-symbol">›</span>
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={state === "listening" ? "recording — press stop when finished" : state === "transcribing" ? "transcribing your recording …" : "ask a question"}
          aria-label="Jarvis befragen"
          readOnly={state !== "idle"}
        />
        <button
          type="submit"
          className="send-button"
          disabled={!query.trim() || state !== "idle"}
          aria-label="Frage senden"
          title="Frage senden"
        >
          <span className="send-icon" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`mic-button ${state === "listening" ? "active" : ""} ${!speechSupported ? "unsupported" : ""}`}
          onClick={onToggleListening}
          disabled={state === "transcribing" || state === "thinking"}
          aria-label={state === "listening" ? "Aufnahme beenden" : "Spracheingabe starten"}
          title={speechSupported ? state === "listening" ? "Aufnahme stoppen und transkribieren" : "Frage sprechen" : "Spracheingabe wird von diesem Browser nicht bereitgestellt"}
        >
          <span className={state === "listening" ? "stop-icon" : "mic-icon"} />
          {state === "listening" && <span className="mic-label">STOP</span>}
        </button>
      </form>
      <div className="quick-prompts">
        <button type="button" onClick={() => onRunPrompt("Was verbindet meine aktuellen Projekte?")}>PROJEKTE VERBINDEN</button>
        <button type="button" onClick={() => onRunPrompt("Was weiß ich über meine nächste Prüfung?")}>PRÜFUNGSWISSEN</button>
        <button type="button" onClick={() => onRunPrompt("Zeig mir meine wichtigsten Ideen")}>IDEEN FINDEN</button>
      </div>
    </section>
  );
}
