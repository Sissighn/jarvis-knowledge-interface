/** Server-only Open-Meteo client with a short-lived in-memory cache. */
import type { WeatherPayload } from "../types";

type OpenMeteoResponse = {
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    is_day?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: Array<number | null>;
  };
};

const CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_LOCATION = {
  name: "Berlin",
  latitude: 52.52,
  longitude: 13.405,
};

let memoryCache: { key: string; createdAt: number; value: WeatherPayload } | null = null;

function coordinate(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function weatherDescription(code: number, isDay = true) {
  if (code === 0) return { label: "Klar", symbol: isDay ? "☼" : "☾" };
  if (code === 1) return { label: "Meist klar", symbol: isDay ? "◒" : "☾" };
  if (code === 2) return { label: "Leicht bewölkt", symbol: "◒" };
  if (code === 3) return { label: "Bewölkt", symbol: "●" };
  if (code === 45 || code === 48) return { label: "Nebel", symbol: "≋" };
  if (code >= 51 && code <= 57) return { label: "Nieselregen", symbol: "⋰" };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { label: code >= 80 ? "Regenschauer" : "Regen", symbol: "⋰" };
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return { label: "Schnee", symbol: "✳" };
  if (code >= 95) return { label: "Gewitter", symbol: "ϟ" };
  return { label: "Unbekannt", symbol: "○" };
}

function requiredNumber(value: number | undefined, field: string) {
  if (!Number.isFinite(value)) throw new Error(`Wetterdaten enthalten kein gültiges Feld: ${field}.`);
  return value as number;
}

export async function getWeather(force = false): Promise<WeatherPayload> {
  const location = {
    name: process.env.WEATHER_LOCATION_NAME?.trim() || DEFAULT_LOCATION.name,
    latitude: coordinate(process.env.WEATHER_LATITUDE, DEFAULT_LOCATION.latitude, -90, 90),
    longitude: coordinate(process.env.WEATHER_LONGITUDE, DEFAULT_LOCATION.longitude, -180, 180),
  };
  const cacheKey = `${location.name}:${location.latitude}:${location.longitude}`;

  if (!force && memoryCache?.key === cacheKey && Date.now() - memoryCache.createdAt < CACHE_TTL_MS) {
    return memoryCache.value;
  }

  const parameters = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    current: "temperature_2m,apparent_temperature,is_day,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "auto",
    forecast_days: "4",
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6500);

  try {
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${parameters}`, {
      signal: controller.signal,
      cache: "no-store",
      headers: { "User-Agent": "JARVIS-local-weather/0.1" },
    });
    if (!response.ok) throw new Error(`Open-Meteo antwortet mit HTTP ${response.status}.`);

    const raw = await response.json() as OpenMeteoResponse;
    const currentCode = requiredNumber(raw.current?.weather_code, "current.weather_code");
    const currentDescription = weatherDescription(currentCode, raw.current?.is_day !== 0);
    const dates = raw.daily?.time ?? [];
    const dailyCodes = raw.daily?.weather_code ?? [];
    const maxValues = raw.daily?.temperature_2m_max ?? [];
    const minValues = raw.daily?.temperature_2m_min ?? [];
    const rainValues = raw.daily?.precipitation_probability_max ?? [];

    if (!dates.length || !Number.isFinite(maxValues[0]) || !Number.isFinite(minValues[0])) {
      throw new Error("Open-Meteo hat keine vollständige Tagesprognose geliefert.");
    }

    const forecast = dates.map((date, index) => {
      const code = Number.isFinite(dailyCodes[index]) ? dailyCodes[index] : currentCode;
      const description = weatherDescription(code);
      return {
        date,
        weatherCode: code,
        label: description.label,
        symbol: description.symbol,
        max: requiredNumber(maxValues[index], `daily.temperature_2m_max[${index}]`),
        min: requiredNumber(minValues[index], `daily.temperature_2m_min[${index}]`),
        rainChance: Number.isFinite(rainValues[index]) ? Number(rainValues[index]) : 0,
      };
    });

    const value: WeatherPayload = {
      location: location.name,
      updatedAt: raw.current?.time || new Date().toISOString(),
      current: {
        temperature: requiredNumber(raw.current?.temperature_2m, "current.temperature_2m"),
        apparentTemperature: requiredNumber(raw.current?.apparent_temperature, "current.apparent_temperature"),
        weatherCode: currentCode,
        label: currentDescription.label,
        symbol: currentDescription.symbol,
        windSpeed: requiredNumber(raw.current?.wind_speed_10m, "current.wind_speed_10m"),
      },
      today: {
        max: forecast[0].max,
        min: forecast[0].min,
        rainChance: forecast[0].rainChance,
      },
      forecast,
      attribution: { label: "Open-Meteo", url: "https://open-meteo.com/" },
    };

    memoryCache = { key: cacheKey, createdAt: Date.now(), value };
    return value;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Die Wetterquelle hat zu lange gebraucht.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
