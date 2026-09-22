"use client";

import { useId, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { mockBriefingText } from "@/mock/today";
import { PlanGenerating } from "./plan-generating";

export interface BriefingPanelProps {
  isGenerating: boolean;
  onReplan: (briefing: string) => void;
}

/** Briefing capture + the (placeholder) trigger for AI replanning. Real generation is Phase 4. */
export function BriefingPanel({ isGenerating, onReplan }: BriefingPanelProps) {
  const [text, setText] = useState(mockBriefingText.trim());
  const id = useId();
  const headingId = `${id}-heading`;

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
        What&rsquo;s on your plate today? Edit it any time circumstances change, then replan.
      </p>
      <label htmlFor={id} className="sr-only">
        Today&rsquo;s briefing
      </label>
      <textarea
        id={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        className="mt-3 w-full resize-none rounded-md border border-border bg-background p-2.5 text-sm text-foreground placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted">
          Mock data — the plan below is a fixed placeholder, not real AI output.
        </p>
        <Button size="sm" onClick={() => onReplan(text)} disabled={isGenerating}>
          <Sparkles aria-hidden className="size-4" />
          {isGenerating ? "Replanning…" : "Replan my day"}
        </Button>
      </div>
      {isGenerating ? (
        <div className="mt-3">
          <PlanGenerating />
        </div>
      ) : null}
    </section>
  );
}
