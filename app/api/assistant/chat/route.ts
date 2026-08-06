import { NextResponse } from "next/server";
import { LocalModelError } from "@/features/ai/server/ollama";
import { MAX_ASSISTANT_MESSAGES, requestAssistantReply } from "@/features/assistant/server/assistant-model";
import { findAssistantTool } from "@/features/assistant/tools";
import type { AssistantChatMessage } from "@/features/assistant/types";

export const dynamic = "force-dynamic";

const MAX_CONTENT_LENGTH = 4_000;

function parseMessage(value: unknown): AssistantChatMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<AssistantChatMessage>;
  const role = message.role;
  if (role !== "user" && role !== "assistant" && role !== "tool") return null;
  const content = typeof message.content === "string" ? message.content.slice(0, MAX_CONTENT_LENGTH) : "";

  if (role === "tool") {
    const toolName = typeof message.tool_name === "string" ? message.tool_name : "";
    if (!findAssistantTool(toolName)) return null;
    return { role, content, tool_name: toolName };
  }

  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
      .filter((call) => typeof call?.function?.name === "string" && findAssistantTool(call.function.name))
      .slice(0, 4)
    : undefined;
  if (!content && !toolCalls?.length) return null;
  return toolCalls?.length ? { role, content, tool_calls: toolCalls } : { role, content };
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { messages?: unknown };
    const messages = Array.isArray(body.messages)
      ? body.messages
        .map(parseMessage)
        .filter((message): message is AssistantChatMessage => Boolean(message))
        .slice(-MAX_ASSISTANT_MESSAGES)
      : [];
    if (!messages.length) {
      return NextResponse.json({ error: "Es wurde keine verwertbare Anfrage übergeben." }, { status: 400 });
    }

    return NextResponse.json(await requestAssistantReply(messages), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Der lokale Sprachassistent ist nicht erreichbar.",
      code: error instanceof LocalModelError ? error.code : "unknown",
    }, { status: 503 });
  }
}
