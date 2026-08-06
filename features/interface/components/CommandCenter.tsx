import type { FormEvent, ReactNode } from "react";
import type { KnowledgeAnswer } from "@/features/knowledge/answer";
import type { CoreState } from "../types";
import { KnowledgeAnswerPanel } from "./KnowledgeAnswerPanel";

type CommandCenterProps = {
  query: string;
  state: CoreState;
  connected: boolean;
  speechSupported: boolean;
  speechError: string | null;
  answer: KnowledgeAnswer | null;
  voicePanel: ReactNode;
  onQueryChange(query: string): void;
  onSubmit(event: FormEvent): void;
  onToggleListening(): void;
  onClearSpeechError(): void;
  onCloseAnswer(): void;
  onRunPrompt(prompt: string): void;
};

export function CommandCenter({
  query,
  state,
  connected,
  speechSupported,
  speechError,
  answer,
  voicePanel,
  onQueryChange,
  onSubmit,
  onToggleListening,
  onClearSpeechError,
  onCloseAnswer,
  onRunPrompt,
}: CommandCenterProps) {
  return (
    <section className="command-area">
      {voicePanel}
      {answer && (
        <KnowledgeAnswerPanel answer={answer} connected={connected} onClose={onCloseAnswer} />
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
          readOnly={state === "listening" || state === "transcribing"}
        />
        <button
          type="submit"
          className="send-button"
          disabled={!query.trim() || state === "listening" || state === "transcribing" || state === "thinking"}
          aria-label="Frage senden"
          title="Frage an dein Notion-Wissen senden"
        >
          <span className="send-icon" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`mic-button ${state === "listening" ? "active" : ""} ${!speechSupported ? "unsupported" : ""}`}
          onClick={onToggleListening}
          disabled={state === "transcribing"}
          aria-label={state === "listening" ? "Aufnahme beenden" : "Sprachassistent starten"}
          title={speechSupported
            ? state === "listening"
              ? "Aufnahme stoppen und transkribieren"
              : state === "speaking" ? "Jarvis unterbrechen und sprechen" : "Mit Jarvis sprechen"
            : "Diese Ansicht kann nicht auf das Mikrofon zugreifen"}
        >
          <span className={state === "listening" ? "stop-icon" : "mic-icon"} />
          {state === "listening" && <span className="mic-label">STOP</span>}
        </button>
      </form>
      <div className="quick-prompts">
        <button type="button" onClick={() => onRunPrompt("Welche zentralen Konzepte gibt es in meinem ausgewählten Wissen?")}>KONZEPTE FINDEN</button>
        <button type="button" onClick={() => onRunPrompt("Welche wichtigen Zusammenhänge gibt es zwischen meinen Notizen?")}>ZUSAMMENHÄNGE</button>
        <button type="button" onClick={() => onRunPrompt("Was weiß ich über meine nächste Prüfung?")}>PRÜFUNGSWISSEN</button>
      </div>
    </section>
  );
}
