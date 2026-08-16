"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { resumeAssistantTurn, startAssistantTurn } from "@/features/assistant/client/run-assistant";
import {
  cancelSpeech,
  curatedVoices,
  DEFAULT_VOICE_SETTINGS,
  listVoices,
  readVoiceSettings,
  resolveVoice,
  speak,
  speakableText,
  speechSupported,
  storeVoiceSettings,
  subscribeToVoices,
  type SpeechVoice,
} from "@/features/assistant/client/speech";
import {
  connectGoogle,
  connectSpotify,
  disconnectGoogle,
  disconnectSpotify,
  loadLocalStatus,
} from "@/features/assistant/client/local-tools";
import { loadNativeVoices, speakNative, stopNativeSpeech } from "@/features/assistant/client/native-speech";
import { buildSpeechEnvelope, sampleSpeechEnvelope } from "@/features/assistant/client/speech-envelope";
import type {
  AssistantChatMessage,
  AssistantToolStep,
  AssistantTurn,
  LocalActionStatus,
  PendingToolConfirmation,
  VoiceSettings,
} from "@/features/assistant/types";
import { useVoiceRecorder } from "./useVoiceRecorder";

export type AssistantPhase = "idle" | "listening" | "transcribing" | "thinking" | "speaking";

const MAX_HISTORY_MESSAGES = 12;
const CONNECTION_POLL_INTERVAL_MS = 2_000;
const CONNECTION_POLL_ATTEMPTS = 90;
const YES_PATTERN = /^(ja|jawohl|jap|klar|okay|ok|bestätige|bestätigen|mach das|fortfahren|weiter|bitte)\b/iu;
const NO_PATTERN = /^(nein|ne|nö|stopp|stop|abbrechen|abbruch|lieber nicht|nicht)\b/iu;

