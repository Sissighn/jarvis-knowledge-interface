/**
 * Gmail access for the voice assistant: reading metadata, reading one message, archiving, and
 * moving to the trash.
 *
 * The granted scope is `gmail.modify`, because Google offers nothing narrower for archiving or
 * trashing — and that scope would technically also permit sending. The boundary therefore lives
 * here: `gmailCall` is the only way out of this module, and it refuses everything that is not on
 * ALLOWED_ENDPOINTS. `messages.send`, `drafts`, and permanent deletion are unreachable by
 * construction, not by convention.
 */
import { googleRequest } from "./google-auth";
import { spokenText } from "./text";
import { shiftDay, startOfDay, zonedClock, zonedDate, zonedDay } from "./zoned-time";
import { LocalActionError } from "./macos";

type MessageHeader = { name?: string; value?: string };
type MessageReference = { id?: string };
type MessagePart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: MessagePart[];
};
type MessageMetadata = {
  id?: string;
  internalDate?: string;
  payload?: { headers?: MessageHeader[]; mimeType?: string; body?: { data?: string }; parts?: MessagePart[] };
};

export type MailSummary = {
  id: string;
  sender: string;
  subject: string;
  when: string;
};

const API_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_LISTED_MESSAGES = 5;
const DEFAULT_LISTED_MESSAGES = 3;
/** No spoken command may ever touch more than this many messages at once. */
const MAX_AFFECTED_MESSAGES = 10;
const MAX_BODY_CHARACTERS = 1_500;

/**
 * Every Gmail endpoint this app may reach, with the single method it may use. Anything absent —
 * `messages/send`, `drafts`, `messages/{id}` with DELETE — throws before a request is built.
 */
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const ALLOWED_ENDPOINTS: Array<{ method: HttpMethod; pattern: RegExp }> = [
  { method: "GET", pattern: /^\/labels\/INBOX$/u },
  { method: "GET", pattern: /^\/messages(\?.*)?$/u },
  { method: "GET", pattern: /^\/messages\/[\w-]+(\?.*)?$/u },
  { method: "POST", pattern: /^\/messages\/[\w-]+\/modify$/u },
  { method: "POST", pattern: /^\/messages\/[\w-]+\/trash$/u },
];

/** Labels a spoken command may remove. Adding labels is not something the assistant does. */
const REMOVABLE_LABELS = new Set(["INBOX", "UNREAD"]);

const CHARSET_ALIASES: Record<string, BufferEncoding> = {
  "utf-8": "utf8",
  "utf8": "utf8",
  "us-ascii": "ascii",
  "iso-8859-1": "latin1",
  "iso-8859-15": "latin1",
  "windows-1252": "latin1",
};

/**
 * The one door out of this module. The path is checked against the allowlist before anything is
 * sent, so a future edit cannot quietly reach an endpoint that writes or sends.
 */
