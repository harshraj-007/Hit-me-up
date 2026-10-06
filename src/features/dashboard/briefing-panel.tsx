"use client";

import { useId, useState } from "react";
import { CalendarPlus, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface BriefingPanelProps {
  /** The last SAVED briefing text ("" when none). Planning always uses the saved one. */
  initialText: string;
  isSaving: boolean;
  onSave: (briefing: string) => void;
  /** Opens the proposal review to plan the day from the saved briefing. */
  onPlan: () => void;
}

/**
 * Briefing capture. Saving persists a new (append-only — see the migration) briefing row.
 * "Plan my day" (Phase 8) is enabled only once a briefing has been SAVED and the box matches it:
 * the server plans from the saved row, never from what is typed here, so unsaved edits would
 * otherwise be silently ignored.
 */
export function BriefingPanel({ initialText, isSaving, onSave, onPlan }: BriefingPanelProps) {
  const [text, setText] = useState(initialText);
  const id = useId();
  const headingId = `${id}-heading`;
  const hasContent = text.trim().length > 0;
  const hasSaved = initialText.trim().length > 0;
  const dirty = text.trim() !== initialText.trim();

  return (
    <section
      data-animate="section"
      aria-labelledby={headingId}
      className="rounded-lg border border-border bg-surface p-4"
    >
      <h2 id={headingId} className="text-sm font-semibold">
        This morning&rsquo;s briefing
      </h2>
      <p className="mt-1 text-xs text-muted">
        What&rsquo;s on your plate today? Jot it down, save it, then plan your day from it.
      </p>
      <label htmlFor={id} className="sr-only">
        Today&rsquo;s briefing
      </label>
      <textarea
        id={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="e.g. Finish problem set 4, chem lab questions are due today, grab groceries…"
        className="mt-3 w-full resize-none rounded-md border border-border bg-background p-2.5 text-sm text-foreground placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      />
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={onPlan}
          disabled={!hasSaved || dirty || isSaving}
          title={
            !hasSaved
              ? "Save a briefing first."
              : dirty
                ? "Save your changes first — planning uses the saved briefing."
                : undefined
          }
        >
          <CalendarPlus aria-hidden className="size-4" />
          Plan my day
        </Button>
        <Button size="sm" onClick={() => onSave(text)} disabled={isSaving || !hasContent}>
          {isSaving ? (
            <Loader2 aria-hidden className="size-4 animate-spin" />
          ) : (
            <Save aria-hidden className="size-4" />
          )}
          {isSaving ? "Saving…" : "Save briefing"}
        </Button>
      </div>
    </section>
  );
}
