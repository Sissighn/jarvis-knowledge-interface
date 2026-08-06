/** Shared contracts for the local voice assistant: tool calling, execution and speech. */

export type AssistantToolTarget = "dashboard" | "local";

export type AssistantToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type AssistantChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Ollama matches tool results to their call by name, not by an id. */
  tool_name?: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
};

/** One finished tool run, shown in the transcript and fed back to the model. */
export type AssistantToolStep = {
  name: string;
  label: string;
  ok: boolean;
  /** Plain text handed back to the model as the tool result. */
  content: string;
};

/** An irreversible action that waits for an explicit yes before it runs. */
export type PendingToolConfirmation = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  question: string;
};

export type AssistantTurn = {
  messages: AssistantChatMessage[];
  text: string;
  steps: AssistantToolStep[];
  pending: PendingToolConfirmation | null;
};

export type AssistantChatResponse = {
  model: string;
  content: string;
  toolCalls: AssistantToolCall[];
};

export type VoiceSettings = {
  /** Empty means the browser default voice for German. */
  voiceUri: string;
  rate: number;
  volume: number;
};

export type SpotifyConnectionStatus = {
  configured: boolean;
  connected: boolean;
  authorizing: boolean;
  accountName?: string;
  premium?: boolean;
  error?: string;
};

/** Calendar and mail share one account; mail access is read-only by scope. */
export type GoogleConnectionStatus = {
  configured: boolean;
  connected: boolean;
  authorizing: boolean;
  accountEmail?: string;
  error?: string;
};

export type LocalActionStatus = {
  available: boolean;
  platform: string;
  allowedApps: string[];
  spotify: SpotifyConnectionStatus;
  google: GoogleConnectionStatus;
};