export async function gmailCall(path: string, method: HttpMethod = "GET", body?: unknown) {
  const allowed = ALLOWED_ENDPOINTS.some((entry) => entry.method === method && entry.pattern.test(path));
  if (!allowed) {
    throw new LocalActionError(`JARVIS darf ${method} ${path.split("?")[0]} bei Gmail nicht aufrufen.`, 403);
  }
  return googleRequest(`${API_BASE_URL}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Gmail returns raw headers, so a name with an umlaut arrives as an RFC 2047 encoded word. */
function decodeEncodedWords(value: string) {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/gu, (match, charset: string, encoding: string, text: string) => {
    const target = CHARSET_ALIASES[charset.toLowerCase().split("*")[0]] ?? "utf8";
    try {
      if (encoding.toLowerCase() === "b") return Buffer.from(text, "base64").toString(target);
      const bytes = text
        .replace(/_/gu, " ")
        .replace(/=([\da-fA-F]{2})/gu, (_hexMatch, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
      return Buffer.from(bytes, "latin1").toString(target);
    } catch {
      return match;
    }
  });
}

function header(message: MessageMetadata, name: string) {
  const found = message.payload?.headers?.find((entry) => entry.name?.toLowerCase() === name.toLowerCase());
  return typeof found?.value === "string" ? decodeEncodedWords(found.value) : "";
}

/** Turns `"Anna Müller" <anna@example.com>` into the part a person would say out loud. */
export function senderName(raw: string) {
  const decoded = decodeEncodedWords(raw);
  const addressed = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/u.exec(decoded);
  const name = addressed?.[1]?.trim();
  if (name) return spokenText(name, 80);
  return spokenText((addressed?.[2] ?? decoded).replace(/[<>]/gu, ""), 80);
}

export function receivedLabel(internalDate: unknown) {
  const milliseconds = Number(internalDate);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "";
  const received = new Date(milliseconds);
  const today = zonedDay(new Date());
  const day = zonedDay(received);
  if (day === today) return `heute um ${zonedClock(received)}`;
  if (day === shiftDay(today, -1)) return `gestern um ${zonedClock(received)}`;
  return `am ${zonedDate(received)} um ${zonedClock(received)}`;
}

export function clampMessageCount(value: unknown) {
  const count = typeof value === "number" ? value : Number(String(value ?? "").replace(/[^\d]/gu, ""));
  if (!Number.isFinite(count) || count <= 0) return DEFAULT_LISTED_MESSAGES;
  return Math.max(1, Math.min(MAX_LISTED_MESSAGES, Math.round(count)));
}

function describeMail({ sender, subject, when }: MailSummary) {
  return [`von ${sender || "unbekanntem Absender"}`, `über ${subject || "ohne Betreff"}`, when]
    .filter(Boolean)
    .join(", ");
}

export function describeMails(messages: MailSummary[]) {
  return messages.map(describeMail).join("; ");
}

/**
 * Builds the Gmail query. A day becomes an exact local window through epoch seconds instead of
 * Gmail's day-granular `after:`, whose boundary follows the account time zone. Own mail stays
 * out: the question behind this tool is always what arrived, never what was written.
 */
export function buildSearchQuery(query: string, day: string) {
  const parts = ["-in:sent", "-in:drafts", "-in:chats"];
  if (query) parts.unshift(query);
  if (day) {
    const from = Math.floor(startOfDay(day).getTime() / 1000);
    const until = Math.floor(startOfDay(shiftDay(day, 1)).getTime() / 1000);
    parts.push(`after:${from}`, `before:${until}`);
  }
  return parts.join(" ");
}

async function loadMetadata(id: string): Promise<MailSummary | null> {
  const query = new URLSearchParams([
    ["format", "metadata"],
    ["metadataHeaders", "From"],
    ["metadataHeaders", "Subject"],
  ]);
  const message = await gmailCall(`/messages/${encodeURIComponent(id)}?${query}`) as MessageMetadata | null;
  if (!message) return null;
  return {
    id,
    sender: senderName(header(message, "From")),
    // Subject text reaches the model as data, never as an instruction, and stays one short line.
    subject: spokenText(header(message, "Subject"), 120),
    when: receivedLabel(message.internalDate),
  };
}

async function listIds(query: string, limit: number) {
  const payload = await gmailCall(`/messages?${new URLSearchParams({
    q: query,
    maxResults: String(limit),
  })}`) as { messages?: MessageReference[] } | null;

  return (payload?.messages ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => Boolean(id))
    .slice(0, limit);
}

async function listMessages(query: string, limit: number) {
  const loaded = await Promise.all((await listIds(query, limit)).map((id) => loadMetadata(id)));
  return loaded.filter((message): message is MailSummary => Boolean(message));
}

/** How many unread messages sit in the inbox, plus the newest few of them. */
export async function inboxOverview(limit: number) {
  const label = await gmailCall("/labels/INBOX") as { messagesUnread?: number } | null;
  const unread = Number.isFinite(label?.messagesUnread) ? Number(label?.messagesUnread) : 0;
  const messages = unread > 0 ? await listMessages("is:unread in:inbox", limit) : [];
  return { unread, messages, description: describeMails(messages) };
}

export async function searchMessages(query: string, limit: number, day = "") {
  const messages = await listMessages(buildSearchQuery(query, day), limit);
  return { query, day, count: messages.length, messages, description: describeMails(messages) };
}

function decodeBody(data: string) {
  return Buffer.from(data.replace(/-/gu, "+").replace(/_/gu, "/"), "base64").toString("utf8");
}

/** Mail arrives as HTML more often than not, and a voice cannot read markup. */
function textFromHtml(html: string) {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)));
}

/** Depth-first search for readable text; plain text always wins over the HTML alternative. */
function readableText(part: MessagePart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBody(part.body.data);
  if (part.parts?.length) {
    for (const child of part.parts) {
      const found = readableText(child);
      if (found) return found;
    }
  }
  if (part.mimeType === "text/html" && part.body?.data) return textFromHtml(decodeBody(part.body.data));
  return "";
}

/**
 * The text of a single message, so the model can summarize it. This is the only place where
 * content written by someone else enters the conversation, so it is trimmed hard and handed
 * over as data; the system prompt forbids treating a tool result as an instruction.
 */
export async function readMessage(query: string, day: string) {
  const [id] = await listIds(buildSearchQuery(query, day), 1);
  if (!id) return null;

  const message = await gmailCall(`/messages/${encodeURIComponent(id)}?format=full`) as MessageMetadata | null;
  if (!message) return null;

  const body = spokenText(readableText(message.payload), MAX_BODY_CHARACTERS);
  return {
    id,
    sender: senderName(header(message, "From")),
    subject: spokenText(header(message, "Subject"), 120),
    when: receivedLabel(message.internalDate),
    body,
  };
}

export type MailChange = "archive" | "trash";

/**
 * Archives or trashes the messages a spoken command matched. Both are reversible: an archived
 * message stays in All Mail, a trashed one stays recoverable for 30 days. Permanent deletion is
 * not reachable from here, and the number of messages one command may touch is capped.
 */
export async function changeMessages(change: MailChange, query: string, day: string) {
  const searchQuery = buildSearchQuery(query, day);
  const ids = await listIds(searchQuery, MAX_AFFECTED_MESSAGES);
  if (!ids.length) return { change, changed: 0, messages: [], description: "" };

  const messages = (await Promise.all(ids.map((id) => loadMetadata(id))))
    .filter((message): message is MailSummary => Boolean(message));

  for (const id of ids) {
    if (change === "trash") {
      await gmailCall(`/messages/${encodeURIComponent(id)}/trash`, "POST");
      continue;
    }
    // Archiving is exactly the removal of the inbox label, nothing else is touched.
    await gmailCall(`/messages/${encodeURIComponent(id)}/modify`, "POST", {
      removeLabelIds: [...REMOVABLE_LABELS].filter((label) => label === "INBOX"),
    });
  }

  return { change, changed: ids.length, messages, description: describeMails(messages) };
}
