"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type VoicePhase = "idle" | "recording" | "transcribing";

/**
 * The browser records through MediaRecorder. Inside the packaged app that path does not
 * exist, because WKWebView withholds `navigator.mediaDevices` from the loopback origin, so
 * the native Tauri capture takes over and returns a finished WAV file.
 */
type CaptureMode = "browser" | "native" | "unavailable";

type VoiceRecorderOptions = {
  onTranscript(transcript: string): void;
  onPhaseChange(phase: VoicePhase): void;
};

type TranscriptPayload = { text?: string; error?: string };

const UNSUPPORTED_MESSAGE = "Diese Ansicht kann nicht auf das Mikrofon zugreifen. "
  + "Öffne JARVIS als App oder rufe die Oberfläche im Browser über localhost auf.";

function isTauriDesktop() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function detectCaptureMode(): CaptureMode {
  if (isTauriDesktop()) return "native";
  const browserReady = typeof window.MediaRecorder !== "undefined"
    && typeof navigator.mediaDevices !== "undefined";
  return browserReady ? "browser" : "unavailable";
}

async function invokeTauri<T>(command: string): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command);
}

function preferredMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function fileExtension(mimeType: string) {
  if (mimeType.includes("wav")) return "wav";
  return mimeType.includes("mp4") ? "m4a" : "webm";
}

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

export function useVoiceRecorder({ onTranscript, onPhaseChange }: VoiceRecorderOptions) {
  const [captureMode, setCaptureMode] = useState<CaptureMode>("unavailable");
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const requestControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const phaseRef = useRef<VoicePhase>("idle");
  const captureModeRef = useRef<CaptureMode>("unavailable");
  const callbacksRef = useRef({ onTranscript, onPhaseChange });

  useEffect(() => {
    callbacksRef.current = { onTranscript, onPhaseChange };
  }, [onPhaseChange, onTranscript]);

  const updatePhase = useCallback((nextPhase: VoicePhase) => {
    phaseRef.current = nextPhase;
    setPhase(nextPhase);
    callbacksRef.current.onPhaseChange(nextPhase);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const supportTimer = window.setTimeout(() => {
      const mode = detectCaptureMode();
      captureModeRef.current = mode;
      setCaptureMode(mode);
    }, 0);
    return () => {
      mountedRef.current = false;
      window.clearTimeout(supportTimer);
      requestControllerRef.current?.abort();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      stopTracks(streamRef.current);
      // A native recording keeps running in Rust until it is told to stop.
      if (captureModeRef.current === "native" && phaseRef.current === "recording") {
        void invokeTauri("cancel_voice_capture").catch(() => undefined);
      }
    };
  }, []);

  const transcribe = useCallback(async (blob: Blob) => {
    updatePhase("transcribing");
    const controller = new AbortController();
    requestControllerRef.current = controller;
    const form = new FormData();
    const mimeType = blob.type || "audio/webm";
    form.append("audio", blob, `jarvis-recording.${fileExtension(mimeType)}`);

    try {
      const response = await fetch("/api/speech/transcribe", {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const payload = await response.json() as TranscriptPayload;
      if (!response.ok) throw new Error(payload.error || "Die Aufnahme konnte nicht transkribiert werden.");
      const transcript = payload.text?.trim() ?? "";
      if (!transcript) throw new Error("Whisper hat keine Sprache erkannt.");
      if (mountedRef.current) callbacksRef.current.onTranscript(transcript);
    } catch (requestError) {
      if (controller.signal.aborted || !mountedRef.current) return;
      setError(requestError instanceof Error ? requestError.message : "Die lokale Transkription ist fehlgeschlagen.");
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
      if (!controller.signal.aborted && mountedRef.current) updatePhase("idle");
    }
  }, [updatePhase]);

  const startNative = useCallback(async () => {
    try {
      await invokeTauri("start_voice_capture");
      if (!mountedRef.current) {
        void invokeTauri("cancel_voice_capture").catch(() => undefined);
        return;
      }
      updatePhase("recording");
    } catch (captureError) {
      setError(typeof captureError === "string"
        ? captureError
        : "Das Mikrofon konnte nicht gestartet werden. Erlaube JARVIS den Zugriff in den Systemeinstellungen unter Datenschutz und Sicherheit.");
      updatePhase("idle");
    }
  }, [updatePhase]);

  const stopNative = useCallback(async () => {
    try {
      const audio = await invokeTauri<ArrayBuffer>("stop_voice_capture");
      if (!mountedRef.current) return;
      const blob = new Blob([audio], { type: "audio/wav" });
      if (!blob.size) {
        setError("Die Aufnahme war leer. Bitte versuche es erneut.");
        updatePhase("idle");
        return;
      }
      void transcribe(blob);
    } catch (captureError) {
      if (!mountedRef.current) return;
      setError(typeof captureError === "string" ? captureError : "Die Aufnahme konnte nicht abgeschlossen werden.");
      updatePhase("idle");
    }
  }, [transcribe, updatePhase]);

  const startBrowser = useCallback(async () => {
    chunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!mountedRef.current) {
        stopTracks(stream);
        return;
      }
      streamRef.current = stream;
      const mimeType = preferredMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        if (!mountedRef.current) return;
        setError("Die Audioaufnahme wurde unerwartet unterbrochen.");
        stopTracks(streamRef.current);
        streamRef.current = null;
        updatePhase("idle");
      };
      recorder.onstop = () => {
        const audio = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        chunksRef.current = [];
        recorderRef.current = null;
        stopTracks(streamRef.current);
        streamRef.current = null;
        if (!mountedRef.current) return;
        if (!audio.size) {
          setError("Die Aufnahme war leer. Bitte versuche es erneut.");
          updatePhase("idle");
          return;
        }
        void transcribe(audio);
      };
      recorder.start(1_000);
      updatePhase("recording");
    } catch (captureError) {
      stopTracks(streamRef.current);
      streamRef.current = null;
      setError(captureError instanceof DOMException && captureError.name === "NotAllowedError"
        ? "Mikrofonzugriff wurde nicht erlaubt."
        : "Das Mikrofon konnte nicht gestartet werden.");
      updatePhase("idle");
    }
  }, [transcribe, updatePhase]);

  const start = useCallback(async () => {
    if (captureMode === "unavailable") {
      setError(UNSUPPORTED_MESSAGE);
      return;
    }
    setError(null);
    if (captureMode === "native") {
      await startNative();
      return;
    }
    await startBrowser();
  }, [captureMode, startBrowser, startNative]);

  const toggle = useCallback(() => {
    if (phase === "recording") {
      if (captureMode === "native") void stopNative();
      else recorderRef.current?.stop();
      return;
    }
    if (phase === "idle") void start();
  }, [captureMode, phase, start, stopNative]);

  return {
    supported: captureMode !== "unavailable",
    captureMode,
    phase,
    error,
    toggle,
    clearError: () => setError(null),
  };
}
