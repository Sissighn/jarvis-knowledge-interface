import type { SpeechVoice } from "@/features/assistant/client/speech";
import type {
  AssistantToolStep,
  LocalActionStatus,
  PendingToolConfirmation,
  VoiceSettings,
} from "@/features/assistant/types";
import type { AssistantPhase } from "../hooks/useVoiceAssistant";

type VoiceAssistantProps = {
  phase: AssistantPhase;
  transcript: string;
  reply: string;
  steps: AssistantToolStep[];
  pending: PendingToolConfirmation | null;
  error: string | null;
  settings: VoiceSettings;
  voices: SpeechVoice[];
  voiceOutputSupported: boolean;
  activeVoice: SpeechVoice | null;
  captureMode: "browser" | "native" | "unavailable";
  localStatus: LocalActionStatus | null;
  connectingSpotify: boolean;
  connectingGoogle: boolean;
  onConfirm(approved: boolean): void;
  onStopSpeaking(): void;
  onSettingsChange(settings: Partial<VoiceSettings>): void;
  onConnectSpotify(): void;
  onDisconnectSpotify(): void;
  onConnectGoogle(): void;
  onDisconnectGoogle(): void;
  onClearError(): void;
  onClose(): void;
};

const PHASE_LABEL: Record<AssistantPhase, string> = {
  idle: "BEREIT",
  listening: "ICH HÖRE ZU",
  transcribing: "WHISPER TRANSKRIBIERT",
  thinking: "ICH ARBEITE DARAN",
  speaking: "ICH ANTWORTE",
};

