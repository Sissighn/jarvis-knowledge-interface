/** Shared contracts for the local to-do list. Nothing here depends on network or UI code. */

export type TodoStep = {
  id: string;
  title: string;
  done: boolean;
};

export type TodoItem = {
  id: string;
  title: string;
  /** Empty when the to-do belongs to no category. */
  category: string;
  important: boolean;
  /**
   * Local wall clock as `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`. A to-do without a due date never
   * expires and simply stays in the list until it is checked off.
   */
  due: string;
  steps: TodoStep[];
  done: boolean;
  createdAt: string;
  /** Empty while the to-do is open. */
  completedAt: string;
  /** Set once this to-do was written into Google Calendar, so it is not entered twice. */
  calendarEventId: string;
  calendarLink: string;
};

/**
 * Where a to-do stands right now. `overdue` is the only state that is shown in red and sorted
 * above everything else; `someday` is a to-do without a date, which can never become overdue.
 */
export type TodoUrgency = "overdue" | "today" | "upcoming" | "someday" | "done";

export type TodoCounts = {
  open: number;
  overdue: number;
  today: number;
  done: number;
};

export type TodoListPayload = {
  todos: TodoItem[];
  counts: TodoCounts;
  /** The action layer's own wall clock, so the panel agrees with the spoken answer. */
  now: string;
  summary: string;
};

/** One entry of the calendar month, either a to-do deadline or a Google Calendar event. */
export type CalendarEntry = {
  id: string;
  title: string;
  day: string;
  /** Empty for all-day entries and for to-dos that only carry a date. */
  time: string;
  source: "todo" | "google";
  overdue: boolean;
  link: string;
};
