"use client";

import { useState } from "react";
import type { DailyTechVocabulary } from "@/features/glossary/types";

type TechVocabularyCarouselProps = {
  vocabulary?: DailyTechVocabulary;
  notionConnected: boolean;
  savedTermIds: string[];
  savingTermId: string | null;
  saveError: string | null;
  onSave(termId: string): void;
};

export function TechVocabularyCarousel({
  vocabulary,
  notionConnected,
  savedTermIds,
  savingTermId,
  saveError,
  onSave,
}: TechVocabularyCarouselProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const terms = vocabulary?.terms ?? [];

  if (!terms.length) return null;
  const activeTerm = terms[activeIndex % terms.length];
  const saved = savedTermIds.includes(activeTerm.id);
  const saving = savingTermId === activeTerm.id;

  const move = (direction: -1 | 1) => {
    setActiveIndex((current) => (current + direction + terms.length) % terms.length);
  };

  return (
    <section
      className="vocabulary-carousel"
      aria-label="Fünf Tech-Begriffe des Tages"
      aria-roledescription="Karussell"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") move(-1);
        if (event.key === "ArrowRight") move(1);
      }}
    >
      <header className="vocabulary-header">
        <span className="briefing-section-label">TECH VOCABULARY</span>
        <span className="vocabulary-counter">{activeIndex + 1} / {terms.length}</span>
      </header>

      <article className="vocabulary-slide" key={activeTerm.id} aria-live="polite">
        <div className="vocabulary-meta">
          <span>{activeTerm.category}</span>
        </div>
        <h3>{activeTerm.term}</h3>
        <p className="vocabulary-definition">{activeTerm.definition}</p>

        <dl className="vocabulary-details">
          <div><dt>WOFÜR?</dt><dd>{activeTerm.purpose}</dd></div>
          <div><dt>PROFESSIONELL</dt><dd>{activeTerm.professionalExample}</dd></div>
          <div><dt>ALLTAG</dt><dd>{activeTerm.everydayExample}</dd></div>
          <div><dt>IM GESPRÄCH</dt><dd>{activeTerm.conversationSentence}</dd></div>
          <div className="vocabulary-takeaway"><dt>MERKEN</dt><dd>{activeTerm.keyTakeaway}</dd></div>
        </dl>
      </article>

      <div className="vocabulary-controls">
        <button type="button" className="vocabulary-arrow" onClick={() => move(-1)} aria-label="Vorheriger Begriff">←</button>
        <div className="vocabulary-dots" aria-hidden="true">
          {terms.map((entry, index) => <i className={index === activeIndex ? "active" : ""} key={entry.id} />)}
        </div>
        <button type="button" className="vocabulary-arrow" onClick={() => move(1)} aria-label="Nächster Begriff">→</button>
        <button
          type="button"
          className={`vocabulary-notion ${saved ? "is-saved" : ""}`}
          disabled={!notionConnected || saving || saved}
          onClick={() => onSave(activeTerm.id)}
          title={!notionConnected ? "Verbinde zuerst Notion" : undefined}
        >
          {saving ? "SPEICHERT …" : saved ? "NOTION ✓" : "NOTION +"}
        </button>
      </div>
      {saveError ? <p className="vocabulary-save-error" role="alert">{saveError}</p> : null}
    </section>
  );
}