export function VoiceAssistant({
  phase,
  transcript,
  reply,
  steps,
  pending,
  error,
  settings,
  voices,
  voiceOutputSupported,
  activeVoice,
  captureMode,
  localStatus,
  connectingSpotify,
  connectingGoogle,
  onConfirm,
  onStopSpeaking,
  onSettingsChange,
  onConnectSpotify,
  onDisconnectSpotify,
  onConnectGoogle,
  onDisconnectGoogle,
  onClearError,
  onClose,
}: VoiceAssistantProps) {
  const spotify = localStatus?.spotify;
  const google = localStatus?.google;

  return (
    <section className={`voice-assistant phase-${phase}`} aria-label="Sprachassistent" aria-live="polite">
      <header className="voice-header">
        <div>
          <span>JARVIS SPRACHASSISTENT</span>
          <strong>{PHASE_LABEL[phase]}</strong>
        </div>
        <div className="voice-header-actions">
          {phase === "speaking" && (
            <button type="button" className="voice-stop" onClick={onStopSpeaking}>UNTERBRECHEN</button>
          )}
          <button type="button" onClick={onClose} aria-label="Sprachassistent schließen">×</button>
        </div>
      </header>

      {error && (
        <p className="voice-error" role="status">
          {error}
          <button type="button" onClick={onClearError} aria-label="Hinweis schließen">×</button>
        </p>
      )}

      {transcript && (
        <p className="voice-transcript">
          <span>DU</span>
          {transcript}
        </p>
      )}

      {steps.length > 0 && (
        <ul className="voice-steps" aria-label="Ausgeführte Aktionen">
          {steps.map((step, index) => (
            <li key={`${step.name}-${index}`} className={step.ok ? "is-ok" : "is-failed"}>
              <i aria-hidden="true" />
              <span>{step.label}</span>
              {!step.ok && <small>{step.content.replace(/^Fehler:\s*/u, "")}</small>}
            </li>
          ))}
        </ul>
      )}

      {reply && !pending && (
        <p className="voice-reply">
          <span>JARVIS</span>
          {reply}
        </p>
      )}

      {pending && (
        <div className="voice-confirm" role="alertdialog" aria-label="Bestätigung erforderlich">
          <p>{pending.question}</p>
          <div>
            <button type="button" className="is-primary" onClick={() => onConfirm(true)}>JA, FORTFAHREN</button>
            <button type="button" onClick={() => onConfirm(false)}>ABBRECHEN</button>
          </div>
          <small>Du kannst auch einfach „ja“ oder „nein“ ins Mikrofon sagen.</small>
        </div>
      )}

      <div className="voice-settings">
        <label>
          <span>STIMME</span>
          <select
            value={activeVoice?.uri ?? ""}
            onChange={(event) => onSettingsChange({ voiceUri: event.target.value })}
            disabled={!voiceOutputSupported || !voices.length}
          >
            {voices.length ? null : <option value="">Stimme wird geladen …</option>}
            {voices.map((voice) => (
              <option key={voice.uri} value={voice.uri}>{voice.name} · {voice.lang}</option>
            ))}
          </select>
        </label>
        <label>
          <span>TEMPO {settings.rate.toFixed(2)}×</span>
          <input
            type="range"
            min="0.5"
            max="1.8"
            step="0.05"
            value={settings.rate}
            onChange={(event) => onSettingsChange({ rate: Number(event.target.value) })}
            disabled={!voiceOutputSupported}
          />
        </label>
        <label>
          <span>LAUTSTÄRKE {Math.round(settings.volume * 100)}%</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={settings.volume}
            onChange={(event) => onSettingsChange({ volume: Number(event.target.value) })}
            disabled={!voiceOutputSupported}
          />
        </label>
      </div>

      <div className="voice-connections">
        <span>{captureMode === "native"
          ? "MIKROFON NATIV"
          : captureMode === "browser" ? "MIKROFON IM BROWSER" : "KEIN MIKROFON"}</span>
        <span className={activeVoice ? "" : "is-warning"}>
          {activeVoice ? `STIMME · ${activeVoice.name}` : "STIMME WIRD GELADEN"}
        </span>
        {!voiceOutputSupported && <span className="is-warning">Diese Ansicht bietet keine Sprachausgabe.</span>}
        {localStatus === null ? (
          <span>Aktionen auf diesem Mac sind nur in der lokalen App verfügbar.</span>
        ) : (
          <>
            <span>{localStatus.available ? "MAC-AKTIONEN AKTIV" : "MAC-AKTIONEN INAKTIV"}</span>
            {spotify?.connected ? (
              <span className="is-connected">
                SPOTIFY {spotify.accountName ? `· ${spotify.accountName}` : ""}
                {spotify.premium === false ? " · KEIN PREMIUM" : ""}
                <button type="button" onClick={onDisconnectSpotify}>TRENNEN</button>
              </span>
            ) : (
              <span>
                SPOTIFY {spotify?.configured ? "NICHT VERBUNDEN" : "OHNE CLIENT-ID"}
                {spotify?.configured && (
                  <button type="button" onClick={onConnectSpotify} disabled={connectingSpotify}>
                    {connectingSpotify ? "WARTE AUF ANMELDUNG …" : "VERBINDEN"}
                  </button>
                )}
              </span>
            )}
            {spotify?.error && <span className="is-warning">{spotify.error}</span>}
            {google?.connected ? (
              <span className="is-connected">
                GOOGLE {google.accountEmail ? `· ${google.accountEmail}` : ""} · KEIN MAILVERSAND
                <button type="button" onClick={onDisconnectGoogle}>TRENNEN</button>
              </span>
            ) : (
              <span>
                GOOGLE {google?.configured ? "NICHT VERBUNDEN" : "OHNE CLIENT-ID"}
                {google?.configured && (
                  <button type="button" onClick={onConnectGoogle} disabled={connectingGoogle}>
                    {connectingGoogle ? "WARTE AUF ANMELDUNG …" : "VERBINDEN"}
                  </button>
                )}
              </span>
            )}
            {google?.error && <span className="is-warning">{google.error}</span>}
          </>
        )}
      </div>
    </section>
  );
}
