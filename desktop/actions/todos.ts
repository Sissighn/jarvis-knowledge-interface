/**
 * The to-do list of this Mac. One owner-only JSON file next to the knowledge index is the single
 * source of truth for the panel and for the voice assistant, so a task added by voice and a task
 * added by hand are the same record. Nothing here leaves the device.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dueSentence } from "../../features/todos/format";
import { findTodo, findTodoOrStep } from "../../features/todos/matching";
import { orderTodos, todoCounts, todoUrgency, wallClockNow } from "../../features/todos/ordering";
import type { TodoItem, TodoStep } from "../../features/todos/types";
import { databaseDirectory } from "../indexer/config";
import { localTimeZone } from "./config";
import { LocalActionError } from "./macos";
import { spokenText } from "./text";
import { parseLocalDay } from "./zoned-time";

const FILE_NAME = "todos.json";
const FILE_MODE = 0o600;
const MAX_TODOS = 300;
const MAX_STEPS = 25;
const MAX_TITLE = 160;
const MAX_CATEGORY = 40;
const MAX_SPOKEN_TODOS = 6;

type StoredList = { version: number; todos: TodoItem[] };

/**
 * A time at the end of the sentence, with either explicit minutes or the word "Uhr". Both are
 * required, so a title such as "Kapitel 3" is never mistaken for three o'clock.
 */
const TIME_TAIL = /[\sTt,]+(?:um\s+)?(?:(\d{1,2}):(\d{2})(?:\s*uhr)?|(\d{1,2})\s*uhr)\s*$/iu;

function storePath() {
  return resolve(databaseDirectory(), FILE_NAME);
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function readString(value: unknown, max: number) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, max) : "";
}

function readBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text === "true" || text === "ja" || text === "wichtig" || text === "yes";
}

function readStep(value: unknown): TodoStep | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<TodoStep>;
  const title = readString(entry.title, MAX_TITLE);
  if (!title) return null;
  return { id: typeof entry.id === "string" && entry.id ? entry.id : randomUUID(), title, done: entry.done === true };
}

/** A stored record is user data that a future version may have written differently. */
function readTodo(value: unknown): TodoItem | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<TodoItem>;
  const title = readString(entry.title, MAX_TITLE);
  if (!title) return null;

  const steps = Array.isArray(entry.steps)
    ? entry.steps.map(readStep).filter((step): step is TodoStep => Boolean(step)).slice(0, MAX_STEPS)
    : [];
  return {
    id: typeof entry.id === "string" && entry.id ? entry.id : randomUUID(),
    title,
    category: readString(entry.category, MAX_CATEGORY),
    important: entry.important === true,
    due: normalizeDue(entry.due),
    steps,
    done: entry.done === true,
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
    completedAt: typeof entry.completedAt === "string" ? entry.completedAt : "",
    calendarEventId: readString(entry.calendarEventId, 200),
    calendarLink: readString(entry.calendarLink, 400),
  };
}

/** Keeps a stored due value in the two shapes the ordering understands. */
function normalizeDue(value: unknown) {
  const text = readString(value, 40);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return text;
  return "";
}

export function readTodos(): TodoItem[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath(), "utf8"));
    const list = parsed as Partial<StoredList>;
    if (!Array.isArray(list.todos)) return [];
    return list.todos.map(readTodo).filter((todo): todo is TodoItem => Boolean(todo)).slice(0, MAX_TODOS);
  } catch {
    // No list yet, or a file this version cannot read: an empty list is the safe start.
    return [];
  }
}

/** Written through a temporary file, so an interrupted write cannot truncate the list. */
function writeTodos(todos: TodoItem[]) {
  const directory = databaseDirectory();
  mkdirSync(directory, { recursive: true });
  const target = storePath();
  const temporary = `${target}.tmp`;
  const payload: StoredList = { version: 1, todos: todos.slice(0, MAX_TODOS) };
  writeFileSync(temporary, JSON.stringify(payload, null, 2), { mode: FILE_MODE });
  chmodSync(temporary, FILE_MODE);
  renameSync(temporary, target);
  return payload.todos;
}

export function nowWallClock() {
  return wallClockNow(new Date(), localTimeZone());
}

/**
 * Turns whatever the model or the panel produced into a due value. A date alone stays a date:
 * guessing an hour would invent a deadline the user never named.
 */
export function parseDue(value: unknown, reference = new Date()) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";

  const time = TIME_TAIL.exec(text);
  if (time) {
    const hour = Number(time[1] ?? time[3]);
    const minute = Number(time[2] ?? "0");
    const day = parseLocalDay(text.slice(0, time.index), reference, "future");
    if (day && hour <= 23 && minute <= 59) return `${day}T${pad(hour)}:${pad(minute)}`;
  }
  return parseLocalDay(text, reference, "future");
}

