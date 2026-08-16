/**
 * Browser bridge to the to-do list. It talks to the same local action layer the voice assistant
 * uses, so a task added by hand and a task added by voice are one record, not two lists.
 */
import type { CalendarEntry, TodoItem, TodoListPayload } from "./types";

const LOCAL_ACTION_BASE = "/api/local";

type ActionResponse = { error?: string; code?: string };

async function post<T>(path: string, body: Record<string, unknown> = {}, signal?: AbortSignal) {
  const response = await fetch(`${LOCAL_ACTION_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const payload = await response.json().catch(() => ({})) as T & ActionResponse;
  if (!response.ok) {
    throw new Error(payload.error || "Die To-do-Liste ist gerade nicht erreichbar.");
  }
  return payload;
}

export type TodoFilter = "open" | "today" | "overdue" | "done" | "all";

export async function loadTodos(signal?: AbortSignal) {
  return post<TodoListPayload>("/todos/list", { filter: "all" }, signal);
}

export type NewTodoInput = {
  title: string;
  due?: string;
  category?: string;
  important?: boolean;
};

export async function createTodo(input: NewTodoInput, signal?: AbortSignal) {
  return post<{ todo: TodoItem }>("/todos/add", { ...input }, signal);
}

export async function createStep(id: string, title: string, signal?: AbortSignal) {
  return post<{ todo: TodoItem }>("/todos/add-step", { id, title }, signal);
}

export async function setTodoDone(id: string, done: boolean, signal?: AbortSignal) {
  return post<{ todo: TodoItem }>(done ? "/todos/complete" : "/todos/reopen", { id }, signal);
}

export async function setStepDone(id: string, stepId: string, done: boolean, signal?: AbortSignal) {
  return post<{ todo: TodoItem }>(done ? "/todos/complete" : "/todos/reopen", { id, stepId }, signal);
}

/**
 * A change to one field of an existing to-do. `due: null` is the one way to drop a deadline on
 * purpose; the action layer rejects an unreadable date instead of quietly clearing it.
 */
export type TodoPatchInput = Omit<Partial<NewTodoInput>, "due"> & { due?: string | null };

export async function patchTodo(id: string, patch: TodoPatchInput, signal?: AbortSignal) {
  return post<{ todo: TodoItem }>("/todos/update", { id, ...patch }, signal);
}

/** The click on the second, explicit delete button is the confirmation the action layer demands. */
export async function deleteTodo(id: string, signal?: AbortSignal) {
  return post<{ todo: TodoItem }>("/todos/remove", { id, confirmed: true }, signal);
}

export async function deleteStep(id: string, stepId: string, signal?: AbortSignal) {
  return post<{ todo: TodoItem }>("/todos/remove-step", { id, stepId }, signal);
}

export async function clearCompletedTodos(signal?: AbortSignal) {
  return post<{ cleared: number }>("/todos/clear-completed", { confirmed: true }, signal);
}

export async function sendTodoToCalendar(id: string, signal?: AbortSignal) {
  return post<{ todo: TodoItem; description: string }>("/todos/calendar", { id, confirmed: true }, signal);
}

/** Google Calendar entries for the visible month; an unconnected account is an empty month. */
export async function loadCalendarRange(from: string, until: string, signal?: AbortSignal) {
  const payload = await post<{ connected: boolean; events: Array<Omit<CalendarEntry, "source" | "overdue">> }>(
    "/calendar/range",
    { from, until },
    signal,
  );
  return {
    connected: payload.connected,
    events: payload.events.map((event): CalendarEntry => ({ ...event, source: "google", overdue: false })),
  };
}
