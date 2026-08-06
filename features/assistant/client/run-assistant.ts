/**
 * The assistant turn: the local model picks tools, the browser runs them and the model
 * turns the results into one short spoken answer. Irreversible tools stop the loop and
 * wait for an explicit yes.
 */
import { confirmationQuestion, findAssistantTool, parseToolArguments } from "../tools";
import type {
  AssistantChatMessage,
  AssistantChatResponse,
  AssistantToolCall,
  AssistantToolStep,
  AssistantTurn,
  PendingToolConfirmation,
} from "../types";
import { runDashboardTool } from "./dashboard-tools";
import { runLocalTool } from "./local-tools";

const MAX_TOOL_ROUNDS = 3;
const MAX_HISTORY_MESSAGES = 20;

export type AssistantRunOptions = {
  signal?: AbortSignal;
  onStep?(step: AssistantToolStep): void;
};

function confirmationId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `confirm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function requestChat(messages: AssistantChatMessage[], signal?: AbortSignal) {
  const response = await fetch("/api/assistant/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: messages.slice(-MAX_HISTORY_MESSAGES) }),
    signal,
  });
  const payload = await response.json() as AssistantChatResponse & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Der lokale Sprachassistent hat nicht geantwortet.");
  return payload;
}

async function executeToolCall(
  call: AssistantToolCall,
  confirmed: boolean,
  options: AssistantRunOptions,
): Promise<AssistantToolStep> {
  const tool = findAssistantTool(call.name);
  if (!tool) {
    return { name: call.name, label: call.name, ok: false, content: "Dieses Werkzeug gibt es nicht." };
  }

  const args = parseToolArguments(tool, call.arguments);
  try {
    const content = tool.target === "dashboard"
      ? await runDashboardTool(tool.name, args, options.signal)
      : await runLocalTool(tool, args, { confirmed, signal: options.signal });
    return { name: tool.name, label: tool.label, ok: true, content };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Die Aktion ist fehlgeschlagen.";
    return { name: tool.name, label: tool.label, ok: false, content: `Fehler: ${message}` };
  }
}

function toolResultMessage(step: AssistantToolStep): AssistantChatMessage {
  return { role: "tool", tool_name: step.name, content: step.content };
}

/**
 * The action layer already answers in finished German ("Die Systemlautstärke steht jetzt auf 30
 * Prozent."). Letting a small model paraphrase that adds no value and has been observed to change
 * the numbers, so those results are spoken exactly as they came back. Dashboard tools return raw
 * data and still need the model to condense them.
 */
function speaksForItself(name: string) {
  const tool = findAssistantTool(name);
  return tool?.target === "local" && tool.spoken !== "model";
}

function spokenResult(steps: AssistantToolStep[]) {
  return steps.map((step) => step.content.replace(/^Fehler:\s*/u, "")).join(" ");
}

function assistantCallMessage(reply: AssistantChatResponse): AssistantChatMessage {
  return {
    role: "assistant",
    content: reply.content,
    tool_calls: reply.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } })),
  };
}

/** A spoken turn must never end silently, so tool results become the fallback answer. */
function fallbackText(steps: AssistantToolStep[]) {
  const failed = steps.filter((step) => !step.ok);
  if (failed.length) return failed[failed.length - 1].content.replace(/^Fehler:\s*/u, "");
  const succeeded = steps.filter((step) => step.ok);
  if (succeeded.length) return succeeded[succeeded.length - 1].content;
  return "Dazu habe ich gerade keine Antwort.";
}

async function advance(
  messages: AssistantChatMessage[],
  steps: AssistantToolStep[],
  options: AssistantRunOptions,
): Promise<AssistantTurn> {
  const conversation = [...messages];
  const collected = [...steps];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const reply = await requestChat(conversation, options.signal);
    if (!reply.toolCalls.length) {
      const text = reply.content.trim() || fallbackText(collected);
      conversation.push({ role: "assistant", content: text });
      return { messages: conversation, text, steps: collected, pending: null };
    }

    conversation.push(assistantCallMessage(reply));
    const roundSteps: AssistantToolStep[] = [];

    for (const call of reply.toolCalls) {
      const tool = findAssistantTool(call.name);
      const args = tool ? parseToolArguments(tool, call.arguments) : {};
      const question = tool ? confirmationQuestion(tool, args) : null;

      if (tool && question) {
        // Everything after an irreversible call waits; the model may ask for it again.
        const pending: PendingToolConfirmation = { id: confirmationId(), name: tool.name, arguments: args, question };
        return { messages: conversation, text: question, steps: collected, pending };
      }

      const step = await executeToolCall(call, false, options);
      collected.push(step);
      roundSteps.push(step);
      options.onStep?.(step);
      conversation.push(toolResultMessage(step));
    }

    if (roundSteps.every((step) => speaksForItself(step.name))) {
      const text = spokenResult(roundSteps);
      conversation.push({ role: "assistant", content: text });
      return { messages: conversation, text, steps: collected, pending: null };
    }
  }

  const text = fallbackText(collected);
  conversation.push({ role: "assistant", content: text });
  return { messages: conversation, text, steps: collected, pending: null };
}

export async function startAssistantTurn(
  history: AssistantChatMessage[],
  transcript: string,
  options: AssistantRunOptions = {},
): Promise<AssistantTurn> {
  const messages: AssistantChatMessage[] = [...history, { role: "user", content: transcript }];
  return advance(messages, [], options);
}

/** Continues a turn once the user answered the confirmation question. */
export async function resumeAssistantTurn(
  turn: AssistantTurn,
  approved: boolean,
  options: AssistantRunOptions = {},
): Promise<AssistantTurn> {
  const pending = turn.pending;
  if (!pending) return turn;

  if (!approved) {
    const declined: AssistantToolStep = {
      name: pending.name,
      label: findAssistantTool(pending.name)?.label ?? pending.name,
      ok: false,
      content: "Der Nutzer hat die Aktion abgelehnt. Sie wurde nicht ausgeführt.",
    };
    const text = "Alles klar, ich habe nichts verändert.";
    return {
      messages: [...turn.messages, toolResultMessage(declined), { role: "assistant", content: text }],
      text,
      steps: [...turn.steps, declined],
      pending: null,
    };
  }

  const step = await executeToolCall({ name: pending.name, arguments: pending.arguments }, true, options);
  options.onStep?.(step);
  const messages = [...turn.messages, toolResultMessage(step)];
  const steps = [...turn.steps, step];

  if (speaksForItself(step.name)) {
    const text = spokenResult([step]);
    return { messages: [...messages, { role: "assistant", content: text }], text, steps, pending: null };
  }
  return advance(messages, steps, options);
}
