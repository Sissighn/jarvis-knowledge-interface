import type { NotionStatus, WeatherPayload } from "../types";
import type { LocalModelStatus } from "@/features/ai/types";

type AppHeaderProps = {
  weather: WeatherPayload | null;
  weatherLoading: boolean;
  weatherError: string | null;
  notionStatus: NotionStatus;
  modelStatus: LocalModelStatus;
  syncing: boolean;
  onRetryWeather(): void;
  onOpenNotionSetup(): void;
};

export function AppHeader({
  weather,
  weatherLoading,
  weatherError,
  notionStatus,
  modelStatus,
  syncing,
  onRetryWeather,
  onOpenNotionSetup,
}: AppHeaderProps) {
  const modelReady = modelStatus.connected && modelStatus.modelAvailable;
  const modelLabel = modelReady ? "LOCAL AI" : modelStatus.connected ? "MODEL SETUP" : "LOCAL";
  const modelTitle = modelReady
    ? `${modelStatus.model} ist lokal bereit.`
    : modelStatus.error || `${modelStatus.model} ist noch nicht installiert.`;

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <strong>JARVIS</strong>
            <span>PERSONAL KNOWLEDGE INTERFACE</span>
          </div>
        </div>
        <section className={`weather-compact ${weatherLoading ? "is-loading" : ""}`} aria-live="polite" title={weatherError || undefined}>
          {weather ? (
            <>
              <span className="weather-symbol" aria-hidden="true">{weather.current.symbol}</span>
              <strong className="weather-temperature">{Math.round(weather.current.temperature)}°</strong>
              <span className="weather-details">
                <b>{weather.location}</b>
                <small>
                  {weather.current.label} · H {Math.round(weather.today.max)}° / T {Math.round(weather.today.min)}° · {Math.round(weather.today.rainChance)}% REGEN
                  {" · "}<a href={weather.attribution.url} target="_blank" rel="noreferrer">OPEN-METEO</a>
                </small>
              </span>
            </>
          ) : weatherError ? (
            <button type="button" className="weather-retry" onClick={onRetryWeather}>WETTER OFFLINE · ↻</button>
          ) : (
            <><span className="weather-symbol" aria-hidden="true">○</span><span className="weather-loading-label">WETTER</span></>
          )}
        </section>
      </div>
      <div className="system-meta">
        <button
          className={`notion-status-button ${notionStatus.connected ? "connected" : ""}`}
          onClick={onOpenNotionSetup}
        >
          <i /> {syncing ? "SYNCING" : notionStatus.connected ? "NOTION READY" : "NOTION SETUP"}
        </button>
        <span className={`live-dot ${modelReady ? "connected" : ""}`} title={modelTitle}><i /> {modelLabel}</span>
      </div>
    </header>
  );
}
