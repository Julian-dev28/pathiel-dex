'use client';

import { useId } from 'react';

/**
 * The interface vocabulary.
 *
 * The first version of this product put its reasoning on the page: five equal
 * sections, each opening with a paragraph explaining its own methodology, and
 * the number the reader wanted somewhere in the middle. That is a good research
 * document and a bad instrument. Anyone scanning it has to hold five threads at
 * once and read prose to find out which one matters.
 *
 * These components enforce the opposite order everywhere: **the answer is the
 * largest thing on screen, and the reasoning is one click away and closed by
 * default.** Nothing has been deleted — the rigour is the point of the project —
 * it is just no longer standing between the reader and the number.
 */

/* ── card ─────────────────────────────────────────────────────────────── */

/**
 * A bounded chunk with a visible edge.
 *
 * pathiel's own register uses hairline rules and no boxes, which reads
 * beautifully as a document and poorly as a set of separate decisions. A
 * visible boundary is what lets someone leave the page, come back, and find
 * their place without re-reading.
 */
export function Card({
  title,
  step,
  meta,
  tone,
  children,
}: {
  title: string;
  /** Optional ordinal, shown as a numbered chip. */
  step?: number;
  meta?: React.ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'bad';
  children: React.ReactNode;
}) {
  return (
    <section className={`c-card${tone && tone !== 'default' ? ` c-${tone}` : ''}`}>
      <header className="c-head">
        {step !== undefined && <span className="c-step">{step}</span>}
        <h2 className="c-title">{title}</h2>
        {meta && <span className="c-meta">{meta}</span>}
      </header>
      <div className="c-body">{children}</div>
    </section>
  );
}

/* ── the answer ───────────────────────────────────────────────────────── */

/**
 * One figure, stated as large as it deserves.
 *
 * `label` is what it is, `value` is the number, `unit` rides small beside it,
 * and `note` is the single line of meaning. If a figure needs more than one
 * line of explanation, that explanation belongs in a `<Reveal>`, not here.
 */
export function Answer({
  label,
  value,
  unit,
  note,
  tone,
  size = 'lg',
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  note?: React.ReactNode;
  tone?: 'good' | 'warn' | 'bad' | 'mut';
  size?: 'lg' | 'xl' | 'sm';
}) {
  return (
    <div className="c-answer">
      <div className="c-answer-label">{label}</div>
      <div className={`c-answer-value c-${size}${tone ? ` c-t-${tone}` : ''}`}>
        {value}
        {unit && <span className="c-answer-unit">{unit}</span>}
      </div>
      {note && <div className="c-answer-note">{note}</div>}
    </div>
  );
}

/** A row of answers that wraps instead of scrolling. */
export const Answers = ({ children }: { children: React.ReactNode }) => (
  <div className="c-answers">{children}</div>
);

/* ── progressive disclosure ───────────────────────────────────────────── */

/**
 * Everything that used to be a paragraph.
 *
 * Closed by default, native `<details>` so it works without JavaScript and
 * announces its state to a screen reader for free. The summary is phrased as
 * the question the reader would actually ask — "Why this number?" — rather than
 * as a section title, because a question is a decision the reader can decline.
 */
export function Reveal({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="c-reveal" open={defaultOpen}>
      <summary>
        <span className="c-reveal-mark" aria-hidden="true" />
        {summary}
      </summary>
      <div className="c-reveal-body">{children}</div>
    </details>
  );
}

/* ── inline status ────────────────────────────────────────────────────── */

export function Chip({
  tone = 'mut',
  children,
}: {
  tone?: 'good' | 'warn' | 'bad' | 'mut' | 'accent';
  children: React.ReactNode;
}) {
  return <span className={`c-chip c-chip-${tone}`}>{children}</span>;
}

/**
 * A single actionable sentence with a button on the end.
 *
 * The shape most decisions in this product take: here is a thing you could do,
 * here is one tap that does it. Never acts on its own.
 */
export function Suggest({
  tone = 'accent',
  children,
  action,
  onAction,
}: {
  tone?: 'accent' | 'warn';
  children: React.ReactNode;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className={`c-suggest c-suggest-${tone}`}>
      <span>{children}</span>
      {action && onAction && (
        <button className="c-suggest-btn" type="button" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

/* ── page header ──────────────────────────────────────────────────────── */

/**
 * Title plus one sentence. Deliberately capped at one sentence: the old
 * two-and-three-line page descriptions were read by nobody and pushed the
 * controls below the fold on a laptop.
 */
export const PageHead = ({ title, lede }: { title: string; lede: string }) => (
  <header className="c-pagehead">
    <h1 className="c-pagetitle">{title}</h1>
    <p className="c-lede">{lede}</p>
  </header>
);

/* ── quiet states ─────────────────────────────────────────────────────── */

export const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="c-empty">{children}</p>
);

export const ErrorNote = ({ children, onRetry }: { children: React.ReactNode; onRetry?: () => void }) => (
  <div className="c-error">
    <span>{children}</span>
    {onRetry && (
      <button className="c-suggest-btn" type="button" onClick={onRetry}>
        Retry
      </button>
    )}
  </div>
);

/**
 * A skeleton with a fixed height.
 *
 * Height matters more than the shimmer: content that arrives and shoves
 * everything down is the single most disorienting thing an interface can do to
 * someone who has just found their place.
 */
export const Loading = ({ rows = 2 }: { rows?: number }) => (
  <div className="c-loading" aria-live="polite" aria-busy="true">
    {Array.from({ length: rows }, (_, i) => (
      <div className="c-skel" key={i} />
    ))}
    <span className="c-sr">Loading</span>
  </div>
);

/* ── segmented control ────────────────────────────────────────────────── */

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  const id = useId();
  return (
    <div className="c-seg" role="group" aria-label={label} id={id}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={`c-seg-btn${o.value === value ? ' on' : ''}`}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
