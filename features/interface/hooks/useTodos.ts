"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { notifyTodoDue } from "@/features/desktop/notifications";
import {
  clearCompletedTodos,
  createStep,
  createTodo,
  deleteStep,
  deleteTodo,
  loadTodos,
  moveTodo,
  patchTodo,
  sendTodoToCalendar,
  setStepDone,
  setTodoDone,
  type NewTodoInput,
  type TodoPatchInput,
} from "@/features/todos/client";
import { dueSentence } from "@/features/todos/format";
import { moveTodoTo, todoCategories, todoCounts, wallClockNow } from "@/features/todos/ordering";
import { pendingReminders, reminderKey, shiftWallClock } from "@/features/todos/reminders";
import type { TodoCounts, TodoItem } from "@/features/todos/types";

const EMPTY_COUNTS: TodoCounts = { open: 0, overdue: 0, today: 0, done: 0 };
const REMINDER_STORAGE_KEY = "jarvis-todo-reminders-v1";
const REMINDER_INTERVAL_MS = 60_000;
const MAX_REMEMBERED_REMINDERS = 200;
/** Minute-fine urgency without a re-render per second. */
const CLOCK_INTERVAL_MS = 30_000;

function readNotifiedReminders(): string[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(REMINDER_STORAGE_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function storeNotifiedReminders(keys: string[]) {
  try {
    window.localStorage.setItem(REMINDER_STORAGE_KEY, JSON.stringify(keys.slice(-MAX_REMEMBERED_REMINDERS)));
  } catch {
    // A full or blocked storage only costs a repeated reminder, never a lost task.
  }
}

/** Everything the to-do panels need, in the shape the interface passes around. */
export type TodoController = ReturnType<typeof useTodos>;

/**
 * The to-do list as the interface sees it. Every change goes through the local action layer and
 * is read back from there, because the voice assistant writes into the same file.
 */
export function useTodos() {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [now, setNow] = useState(() => wallClockNow());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const notifiedRef = useRef<Set<string>>(new Set());
  /**
   * The action layer's clock runs in the configured time zone, which is the one the spoken
   * answer uses. The panel adopts it and moves it forward itself, so both agree on "today".
   */
  const clockRef = useRef<{ now: string; at: number } | null>(null);
  const currentWallClock = useCallback(() => {
    const anchor = clockRef.current;
    if (!anchor) return wallClockNow();
    return shiftWallClock(anchor.now, Math.round((Date.now() - anchor.at) / 60_000));
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    notifiedRef.current = new Set(readNotifiedReminders());
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const payload = await loadTodos(signal);
      if (!mountedRef.current) return;
      const anchor = { now: payload.now || wallClockNow(), at: Date.now() };
      clockRef.current = anchor;
      setTodos(payload.todos);
      setNow(anchor.now);
      setAvailable(true);
      setError(null);
    } catch (cause) {
      if (!mountedRef.current || signal?.aborted) return;
      // Without the local app there is no list at all; that is a state, not an error to shout about.
      setAvailable(false);
      setError(cause instanceof Error ? cause.message : "Die To-do-Liste ist nicht erreichbar.");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const startup = window.setTimeout(() => void refresh(controller.signal), 0);
    return () => {
      window.clearTimeout(startup);
      controller.abort();
    };
  }, [refresh]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(currentWallClock()), CLOCK_INTERVAL_MS);
    return () => window.clearInterval(clock);
  }, [currentWallClock]);

  /** Runs one change and reads the list back, so panel and assistant never drift apart. */
  const run = useCallback(async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      if (mountedRef.current) {
        setError(cause instanceof Error ? cause.message : "Die Aktion ist fehlgeschlagen.");
      }
    } finally {
      if (mountedRef.current) setBusyId(null);
    }
  }, [refresh]);

  const add = useCallback((input: NewTodoInput) => run("new", () => createTodo(input)), [run]);
  const addStep = useCallback((id: string, title: string) => run(id, () => createStep(id, title)), [run]);
  const toggle = useCallback((todo: TodoItem) => run(todo.id, () => setTodoDone(todo.id, !todo.done)), [run]);
  const toggleStep = useCallback((id: string, stepId: string, done: boolean) => (
    run(id, () => setStepDone(id, stepId, done))
  ), [run]);
  const update = useCallback((id: string, patch: TodoPatchInput) => run(id, () => patchTodo(id, patch)), [run]);
  const remove = useCallback((id: string) => run(id, () => deleteTodo(id)), [run]);
  const removeStep = useCallback((id: string, stepId: string) => run(id, () => deleteStep(id, stepId)), [run]);
  const clearCompleted = useCallback(() => run("completed", () => clearCompletedTodos()), [run]);
  /**
   * A dragged card must sit in its new place the moment it is dropped, so the move is shown
   * first and written afterwards; the read-back then confirms it against the stored list.
   */
  const reorder = useCallback((id: string, targetId: string, place: "before" | "after") => {
    setTodos((current) => moveTodoTo(current, id, targetId, place));
    return run("order", () => moveTodo(id, targetId, place));
  }, [run]);
  const toCalendar = useCallback((id: string) => run(id, () => sendTodoToCalendar(id)), [run]);

  // Deadlines are announced natively; in the browser the check runs and stays silent.
  useEffect(() => {
    if (!todos.length) return;
    const announce = () => {
      const moment = currentWallClock();
      const due = pendingReminders(todos, moment, notifiedRef.current);
      for (const todo of due) {
        notifiedRef.current.add(reminderKey(todo));
        void notifyTodoDue(todo.title, dueSentence(todo.due, moment), todo.due <= moment);
      }
      if (due.length) storeNotifiedReminders([...notifiedRef.current]);
    };
    announce();
    const timer = window.setInterval(announce, REMINDER_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [todos, currentWallClock]);

  const counts = useMemo(() => (todos.length ? todoCounts(todos, now) : EMPTY_COUNTS), [todos, now]);
  const categories = useMemo(() => todoCategories(todos), [todos]);

  return {
    todos,
    counts,
    categories,
    now,
    loading,
    error,
    available,
    busyId,
    refresh: useCallback(() => void refresh(), [refresh]),
    add,
    addStep,
    toggle,
    toggleStep,
    update,
    remove,
    removeStep,
    clearCompleted,
    reorder,
    toCalendar,
    clearError: useCallback(() => setError(null), []),
  };
}
