"use client";

import { FormEvent, useMemo, useState } from "react";
import { dueBadge, dayTitle } from "@/features/todos/format";
import { orderTodos, stepProgress, todoUrgency } from "@/features/todos/ordering";
import type { TodoItem, TodoUrgency } from "@/features/todos/types";
import type { TodoController } from "../hooks/useTodos";

type TodoBoardProps = {
  visible: boolean;
  todos: TodoController;
  /** The day picked in the month, which filters the list and prefills a new task. */
  selectedDay: string;
  onSelectDay(day: string): void;
};

type Scope = "all" | "today" | "overdue";

const GROUPS: Array<{ urgency: TodoUrgency; label: string }> = [
  { urgency: "overdue", label: "ÜBERFÄLLIG" },
  { urgency: "today", label: "HEUTE" },
  { urgency: "upcoming", label: "GEPLANT" },
  { urgency: "someday", label: "OHNE DATUM" },
];

/**
 * The two inputs of the compose row become the one due value the action layer stores. A time
 * without a day means today; a day without a time stays a whole day and never invents an hour.
 */
function composedDue(day: string, time: string, now: string) {
  const target = day || (time ? now.slice(0, 10) : "");
  if (!target) return "";
  return time ? `${target}T${time}` : target;
}

export function TodoBoard({ visible, todos, selectedDay, onSelectDay }: TodoBoardProps) {
  const [title, setTitle] = useState("");
  const [day, setDay] = useState("");
  const [time, setTime] = useState("");
  const [category, setCategory] = useState("");
  const [important, setImportant] = useState(false);
  const [scope, setScope] = useState<Scope>("all");
  const [activeCategory, setActiveCategory] = useState("");
  const [openId, setOpenId] = useState("");
  const [stepDraft, setStepDraft] = useState("");
  const [confirmingId, setConfirmingId] = useState("");
  const [showDone, setShowDone] = useState(false);

  const { counts, now, busyId } = todos;
  const composeDay = day || selectedDay;

  const visibleTodos = useMemo(() => {
    const scoped = todos.todos.filter((todo) => {
      if (activeCategory && todo.category !== activeCategory) return false;
      if (selectedDay && todo.due.slice(0, 10) !== selectedDay) return false;
      if (scope === "all") return true;
      const urgency = todoUrgency(todo, now);
      if (scope === "overdue") return urgency === "overdue";
      return urgency === "today" || urgency === "overdue";
    });
    return orderTodos(scoped, now);
  }, [todos.todos, activeCategory, selectedDay, scope, now]);

  const groups = GROUPS.map((group) => ({
    ...group,
    items: visibleTodos.filter((todo) => todoUrgency(todo, now) === group.urgency),
  })).filter((group) => group.items.length);
  const doneItems = visibleTodos.filter((todo) => todo.done);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = title.trim();
    if (!text) return;
    void todos.add({ title: text, due: composedDue(composeDay, time, now), category: category.trim(), important });
    setTitle("");
    setTime("");
    setImportant(false);
    // The category survives for the next task; an inherited deadline would only invent one.
    setDay("");
  };

  const submitStep = (event: FormEvent, todo: TodoItem) => {
    event.preventDefault();
    const text = stepDraft.trim();
    if (!text) return;
    void todos.addStep(todo.id, text);
    setStepDraft("");
  };

  const renderTodo = (todo: TodoItem) => {
    const urgency = todoUrgency(todo, now);
    const progress = stepProgress(todo);
    const open = openId === todo.id;
    const busy = busyId === todo.id;

    return (
      <article
        className={`todo-card ${todo.done ? "is-done" : ""} ${urgency === "overdue" ? "is-overdue" : ""} ${todo.important ? "is-important" : ""}`}
        key={todo.id}
      >
        <div className="todo-line">
          <button
            className="todo-check"
            type="button"
            aria-pressed={todo.done}
            aria-label={`${todo.title} ${todo.done ? "wieder öffnen" : "abhaken"}`}
            disabled={busy}
            onClick={() => void todos.toggle(todo)}
          >
            ✓
          </button>
          <div className="todo-body">
            <button
              className="todo-title"
              type="button"
              aria-expanded={open}
              onClick={() => {
                setOpenId(open ? "" : todo.id);
                setStepDraft("");
                setConfirmingId("");
              }}
            >
              {todo.title}
            </button>
            <div className="todo-meta">
              {todo.important ? <span className="todo-important-mark" title="Wichtig">★</span> : null}
              {todo.due ? (
                <span className={`todo-due ${urgency === "overdue" ? "is-overdue" : urgency === "today" ? "is-today" : ""}`}>
                  {urgency === "overdue" ? "ÜBERFÄLLIG · " : ""}{dueBadge(todo.due, now)}
                </span>
              ) : null}
              {todo.category ? <span className="todo-tag">{todo.category}</span> : null}
              {progress.total ? <span className="todo-step-count">{progress.done}/{progress.total}</span> : null}
              {todo.calendarEventId ? <span className="todo-step-count">KALENDER ✓</span> : null}
            </div>
          </div>
        </div>

        {open ? (
          <div className="todo-detail">
            {todo.steps.length ? (
              <ul className="todo-steps">
                {todo.steps.map((step) => (
                  <li className={step.done ? "is-done" : ""} key={step.id}>
                    <button
                      className="todo-check"
                      type="button"
                      aria-pressed={step.done}
                      aria-label={`${step.title} ${step.done ? "wieder öffnen" : "abhaken"}`}
                      disabled={busy}
                      onClick={() => void todos.toggleStep(todo.id, step.id, !step.done)}
                    >
                      ✓
                    </button>
                    <span>{step.title}</span>
                    <button
                      className="todo-step-remove"
                      type="button"
                      aria-label={`${step.title} entfernen`}
                      disabled={busy}
                      onClick={() => void todos.removeStep(todo.id, step.id)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <form className="todo-step-form" onSubmit={(event) => submitStep(event, todo)}>
              <input
                value={stepDraft}
                placeholder="Unterpunkt hinzufügen …"
                aria-label={`Unterpunkt für ${todo.title}`}
                onChange={(event) => setStepDraft(event.target.value)}
              />
              <button type="submit" disabled={busy || !stepDraft.trim()} aria-label="Unterpunkt speichern">+</button>
            </form>

            <div className="todo-actions">
              <button
                type="button"
                className={todo.important ? "is-active" : ""}
                disabled={busy}
                onClick={() => void todos.update(todo.id, { important: !todo.important })}
              >
                {todo.important ? "WICHTIG ✓" : "WICHTIG"}
              </button>
              <button
                type="button"
                className={todo.calendarEventId ? "is-active" : ""}
                disabled={busy || !todo.due || Boolean(todo.calendarEventId)}
                title={todo.due ? undefined : "Diese Aufgabe hat kein Datum"}
                onClick={() => void todos.toCalendar(todo.id)}
              >
                {todo.calendarEventId ? "IM KALENDER ✓" : "IN KALENDER"}
              </button>
              <button
                type="button"
                className={`is-danger ${confirmingId === todo.id ? "is-confirming" : ""}`}
                disabled={busy}
                onClick={() => {
                  if (confirmingId !== todo.id) {
                    setConfirmingId(todo.id);
                    return;
                  }
                  setConfirmingId("");
                  void todos.remove(todo.id);
                }}
              >
                {confirmingId === todo.id ? "WIRKLICH LÖSCHEN?" : "LÖSCHEN"}
              </button>
            </div>
          </div>
        ) : null}
      </article>
    );
  };

  return (
    <aside className={`todo-panel ${visible ? "is-visible" : ""}`} aria-label="To-do-Liste">
      <header className="todo-header">
        <div>
          <span className="eyebrow">TO-DO</span>
          <h2>{counts.open} {counts.open === 1 ? "Aufgabe" : "Aufgaben"}</h2>
        </div>
        <span className={`todo-counter ${counts.overdue ? "is-alert" : ""}`}>
          {counts.overdue ? `${counts.overdue} ÜBERFÄLLIG` : `${counts.today} HEUTE`}
          <br />
          {counts.done} ERLEDIGT
        </span>
      </header>

      <form className="todo-compose" onSubmit={submit}>
        <div className="todo-compose-line">
          <input
            value={title}
            placeholder="Neue Aufgabe …"
            aria-label="Neue Aufgabe"
            maxLength={160}
            onChange={(event) => setTitle(event.target.value)}
          />
          <button className="todo-add" type="submit" disabled={!title.trim() || busyId === "new"} aria-label="Aufgabe hinzufügen">
            +
          </button>
        </div>
        <div className="todo-compose-row">
          <input
            type="date"
            value={composeDay}
            aria-label="Fällig am"
            onChange={(event) => {
              setDay(event.target.value);
              if (selectedDay) onSelectDay("");
            }}
          />
          <input type="time" value={time} aria-label="Uhrzeit" onChange={(event) => setTime(event.target.value)} />
          <input
            value={category}
            placeholder="Kategorie"
            aria-label="Kategorie"
            maxLength={40}
            onChange={(event) => setCategory(event.target.value)}
          />
          <button
            type="button"
            className={`todo-flag ${important ? "is-active" : ""}`}
            aria-pressed={important}
            aria-label="Als wichtig markieren"
            onClick={() => setImportant((current) => !current)}
          >
            ★
          </button>
        </div>
      </form>

      <div className="todo-filters">
        <button type="button" className={scope === "all" && !selectedDay ? "is-active" : ""} onClick={() => { setScope("all"); onSelectDay(""); }}>
          ALLE
        </button>
        <button type="button" className={scope === "today" ? "is-active" : ""} onClick={() => setScope("today")}>HEUTE</button>
        <button
          type="button"
          className={`is-alert ${scope === "overdue" ? "is-active" : ""}`}
          onClick={() => setScope("overdue")}
        >
          ÜBERFÄLLIG {counts.overdue ? `· ${counts.overdue}` : ""}
        </button>
        {todos.categories.map((entry) => (
          <button
            key={entry}
            type="button"
            className={activeCategory === entry ? "is-active" : ""}
            onClick={() => setActiveCategory(activeCategory === entry ? "" : entry)}
          >
            {entry.toUpperCase()}
          </button>
        ))}
        {selectedDay ? (
          <button type="button" className="is-active" onClick={() => onSelectDay("")}>
            {dayTitle(selectedDay).toUpperCase()} ×
          </button>
        ) : null}
      </div>

      {todos.error ? (
        <p className="todo-error" role="alert">
          <span>{todos.error}</span>
          <button type="button" onClick={todos.clearError} aria-label="Meldung schließen">×</button>
        </p>
      ) : null}

      <div className="todo-list">
        {!todos.available ? (
          <div className="todo-notice">
            <p>Die To-do-Liste lebt auf diesem Mac und ist nur in der lokalen JARVIS-App verfügbar.</p>
          </div>
        ) : null}

        {todos.available && !todos.loading && !visibleTodos.length ? (
          <div className="todo-empty">
            <strong>Nichts offen.</strong>
            <p>Sag „Jarvis, füg zu meiner To-do-Liste hinzu, dass ich einen Urlaub planen muss“ — oder tippe es oben ein.</p>
          </div>
        ) : null}

        {groups.map((group) => (
          <section className="todo-group" key={group.urgency} aria-label={group.label}>
            <span className={`todo-group-label ${group.urgency === "overdue" ? "is-alert" : ""}`}>
              {group.label} <b>{group.items.length}</b>
            </span>
            {group.items.map(renderTodo)}
          </section>
        ))}

        {doneItems.length ? (
          <section className="todo-group" aria-label="Erledigt">
            <button className="todo-group-label" type="button" aria-expanded={showDone} onClick={() => setShowDone((current) => !current)}>
              ERLEDIGT <b>{showDone ? "▾" : "▸"} {doneItems.length}</b>
            </button>
            {showDone ? doneItems.map(renderTodo) : null}
            {showDone ? (
              <div className="todo-actions">
                <button
                  type="button"
                  className={`is-danger ${confirmingId === "completed" ? "is-confirming" : ""}`}
                  disabled={busyId === "completed"}
                  onClick={() => {
                    if (confirmingId !== "completed") {
                      setConfirmingId("completed");
                      return;
                    }
                    setConfirmingId("");
                    void todos.clearCompleted();
                  }}
                >
                  {confirmingId === "completed" ? "WIRKLICH AUFRÄUMEN?" : "ERLEDIGTE AUFRÄUMEN"}
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