export function useVoiceAssistant() {
  const [phase, setPhase] = useState<AssistantPhase>("idle");
  const [active, setActive] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [steps, setSteps] = useState<AssistantToolStep[]>([]);
  const [pending, setPending] = useState<PendingToolConfirmation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_VOICE_SETTINGS);
  const [voices, setVoices] = useState<SpeechVoice[]>([]);
  const [nativeVoices, setNativeVoices] = useState<SpeechVoice[]>([]);
  const [voiceOutputSupported, setVoiceOutputSupported] = useState(false);
  const [localStatus, setLocalStatus] = useState<LocalActionStatus | null>(null);
  const [connectingSpotify, setConnectingSpotify] = useState(false);
  const [connectingGoogle, setConnectingGoogle] = useState(false);

  const historyRef = useRef<AssistantChatMessage[]>([]);
  const turnRef = useRef<AssistantTurn | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const settingsRef = useRef(settings);
  const phaseRef = useRef<AssistantPhase>("idle");
  const speechActivity = useRef(0);
  const speechAnimationRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const spotifyPollRef = useRef<number | null>(null);
  const googlePollRef = useRef<number | null>(null);

  const updatePhase = useCallback((next: AssistantPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const stopSpeechAnimation = useCallback(() => {
    if (speechAnimationRef.current !== null) window.cancelAnimationFrame(speechAnimationRef.current);
    speechAnimationRef.current = null;
    speechActivity.current = 0;
  }, []);

  const startSpeechAnimation = useCallback((text: string, rate: number) => {
    stopSpeechAnimation();
    const envelope = buildSpeechEnvelope(speakableText(text), rate);
    if (!envelope.durationMs) return;
    const startedAt = window.performance.now();
    let previousFrame = startedAt;

    const animate = (now: number) => {
      const target = sampleSpeechEnvelope(envelope, now - startedAt);
      const frameDuration = Math.max(8, Math.min(48, now - previousFrame));
      previousFrame = now;
      // A slower release makes adjacent words flow into each other; the faster attack
      // still lets the core visibly answer without snapping to every syllable.
      const timeConstant = target > speechActivity.current ? 95 : 190;
      const smoothing = 1 - Math.exp(-frameDuration / timeConstant);
      speechActivity.current += (target - speechActivity.current) * smoothing;
      if (phaseRef.current !== "speaking") {
        stopSpeechAnimation();
        return;
      }
      speechAnimationRef.current = window.requestAnimationFrame(animate);
    };
    speechAnimationRef.current = window.requestAnimationFrame(animate);
  }, [stopSpeechAnimation]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      if (spotifyPollRef.current) window.clearInterval(spotifyPollRef.current);
      if (googlePollRef.current) window.clearInterval(googlePollRef.current);
      stopSpeechAnimation();
      cancelSpeech();
      void stopNativeSpeech();
    };
  }, [stopSpeechAnimation]);

  useEffect(() => {
    const startup = window.setTimeout(() => {
      setVoiceOutputSupported(speechSupported());
      setSettings(readVoiceSettings());
      setVoices(listVoices());
    }, 0);
    const unsubscribe = subscribeToVoices((available) => setVoices(available));
    return () => {
      window.clearTimeout(startup);
      unsubscribe();
    };
  }, []);

  const refreshLocalStatus = useCallback(async () => {
    const status = await loadLocalStatus();
    if (mountedRef.current) setLocalStatus(status);
    return status;
  }, []);

  useEffect(() => {
    const startup = window.setTimeout(() => void refreshLocalStatus(), 0);
    return () => window.clearTimeout(startup);
  }, [refreshLocalStatus]);

  // The system voices reach the assistant only through the local action layer, because the
  // embedded WebView hides every downloaded premium voice from the page.
  useEffect(() => {
    const controller = new AbortController();
    const startup = window.setTimeout(() => {
      void loadNativeVoices(controller.signal).then((available) => {
        if (mountedRef.current) setNativeVoices(available);
      });
    }, 0);
    return () => {
      window.clearTimeout(startup);
      controller.abort();
    };
  }, []);

  const nativeVoicesRef = useRef<SpeechVoice[]>([]);
  useEffect(() => {
    nativeVoicesRef.current = nativeVoices;
  }, [nativeVoices]);

  /** Stops whichever output is speaking, so barge-in works on both paths. */
  const silence = useCallback(() => {
    stopSpeechAnimation();
    cancelSpeech();
    if (nativeVoicesRef.current.length) void stopNativeSpeech();
  }, [stopSpeechAnimation]);

  const speakReply = useCallback((text: string) => {
    if (!text.trim()) {
      updatePhase("idle");
      return;
    }
    updatePhase("speaking");

    if (nativeVoicesRef.current.length) {
      void speakNative(text, settingsRef.current, undefined, {
        onActivity: (level) => {
          speechActivity.current = level;
        },
      })
        .catch((cause: unknown) => {
          if (mountedRef.current) {
            setError(cause instanceof Error ? cause.message : "Die Sprachausgabe ist fehlgeschlagen.");
          }
        })
        .finally(() => {
          stopSpeechAnimation();
          if (mountedRef.current && phaseRef.current === "speaking") updatePhase("idle");
        });
      return;
    }

    // Browser speech synthesis exposes no audio stream, so only this fallback uses
    // the deterministic text envelope. The macOS app follows the real waveform above.
    startSpeechAnimation(text, settingsRef.current.rate);
    speak(text, settingsRef.current, {
      onEnd: () => {
        stopSpeechAnimation();
        if (mountedRef.current && phaseRef.current === "speaking") updatePhase("idle");
      },
      onError: (message) => {
        if (mountedRef.current) setError(message);
      },
    });
  }, [startSpeechAnimation, stopSpeechAnimation, updatePhase]);

  const applyTurn = useCallback((turn: AssistantTurn) => {
    turnRef.current = turn;
    setSteps(turn.steps);
    setReply(turn.text);
    setPending(turn.pending);
    if (!turn.pending) historyRef.current = turn.messages.slice(-MAX_HISTORY_MESSAGES);
    speakReply(turn.text);
  }, [speakReply]);

  const failTurn = useCallback((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : "Der Sprachassistent ist gerade nicht erreichbar.";
    setError(message);
    setReply(message);
    setPending(null);
    turnRef.current = null;
    speakReply(message);
  }, [speakReply]);

  const answerConfirmation = useCallback((approved: boolean) => {
    const turn = turnRef.current;
    if (!turn?.pending) return;
    silence();
    setPending(null);
    updatePhase("thinking");
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;

    void resumeAssistantTurn(turn, approved, {
      signal: controller.signal,
      onStep: (step) => {
        if (mountedRef.current) setSteps((current) => [...current, step]);
      },
    })
      .then((next) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        applyTurn(next);
      })
      .catch((cause: unknown) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        failTurn(cause);
      });
  }, [applyTurn, failTurn, silence, updatePhase]);

  const handleTranscript = useCallback((text: string) => {
    setTranscript(text);
    setError(null);

    // A spoken yes or no answers an open confirmation instead of starting a new turn.
    if (turnRef.current?.pending) {
      if (YES_PATTERN.test(text)) {
        answerConfirmation(true);
        return;
      }
      if (NO_PATTERN.test(text)) {
        answerConfirmation(false);
        return;
      }
    }

    setSteps([]);
    setReply("");
    setPending(null);
    updatePhase("thinking");
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;

    void startAssistantTurn(historyRef.current, text, {
      signal: controller.signal,
      onStep: (step) => {
        if (mountedRef.current) setSteps((current) => [...current, step]);
      },
    })
      .then((turn) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        applyTurn(turn);
      })
      .catch((cause: unknown) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        failTurn(cause);
      });
  }, [answerConfirmation, applyTurn, failTurn, updatePhase]);

  const recorder = useVoiceRecorder({
    onTranscript: handleTranscript,
    onPhaseChange: (voicePhase) => {
      if (voicePhase === "recording") {
        updatePhase("listening");
        return;
      }
      if (voicePhase === "transcribing") {
        updatePhase("transcribing");
        return;
      }
      // The recorder reports idle right after handing over the transcript.
      if (phaseRef.current === "listening" || phaseRef.current === "transcribing") updatePhase("idle");
    },
  });

  const stopSpeaking = useCallback(() => {
    silence();
    if (phaseRef.current === "speaking") updatePhase("idle");
  }, [silence, updatePhase]);

  /** One button for the whole loop: interrupt, record, stop recording. */
  const toggleListening = useCallback(() => {
    setActive(true);
    if (phaseRef.current === "speaking") {
      silence();
      updatePhase("idle");
    }
    if (phaseRef.current === "thinking") {
      controllerRef.current?.abort();
      updatePhase("idle");
    }
    recorder.toggle();
  }, [recorder, silence, updatePhase]);

  const updateSettings = useCallback((partial: Partial<VoiceSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...partial };
      storeVoiceSettings(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    silence();
    historyRef.current = [];
    turnRef.current = null;
    setTranscript("");
    setReply("");
    setSteps([]);
    setPending(null);
    setError(null);
    setActive(false);
    updatePhase("idle");
  }, [silence, updatePhase]);

  /** A login finishes in the browser, so the status is polled until the account lands. */
  const awaitConnection = useCallback(async (connection: {
    start(): Promise<unknown>;
    connected(status: LocalActionStatus): boolean;
    setBusy(busy: boolean): void;
    poll: MutableRefObject<number | null>;
    failure: string;
  }) => {
    connection.setBusy(true);
    setError(null);
    try {
      await connection.start();
      let attempts = 0;
      if (connection.poll.current) window.clearInterval(connection.poll.current);
      connection.poll.current = window.setInterval(() => {
        attempts += 1;
        void refreshLocalStatus().then((status) => {
          if (!mountedRef.current) return;
          if ((status && connection.connected(status)) || attempts >= CONNECTION_POLL_ATTEMPTS) {
            if (connection.poll.current) window.clearInterval(connection.poll.current);
            connection.poll.current = null;
            connection.setBusy(false);
          }
        });
      }, CONNECTION_POLL_INTERVAL_MS);
    } catch (cause) {
      connection.setBusy(false);
      setError(cause instanceof Error ? cause.message : connection.failure);
    }
  }, [refreshLocalStatus]);

  const startSpotifyConnect = useCallback(() => awaitConnection({
    start: connectSpotify,
    connected: (status) => status.spotify.connected,
    setBusy: setConnectingSpotify,
    poll: spotifyPollRef,
    failure: "Die Spotify-Anmeldung konnte nicht gestartet werden.",
  }), [awaitConnection]);

  const startGoogleConnect = useCallback(() => awaitConnection({
    start: connectGoogle,
    connected: (status) => status.google.connected,
    setBusy: setConnectingGoogle,
    poll: googlePollRef,
    failure: "Die Google-Anmeldung konnte nicht gestartet werden.",
  }), [awaitConnection]);

  const stopSpotifyConnection = useCallback(async () => {
    try {
      await disconnectSpotify();
      await refreshLocalStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Spotify konnte nicht getrennt werden.");
    }
  }, [refreshLocalStatus]);

  const stopGoogleConnection = useCallback(async () => {
    try {
      await disconnectGoogle();
      await refreshLocalStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Das Google-Konto konnte nicht getrennt werden.");
    }
  }, [refreshLocalStatus]);

  // The action layer serves an already curated list; the browser list still has to be reduced.
  const offeredVoices = nativeVoices.length ? nativeVoices : curatedVoices(voices);

  return {
    phase,
    speechActivity,
    active,
    curatedVoices: offeredVoices,
    transcript,
    reply,
    steps,
    pending,
    error: error ?? recorder.error,
    settings,
    voices,
    voiceOutputSupported: voiceOutputSupported || nativeVoices.length > 0,
    // The resolved voice is shown in the panel so a silent fallback never goes unnoticed.
    activeVoice: resolveVoice(offeredVoices, settings),
    micSupported: recorder.supported,
    captureMode: recorder.captureMode,
    localStatus,
    connectingSpotify,
    connectingGoogle,
    toggleListening,
    stopSpeaking,
    answerConfirmation,
    updateSettings,
    reset,
    clearError: () => {
      setError(null);
      recorder.clearError();
    },
    startSpotifyConnect,
    stopSpotifyConnection,
    startGoogleConnect,
    stopGoogleConnection,
  };
}
