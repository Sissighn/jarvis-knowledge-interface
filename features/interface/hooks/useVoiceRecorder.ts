"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type VoicePhase = "idle" | "recording" | "transcribing";

type VoiceRecorderOptions = {
  onTranscript(transcript: string): void;
  onPhaseChange(phase: VoicePhase): void;
};

type TranscriptPayload = { text?: string; error?: string };

function preferredMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function fileExtension(mimeType: string) {
  return mimeType.includes("mp4") ? "m4a" : "webm";
}

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

export function useVoiceRecorder({ onTranscript, onPhaseChange }: VoiceRecorderOptions) {
  const [supported, setSupported] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const requestControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const callbacksRef = useRef({ onTranscript, onPhaseChange });

  useEffect(() => {
    callbacksRef.current = { onTranscript, onPhaseChange };
  }, [onPhaseChange, onTranscript]);

  const updatePhase = useCallback((nextPhase: VoicePhase) => {
    setPhase(nextPhase);
    callbacksRef.current.onPhaseChange(nextPhase);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const supportTimer = window.setTimeout(() => {
      setSupported(typeof window.MediaRecorder !== "undefined" && typeof navigator.mediaDevices !== "undefined");
    }, 0);
    return () => {
      mountedRef.current = false;
      window.clearTimeout(supportTimer);
      requestControllerRef.current?.abort();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      stopTracks(streamRef.current);
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

  const start = useCallback(async () => {
    if (!supported) {
      setError("Dieser Browser kann keine Audioaufnahme bereitstellen.");
      return;
    }
    setError(null);
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
  }, [supported, transcribe, updatePhase]);

  const toggle = useCallback(() => {
    if (phase === "recording") {
      recorderRef.current?.stop();
      return;
    }
    if (phase === "idle") void start();
  }, [phase, start]);

  return {
    supported,
    phase,
    error,
    toggle,
    clearError: () => setError(null),
  };
}
