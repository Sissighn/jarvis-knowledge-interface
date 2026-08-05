"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { LocalModelStatus } from "@/features/ai/types";
import type { VocabularySaveResult } from "@/features/glossary/types";
import { notifyBriefingReady } from "@/features/desktop/notifications";
import type { DailyBriefing, WeatherPayload } from "../types";

const BRIEFING_CACHE_KEY = "jarvis-briefing-cache-v1";
const BRIEFING_HIDDEN_KEY = "jarvis-briefing-hidden-v1";
const BRIEFING_SAVED_KEY = "jarvis-briefing-saved-v1";
const VOCABULARY_SAVED_KEY = "jarvis-vocabulary-notion-saved-v1";

function readStoredIds(key: string) {
  const value = window.localStorage.getItem(key);
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

function currentBerlinDateKey() {
  const parts = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function useJarvisData() {
  const [briefing, setBriefing] = useState<DailyBriefing | null>(null);
  const [briefingLoading, setBriefingLoading] = useState(true);
  const [briefingError, setBriefingError] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherPayload | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(true);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [hiddenBriefingIds, setHiddenBriefingIds] = useState<string[]>([]);
  const [savedBriefingIds, setSavedBriefingIds] = useState<string[]>([]);
  const [savedVocabularyIds, setSavedVocabularyIds] = useState<string[]>([]);
  const [savingVocabularyId, setSavingVocabularyId] = useState<string | null>(null);
  const [vocabularySaveError, setVocabularySaveError] = useState<string | null>(null);
  const [footerDate, setFooterDate] = useState("—");
  const [modelStatus, setModelStatus] = useState<LocalModelStatus>({
    provider: "ollama",
    configured: true,
    connected: false,
    model: "qwen3.5:4b",
    modelAvailable: false,
  });

  const loadModelStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/ai/status", { cache: "no-store" });
      const payload = await response.json() as LocalModelStatus;
      if (response.ok) setModelStatus(payload);
    } catch {
      setModelStatus((current) => ({
        ...current,
        connected: false,
        modelAvailable: false,
        error: "Ollama ist nicht erreichbar.",
      }));
    }
  }, []);

  const loadBriefing = useCallback(async (force = false) => {
    setBriefingLoading(true);
    setBriefingError(null);
    try {
      const response = await fetch(`/api/briefing${force ? "?force=1" : ""}`, { cache: "no-store" });
      const payload = await response.json() as DailyBriefing & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Das Morning Briefing konnte nicht geladen werden.");
      setBriefing(payload);
      window.localStorage.setItem(BRIEFING_CACHE_KEY, JSON.stringify(payload));
      void notifyBriefingReady(payload.date, payload.items.length);
    } catch (error) {
      setBriefingError(error instanceof Error ? error.message : "Die Quellen sind momentan nicht erreichbar.");
    } finally {
      setBriefingLoading(false);
    }
  }, []);

  const loadWeather = useCallback(async (force = false) => {
    setWeatherLoading(true);
    setWeatherError(null);
    try {
      const response = await fetch(`/api/weather${force ? "?force=1" : ""}`, { cache: "no-store" });
      const payload = await response.json() as WeatherPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Das Wetter konnte nicht geladen werden.");
      setWeather(payload);
    } catch (error) {
      setWeatherError(error instanceof Error ? error.message : "Das Wetter ist momentan nicht erreichbar.");
    } finally {
      setWeatherLoading(false);
    }
  }, []);

  useEffect(() => {
    const startupWeather = window.setTimeout(() => void loadWeather(), 0);
    const weatherInterval = window.setInterval(() => void loadWeather(), 30 * 60 * 1000);
    return () => {
      window.clearTimeout(startupWeather);
      window.clearInterval(weatherInterval);
    };
  }, [loadWeather]);

  useEffect(() => {
    const startupModelCheck = window.setTimeout(() => void loadModelStatus(), 0);
    const modelCheckInterval = window.setInterval(() => void loadModelStatus(), 45_000);
    return () => {
      window.clearTimeout(startupModelCheck);
      window.clearInterval(modelCheckInterval);
    };
  }, [loadModelStatus]);

  useEffect(() => {
    const startupBriefing = window.setTimeout(() => {
      try {
        const cached = window.localStorage.getItem(BRIEFING_CACHE_KEY);
        if (cached) {
          const parsed = JSON.parse(cached) as DailyBriefing;
          const today = currentBerlinDateKey();
          if (parsed.date === today) setBriefing(parsed);
        }
        setHiddenBriefingIds(readStoredIds(BRIEFING_HIDDEN_KEY));
        setSavedBriefingIds(readStoredIds(BRIEFING_SAVED_KEY));
        setSavedVocabularyIds(readStoredIds(VOCABULARY_SAVED_KEY));
      } catch {
        window.localStorage.removeItem(BRIEFING_CACHE_KEY);
        window.localStorage.removeItem(BRIEFING_HIDDEN_KEY);
        window.localStorage.removeItem(BRIEFING_SAVED_KEY);
        window.localStorage.removeItem(VOCABULARY_SAVED_KEY);
      }
      void loadBriefing();
    }, 0);
    return () => window.clearTimeout(startupBriefing);
  }, [loadBriefing]);

  useEffect(() => {
    const updateFooterDate = () => setFooterDate(new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin",
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(new Date()).toUpperCase());
    const startupDate = window.setTimeout(updateFooterDate, 0);
    const dateInterval = window.setInterval(updateFooterDate, 60_000);
    return () => {
      window.clearTimeout(startupDate);
      window.clearInterval(dateInterval);
    };
  }, []);

  const visibleBriefingItems = useMemo(
    () => briefing?.items.filter((item) => !hiddenBriefingIds.includes(item.id)) ?? [],
    [briefing, hiddenBriefingIds],
  );

  const hideBriefingItem = useCallback((id: string) => {
    setHiddenBriefingIds((current) => {
      const next = [...new Set([...current, id])];
      window.localStorage.setItem(BRIEFING_HIDDEN_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const toggleSavedBriefingItem = useCallback((id: string) => {
    setSavedBriefingIds((current) => {
      const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
      window.localStorage.setItem(BRIEFING_SAVED_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const briefingDate = briefing?.date;
  const saveVocabularyTerm = useCallback(async (termId: string) => {
    if (!briefingDate || savingVocabularyId) return;
    setSavingVocabularyId(termId);
    setVocabularySaveError(null);
    try {
      const response = await fetch("/api/glossary/notion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ termId, date: briefingDate }),
      });
      const payload = await response.json() as VocabularySaveResult;
      if (!response.ok || !payload.saved) {
        throw new Error(payload.error || "Der Begriff konnte nicht in Notion gespeichert werden.");
      }
      setSavedVocabularyIds((current) => {
        const next = [...new Set([...current, termId])];
        window.localStorage.setItem(VOCABULARY_SAVED_KEY, JSON.stringify(next));
        return next;
      });
    } catch (error) {
      setVocabularySaveError(error instanceof Error ? error.message : "Notion ist momentan nicht erreichbar.");
    } finally {
      setSavingVocabularyId(null);
    }
  }, [briefingDate, savingVocabularyId]);

  return {
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
  };
}