export type NewTodo = {
  title: string;
  due?: unknown;
  category?: unknown;
  important?: unknown;
  steps?: unknown;
};

export function addTodo(input: NewTodo) {
  const title = readString(input.title, MAX_TITLE);
  if (!title) throw new LocalActionError("Für die Aufgabe fehlt noch ein Text.", 400);

  const todos = readTodos();
  if (todos.length >= MAX_TODOS) {
    throw new LocalActionError("Deine To-do-Liste ist voll. Räume zuerst erledigte Aufgaben auf.", 409);
  }

  const steps = (Array.isArray(input.steps) ? input.steps : [])
    .map((entry) => readString(entry, MAX_TITLE))
    .filter(Boolean)
    .slice(0, MAX_STEPS)
    .map((stepTitle) => ({ id: randomUUID(), title: stepTitle, done: false }));

  const todo: TodoItem = {
    id: randomUUID(),
    title,
    category: readString(input.category, MAX_CATEGORY),
    important: readBoolean(input.important),
    due: parseDue(input.due),
    steps,
    done: false,
    createdAt: new Date().toISOString(),
    completedAt: "",
    calendarEventId: "",
    calendarLink: "",
  };
  writeTodos([...todos, todo]);
  return todo;
}

/** Resolves the to-do a spoken sentence names, or explains that it was not found. */
export function resolveTodo(query: string, todos = readTodos()) {
  const wanted = readString(query, MAX_TITLE);
  if (!wanted) throw new LocalActionError("Ich weiß nicht, welche Aufgabe du meinst.", 400);
  const todo = findTodo(todos, wanted);
  if (!todo) throw new LocalActionError(`Ich habe keine Aufgabe zu „${wanted}“ gefunden.`, 404);
  return todo;
}

function requireTodo(todos: TodoItem[], id: string, query: string) {
  const byId = id ? todos.find((todo) => todo.id === id) ?? null : null;
  return byId ?? resolveTodo(query, todos);
}

/** The to-do a request means: by id when the panel asks, by spoken text when the assistant does. */
export function getTodo(id: string, query: string, todos = readTodos()) {
  return requireTodo(todos, id, query);
}

export function addStep(id: string, query: string, title: string) {
  const stepTitle = readString(title, MAX_TITLE);
  if (!stepTitle) throw new LocalActionError("Für den Unterpunkt fehlt noch ein Text.", 400);

  const todos = readTodos();
  const todo = requireTodo(todos, id, query);
  if (todo.steps.length >= MAX_STEPS) {
    throw new LocalActionError(`„${todo.title}“ hat schon die maximale Anzahl an Unterpunkten.`, 409);
  }

  const step: TodoStep = { id: randomUUID(), title: stepTitle, done: false };
  const updated: TodoItem = { ...todo, steps: [...todo.steps, step], done: false, completedAt: "" };
  writeTodos(todos.map((entry) => (entry.id === todo.id ? updated : entry)));
  return { todo: updated, step };
}

/**
 * Checking a to-do off also finishes its open sub-tasks: a trip that is planned cannot leave
 * "book the flight" hanging. Checking off a single step never closes the parent by itself.
 */
export function setDone(id: string, query: string, done: boolean, stepQuery = "", stepId = "") {
  const todos = readTodos();
  const wanted = stepQuery || query;
  const match = id
    ? { todo: requireTodo(todos, id, query), step: null as TodoStep | null }
    : findTodoOrStep(todos, wanted) ?? { todo: resolveTodo(query, todos), step: null as TodoStep | null };

  const todo = match.todo;
  const step = stepId
    ? todo.steps.find((entry) => entry.id === stepId) ?? null
    : stepQuery
      ? match.step ?? findTodoOrStep([todo], stepQuery)?.step ?? null
      : match.step;

  if ((stepId || stepQuery) && !step) {
    throw new LocalActionError(`Bei „${todo.title}“ gibt es dazu keinen Unterpunkt.`, 404);
  }

  const updated: TodoItem = step
    ? {
      ...todo,
      steps: todo.steps.map((entry) => (entry.id === step.id ? { ...entry, done } : entry)),
      ...(done ? {} : { done: false, completedAt: "" }),
    }
    : {
      ...todo,
      done,
      completedAt: done ? new Date().toISOString() : "",
      steps: done ? todo.steps.map((entry) => ({ ...entry, done: true })) : todo.steps,
    };

  writeTodos(todos.map((entry) => (entry.id === todo.id ? updated : entry)));
  return { todo: updated, step: step ? { ...step, done } : null };
}

