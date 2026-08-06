/** Dashboard answers for the assistant, built from the same sources the interface shows. */
import type { DailyBriefing } from "@/features/briefing/types";
import type { WeatherPayload } from "@/features/weather/types";

type ToolArguments = Record<string, unknown>;
type Cached<T> = { value: T; expiresAt: number } | null;

const CACHE_TTL_MS = 60_000;
let weatherCache: Cached<WeatherPayload> = null;
let briefingCache: Cached<DailyBriefing> = null;

async function loadJson<T>(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { cache: "no-store", signal });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Die Quelle ist momentan nicht erreichbar.");
  return payload;
}

async function weather(signal?: AbortSignal) {
  if (weatherCache && weatherCache.expiresAt > Date.now()) return weatherCache.value;
  const value = await loadJson<WeatherPayload>("/api/weather", signal);
  weatherCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

async function briefing(signal?: AbortSignal) {
  if (briefingCache && briefingCache.expiresAt > Date.now()) return briefingCache.value;
  const value = await loadJson<DailyBriefing>("/api/briefing", signal);
  briefingCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

function weekday(date: string) {
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime())
    ? date
    : new Intl.DateTimeFormat("de-DE", { weekday: "long", timeZone: "Europe/Berlin" }).format(parsed);
}

function temperatureText(payload: WeatherPayload) {
  return [
    `Ort: ${payload.location}.`,
    `Aktuelle Temperatur: ${Math.round(payload.current.temperature)} Grad.`,
    `Gefühlt: ${Math.round(payload.current.apparentTemperature)} Grad.`,
    `Wetterlage: ${payload.current.label}.`,
    // Written out as two values, because a range reads as ordinal numbers when spoken.
    `Tageshöchstwert: ${Math.round(payload.today.max)} Grad.`,
    `Tagestiefstwert: ${Math.round(payload.today.min)} Grad.`,
  ].join(" ");
}

function rainText(payload: WeatherPayload) {
  const days = payload.forecast.slice(0, 3).map((day, index) => (
    `${index === 0 ? "Heute" : weekday(day.date)}: ${Math.round(day.rainChance)} Prozent, ${day.label}`
  ));
  return `Regenwahrscheinlichkeit in ${payload.location}. ${days.join(". ")}.`;
}

function newsText(payload: DailyBriefing, limit: number) {
  const items = payload.items.slice(0, limit);
  if (!items.length) return "Für heute liegen keine Tech-News vor.";
  return `Die ${items.length} wichtigsten Tech-News von heute. ${items
    .map((item, index) => `${index + 1}. ${item.title}, Quelle ${item.sourceLabel}. ${item.summary}`)
    .join(" ")}`;
}

function vocabularyText(payload: DailyBriefing) {
  const terms = payload.vocabulary?.terms ?? [];
  if (!terms.length) return "Für heute gibt es keine Wörter des Tages.";
  return `Die Wörter des Tages. ${terms
    .slice(0, 3)
    .map((term) => `${term.term}, ${term.category}: ${term.definition}`)
    .join(" ")}`;
}

async function summaryText(signal?: AbortSignal) {
  const [weatherResult, briefingResult] = await Promise.allSettled([weather(signal), briefing(signal)]);
  const parts: string[] = [];

  if (weatherResult.status === "fulfilled") {
    const payload = weatherResult.value;
    parts.push(
      `Wetter in ${payload.location}: ${Math.round(payload.current.temperature)} Grad, ${payload.current.label},`
      + ` Regenwahrscheinlichkeit heute ${Math.round(payload.today.rainChance)} Prozent.`,
    );
  } else {
    parts.push("Das Wetter ist gerade nicht abrufbar.");
  }

  if (briefingResult.status === "fulfilled") {
    const payload = briefingResult.value;
    const headlines = payload.items.slice(0, 3).map((item) => item.title);
    parts.push(headlines.length
      ? `Wichtigste Tech-News: ${headlines.join("; ")}.`
      : "Es liegen keine Tech-News vor.");
    const terms = payload.vocabulary?.terms?.slice(0, 2).map((term) => term.term) ?? [];
    if (terms.length) parts.push(`Wörter des Tages: ${terms.join(" und ")}.`);
  } else {
    parts.push("Das Morning Briefing ist gerade nicht abrufbar.");
  }

  return parts.join(" ");
}

/** Runs a dashboard tool and returns the plain text the model receives as tool result. */
export async function runDashboardTool(name: string, args: ToolArguments, signal?: AbortSignal): Promise<string> {
  switch (name) {
    case "get_temperature":
      return temperatureText(await weather(signal));
    case "get_rain_forecast":
      return rainText(await weather(signal));
    case "get_tech_news": {
      const limit = typeof args.limit === "number" ? args.limit : 5;
      return newsText(await briefing(signal), Math.max(1, Math.min(5, limit)));
    }
    case "get_words_of_the_day":
      return vocabularyText(await briefing(signal));
    case "get_dashboard_summary":
      return summaryText(signal);
    default:
      throw new Error(`Das Werkzeug ${name} gibt es im Dashboard nicht.`);
  }
}
