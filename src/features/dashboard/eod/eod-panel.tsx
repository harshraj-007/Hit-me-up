"use client";

import { useId, useMemo, useState } from "react";
import { ClipboardCheck, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast-provider";
import type { EodReportView } from "@/domain/eod";
import { generateEodReportAction } from "./actions";
import { buildEodDisplay } from "./eod-view";

export interface EodPanelProps {
  /** Today's saved review, if there is one (read on the server — no model call to show it). */
  initialView: EodReportView | null;
  /** The day has a row to review (it does for today once the page has loaded). */
  dayExists: boolean;
}

/**
 * The end-of-day review. It starts empty and is generated ONLY by an explicit click — never on
 * load, never on a timer — because each generation is a model call. What it shows is a stored
 * snapshot: the numbers come from the deterministic facts, the prose from the validated
 * interpretation, so re-opening the page shows the same review rather than a fresh one. If the
 * day has changed since it was written the panel says so and offers an update; it never rewrites
 * a review on its own. It is read-only: nothing here completes, skips, moves, or schedules a task.
 */
export function EodPanel({ initialView, dayExists }: EodPanelProps) {
  const [view, setView] = useState<EodReportView | null>(initialView);
  const [isGenerating, setIsGenerating] = useState(false);
  const { toast } = useToast();
  const headingId = useId();
  const display = useMemo(() => (view ? buildEodDisplay(view) : null), [view]);

  async function handleGenerate() {
    if (isGenerating) return;
    setIsGenerating(true);
    try {
      const result = await generateEodReportAction();
      if (!result.ok) {
        toast({
          title: "Couldn't review the day",
          description: result.error.message,
          tone: "error",
        });
        return;
      }
      if (result.data.kind === "empty") {
        toast({
          title: "Nothing to review yet",
          description: "Add a task to today first.",
          tone: "neutral",
        });
        return;
      }
      setView(result.data.view);
    } catch {
      toast({
        title: "Couldn't review the day",
        description: "Check your connection and try again.",
        tone: "error",
      });
    } finally {
      setIsGenerating(false);
    }
  }

  const action = (label: string, icon: "review" | "refresh") => (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => void handleGenerate()}
      disabled={isGenerating || !dayExists}
    >
      {isGenerating ? (
        <Loader2 aria-hidden className="size-4 animate-spin" />
      ) : icon === "review" ? (
        <ClipboardCheck aria-hidden className="size-4" />
      ) : (
        <RefreshCw aria-hidden className="size-4" />
      )}
      {isGenerating ? "Reviewing…" : label}
    </Button>
  );

  return (
    <section
      data-animate="section"
      aria-labelledby={headingId}
      className="mt-6 rounded-lg border border-border bg-surface p-4 lg:mt-8"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-sm font-semibold">
          Wrap up the day
        </h2>
        {!display ? action("Review the day", "review") : null}
        {display?.isStale ? action("Update review", "refresh") : null}
      </div>

      {!display ? (
        <p className="mt-2 text-sm text-muted">
          See what got done, what slipped, and what to carry into tomorrow.
        </p>
      ) : (
        <div key={view?.report.id} className="eod-reveal mt-3 space-y-4" aria-live="polite">
          {display.isStale ? (
            <p className="text-xs text-muted">
              Your day has changed since this review. It shows the day as it was then.
            </p>
          ) : null}

          <p className="text-base leading-snug font-medium">{display.takeaway}</p>

          <div>
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {display.stats.map((stat) => (
                <span key={stat.key}>
                  <span className="font-semibold tabular-nums">{stat.value}</span>{" "}
                  <span className="text-muted">{stat.label}</span>
                </span>
              ))}
            </p>
            {display.notes.length > 0 ? (
              <p className="mt-1 text-xs text-muted">{display.notes.join(" · ")}</p>
            ) : null}
          </div>

          <p className="text-sm">{display.summary}</p>

          {display.patterns.length > 0 ? (
            <div>
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Patterns</h3>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">
                {display.patterns.map((pattern, i) => (
                  <li key={i}>{pattern}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {display.carryForward.length > 0 ? (
            <div>
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
                Carry forward
              </h3>
              <ul className="mt-1 divide-y divide-border">
                {display.carryForward.map((item) => (
                  <li key={item.key} className="py-2 text-sm">
                    <p className="font-medium">{item.title}</p>
                    <p className="text-xs text-muted">
                      {item.status} · {item.when}
                    </p>
                    {item.suggestion ? <p className="mt-0.5">{item.suggestion}</p> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="text-xs text-muted">{display.reviewedAt}</p>
        </div>
      )}
    </section>
  );
}