export type TodoPatch = {
  title?: unknown;
  due?: unknown;
  category?: unknown;
  important?: unknown;
};

export function updateTodo(id: string, query: string, patch: TodoPatch) {
  const todos = readTodos();
  const todo = requireTodo(todos, id, query);
  const title = patch.title === undefined ? todo.title : readString(patch.title, MAX_TITLE) || todo.title;
  const due = patch.due === undefined ? todo.due : parseDue(patch.due);
  const updated: TodoItem = {
    ...todo,
    title,
    due,
    category: patch.category === undefined ? todo.category : readString(patch.category, MAX_CATEGORY),
    important: patch.important === undefined ? todo.important : readBoolean(patch.important),
    // A moved deadline is a different appointment, so the calendar link no longer describes it.
    ...(due === todo.due ? {} : { calendarEventId: "", calendarLink: "" }),
  };
  writeTodos(todos.map((entry) => (entry.id === todo.id ? updated : entry)));
  return updated;
}

export function removeTodo(id: string, query: string) {
  const todos = readTodos();
  const todo = requireTodo(todos, id, query);
  writeTodos(todos.filter((entry) => entry.id !== todo.id));
  return todo;
}

export function removeStep(id: string, stepId: string) {
  const todos = readTodos();
  const todo = requireTodo(todos, id, "");
  const step = todo.steps.find((entry) => entry.id === stepId);
  if (!step) throw new LocalActionError("Diesen Unterpunkt gibt es nicht.", 404);
  const updated: TodoItem = { ...todo, steps: todo.steps.filter((entry) => entry.id !== stepId) };
  writeTodos(todos.map((entry) => (entry.id === todo.id ? updated : entry)));
  return { todo: updated, step };
}

export function clearCompleted() {
  const todos = readTodos();
  const remaining = todos.filter((todo) => !todo.done);
  writeTodos(remaining);
  return todos.length - remaining.length;
}

export function linkCalendarEvent(id: string, eventId: string, link: string) {
  const todos = readTodos();
  const todo = requireTodo(todos, id, "");
  const updated: TodoItem = {
    ...todo,
    calendarEventId: readString(eventId, 200),
    calendarLink: readString(link, 400),
  };
  writeTodos(todos.map((entry) => (entry.id === todo.id ? updated : entry)));
  return updated;
}

/** The spoken form of a deadline: a person says "morgen um 15 Uhr", not an ISO timestamp. */
export function spokenDue(due: string, now = nowWallClock()) {
  return dueSentence(due, now);
}

function describeSteps(todo: TodoItem) {
  const open = todo.steps.filter((step) => !step.done);
  if (!open.length) return "";
  const names = open.slice(0, 3).map((step) => spokenText(step.title, MAX_TITLE));
  const remaining = open.length - names.length;
  return ` mit den offenen Unterpunkten ${names.join(", ")}${remaining ? ` und ${remaining} weiteren` : ""}`;
}

export function describeTodo(todo: TodoItem, now = nowWallClock(), withSteps = false) {
  const urgency = todoUrgency(todo, now);
  const when = spokenDue(todo.due, now);
  const marker = todo.important ? "wichtig, " : "";
  const category = todo.category ? `, Kategorie ${spokenText(todo.category, MAX_CATEGORY)}` : "";
  // "seit am 1. März" is not a sentence; a missed date takes the dative instead.
  const timing = urgency === "overdue"
    ? `, überfällig seit ${when.replace(/^am /u, "dem ")}`
    : when ? `, fällig ${when}` : "";
  return `${marker}${spokenText(todo.title, MAX_TITLE)}${timing}${category}${withSteps ? describeSteps(todo) : ""}`;
}

/** The whole list as one spoken paragraph, ordered exactly like the panel shows it. */
export function describeTodos(todos: TodoItem[], now = nowWallClock()) {
  const ordered = orderTodos(todos, now);
  if (!ordered.length) return "";
  const spoken = ordered.slice(0, MAX_SPOKEN_TODOS).map((todo, index) => `${index + 1}. ${describeTodo(todo, now)}`);
  const remaining = ordered.length - spoken.length;
  return `${spoken.join(". ")}${remaining ? `. Dazu kommen ${remaining} weitere Aufgaben` : ""}`;
}

export function todoOverview(todos = readTodos(), now = nowWallClock()) {
  return { counts: todoCounts(todos, now), now };
}
