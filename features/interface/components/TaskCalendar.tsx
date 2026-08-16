"use client";

import { useEffect, useMemo, useState } from "react";
import { loadCalendarRange } from "@/features/todos/client";
import { dayTitle, monthGrid, monthTitle } from "@/features/todos/format";
import { todoUrgency } from "@/features/todos/ordering";
import type { CalendarEntry, TodoItem } from "@/features/todos/types";

type TaskCalendarProps = {
  visible: boolean;
  todos: TodoItem[];
  /** The action layer's wall clock, so "today" means the same here as in the list. */
  now: string;
  selectedDay: string;
  onSelectDay(day: string): void;
};

const WEEKDAY_LABELS = ["MO", "DI", "MI", "DO", "FR", "SA", "SO"];
const MAX_DOTS = 3;

function monthOf(day: string) {
  const [year, month] = day.split("-").map(Number);
  return { year, month };
}

function shiftMonth(year: number, month: number, delta: number) {
  const moved = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1 };
}

/** The month is shown as one list of entries, so a deadline and an appointment read alike. */
function todoEntries(todos: TodoItem[], now: string): CalendarEntry[] {
  return todos
    .filter((todo) => todo.due)
    .map((todo) => ({
      id: todo.id,
      title: todo.title,
      day: todo.due.slice(0, 10),
      time: todo.due.length >= 16 ? todo.due.slice(11, 16) : "",
      source: "todo" as const,
      overdue: todoUrgency(todo, now) === "overdue",
      link: "",
    }));
}

export function TaskCalendar({ visible, todos, now, selectedDay, onSelectDay }: TaskCalendarProps) {
  const today = now.slice(0, 10);
  const [view, setView] = useState(() => monthOf(today));
  const [events, setEvents] = useState<CalendarEntry[]>([]);
  const [connected, setConnected] = useState(false);

  const days = useMemo(() => monthGrid(view.year, view.month), [view]);
  const monthPrefix = `${String(view.year).padStart(4, "0")}-${String(view.month).padStart(2, "0")}`;

  // A to-do that was just written into the calendar has to show up as an appointment too.
  const linkedCount = useMemo(() => todos.filter((todo) => todo.calendarEventId).length, [todos]);

  // The visible weeks reach into the neighbouring months, so the query follows the grid.
  useEffect(() => {
    if (!visible || !days.length) return;
    const controller = new AbortController();
    void loadCalendarRange(days[0], days[days.length - 1], controller.signal)
      .then((payload) => {
        setConnected(payload.connected);
        setEvents(payload.events);
      })
      .catch(() => {
        // No Google account and no local app both mean the same thing here: only to-dos.
        setConnected(false);
        setEvents([]);
      });
    return () => controller.abort();
  }, [visible, days, linkedCount]);

  const entries = useMemo(() => [...todoEntries(todos, now), ...events], [todos, now, events]);
  const byDay = useMemo(() => {
    const groups = new Map<string, CalendarEntry[]>();
    for (const entry of entries) {
      const list = groups.get(entry.day) ?? [];
      list.push(entry);
      groups.set(entry.day, list);
    }
    for (const list of groups.values()) {
      list.sort((left, right) => (left.time || "99:99").localeCompare(right.time || "99:99"));
    }
    return groups;
  }, [entries]);

  const detailDay = selectedDay || today;
  const detailEntries = byDay.get(detailDay) ?? [];

  return (
    <aside className={`task-calendar ${visible ? "is-visible" : ""}`} aria-label="Kalender">
      <header className="calendar-header">
        <div>
          <span className="eyebrow">KALENDER</span>
          <h2>{monthTitle(view.year, view.month)}</h2>
        </div>
        <div className="calendar-nav">
          <button type="button" aria-label="Vorheriger Monat" onClick={() => setView(shiftMonth(view.year, view.month, -1))}>←</button>
          <button
            type="button"
            className="calendar-today"
            onClick={() => {
              setView(monthOf(today));
              onSelectDay(today);
            }}
          >
            HEUTE
          </button>
          <button type="button" aria-label="Nächster Monat" onClick={() => setView(shiftMonth(view.year, view.month, 1))}>→</button>
        </div>
      </header>

      <div className="calendar-weekdays" aria-hidden="true">
        {WEEKDAY_LABELS.map((label) => <span key={label}>{label}</span>)}
      </div>

      <div className="calendar-grid" aria-label={`Monat ${monthTitle(view.year, view.month)}`}>
        {days.map((day) => {
          const dayEntries = byDay.get(day) ?? [];
          const outside = !day.startsWith(monthPrefix);
          return (
            <button
              type="button"
              key={day}
              className={`calendar-day ${outside ? "is-outside" : ""} ${day === today ? "is-today" : ""} ${day === selectedDay ? "is-selected" : ""}`}
              aria-label={`${dayTitle(day)}${dayEntries.length ? `, ${dayEntries.length} Einträge` : ""}`}
              aria-pressed={day === selectedDay}
              onClick={() => onSelectDay(day === selectedDay ? "" : day)}
            >
              <span>{Number(day.slice(8))}</span>
              <span className="calendar-dots" aria-hidden="true">
                {dayEntries.slice(0, MAX_DOTS).map((entry) => (
                  <i
                    key={`${entry.source}-${entry.id}`}
                    className={`calendar-dot ${entry.overdue ? "is-overdue" : ""} ${entry.source === "google" ? "is-google" : ""}`}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>

      <div className="calendar-detail" aria-live="polite">
        <h3>{dayTitle(detailDay)}{detailDay === today ? " · HEUTE" : ""}</h3>
        {detailEntries.length ? detailEntries.map((entry) => (
          <div
            className={`calendar-entry ${entry.overdue ? "is-overdue" : ""} ${entry.source === "google" ? "is-google" : ""}`}
            key={`${entry.source}-${entry.id}`}
          >
            <b>{entry.time || (entry.source === "google" ? "GANZTAG" : "TAG")}</b>
            <span>{entry.title}</span>
          </div>
        )) : <p className="calendar-empty">Nichts geplant.</p>}
        <p className="calendar-hint">
          {connected
            ? "AUFGABEN UND GOOGLE-TERMINE · TAG WÄHLEN FILTERT DIE LISTE"
            : "NUR AUFGABEN · GOOGLE-KONTO IM SPRACHPANEL VERBINDEN"}
        </p>
      </div>
    </aside>
  );
}
