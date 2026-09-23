"use client";

import { useId, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface BriefingPanelProps {
  initialText: string;
  isSaving: boolean;
  onSave: (briefing: string) => void;
}

/**
 * Briefing capture. Saving persists a new (append-only — see the migration) briefing row;
 * there is no AI planning here yet, so this is deliberately just a save action, not the
 * "Replan my day" placeholder Phase 2 shipped for a feature that didn't exist yet.
 */
export function BriefingPanel({ initialText, isSaving, onSave }: BriefingPanelProps) {
  const [text, setText] = useState(initialText);
  const id = useId();
  const headingId = `${id}-heading`;
  const hasContent = text.trim().length > 0;

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
        What&rsquo;s on your plate today? Jot it down — planning from it comes in a later phase.
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
      <div className="mt-3 flex justify-end">
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
