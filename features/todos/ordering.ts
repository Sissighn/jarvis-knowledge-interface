/**
 * Where a to-do belongs in the list. The rule the panel and the spoken answer share: a missed
 * deadline is the only thing that climbs to the top, a to-do without a date never becomes late,
 * and finished work leaves the open list without being deleted.
 */
import type { TodoCounts, TodoItem, TodoUrgency } from "./types";

const URGENCY_RANK: Record<TodoUrgency, number> = {
  overdue: 0,
  today: 1,
  upcoming: 2,
  someday: 3,
  done: 4,
};

/** The calendar day of a due value, or `""` when the to-do has no date at all. */
export function dueDay(due: string) {
  return due.slice(0, 10);
}

/** The wall-clock time of a due value, or `""` when only a day was given. */
export function dueTime(due: string) {
  return due.length >= 16 ? due.slice(11, 16) : "";
}

/**
 * The current local wall clock as `YYYY-MM-DDTHH:MM`, in the same shape a due date has, so the
 * two can be compared as plain strings. Built from numeric parts because the packaged runtime
 * ships no German locale data.
 */
export function wallClockNow(date = new Date(), timeZone?: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
}

/**
 * A to-do with a time is late the minute that time passes; a to-do that only names a day stays
 * due for the whole day and turns red the next morning.
 */
export function todoUrgency(todo: TodoItem, now: string): TodoUrgency {
  if (todo.done) return "done";
  if (!todo.due) return "someday";
  const today = now.slice(0, 10);
  const day = dueDay(todo.due);
  if (day < today) return "overdue";
  if (day > today) return "upcoming";
  return dueTime(todo.due) && todo.due < now ? "overdue" : "today";
}

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Overdue first, then the remaining dated work in calendar order, then everything without a
 * date. Only inside a group does the important flag win, because a marked to-do must never
 * push a deadline that is actually running out out of sight.
 */
export function orderTodos(todos: TodoItem[], now: string) {
  return [...todos].sort((left, right) => {
    const leftUrgency = todoUrgency(left, now);
    const rightUrgency = todoUrgency(right, now);
    if (leftUrgency !== rightUrgency) return URGENCY_RANK[leftUrgency] - URGENCY_RANK[rightUrgency];

    // Finished work is a history, so the most recently checked off entry stays on top.
    if (leftUrgency === "done") return compareStrings(right.completedAt, left.completedAt);

    if (leftUrgency === "someday") {
      if (left.important !== right.important) return left.important ? -1 : 1;
      return compareStrings(right.createdAt, left.createdAt);
    }

    if (left.due !== right.due) return compareStrings(left.due, right.due);
    if (left.important !== right.important) return left.important ? -1 : 1;
    return compareStrings(left.createdAt, right.createdAt);
  });
}

export function openTodos(todos: TodoItem[]) {
  return todos.filter((todo) => !todo.done);
}

export function todoCounts(todos: TodoItem[], now: string): TodoCounts {
  const counts: TodoCounts = { open: 0, overdue: 0, today: 0, done: 0 };
  for (const todo of todos) {
    const urgency = todoUrgency(todo, now);
    if (urgency === "done") {
      counts.done += 1;
      continue;
    }
    counts.open += 1;
    if (urgency === "overdue") counts.overdue += 1;
    if (urgency === "today") counts.today += 1;
  }
  return counts;
}

/** The categories in use, most-used first, so the panel can group without a second source. */
export function todoCategories(todos: TodoItem[]) {
  const counts = new Map<string, number>();
  for (const todo of openTodos(todos)) {
    if (!todo.category) continue;
    counts.set(todo.category, (counts.get(todo.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || compareStrings(left[0], right[0]))
    .map(([category]) => category);
}

export function stepProgress(todo: TodoItem) {
  return { done: todo.steps.filter((step) => step.done).length, total: todo.steps.length };
}
