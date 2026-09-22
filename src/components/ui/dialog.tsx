"use client";

import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "./button";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}

/**
 * Built on the native <dialog> element: the browser handles focus trapping, the top layer
 * and Escape-to-close for free, which is why this isn't hand-rolled on top of a generic
 * <div>. Entry/exit motion is a plain CSS opacity+scale transition (see globals.css) — a
 * single state toggle, not an orchestrated sequence, so it stays outside the GSAP/Anime
 * ownership split and is already covered by the global `prefers-reduced-motion` reset.
 */
export function Dialog({ open, onOpenChange, title, description, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleClose = () => onOpenChange(false);
    el.addEventListener("close", handleClose);
    return () => el.removeEventListener("close", handleClose);
  }, [onOpenChange]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-0 text-foreground shadow-md backdrop:bg-black/40"
      onClick={(e) => {
        // A click that lands on the backdrop is dispatched with the <dialog> itself as the
        // target (there's nothing else there to receive it), which is how this is
        // distinguished from a click inside the panel content below.
        if (e.target === ref.current) onOpenChange(false);
      }}
    >
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1 text-sm text-muted">
                {description}
              </p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Close dialog"
            className="-me-1 -mt-1 px-2"
            onClick={() => onOpenChange(false)}
          >
            <X aria-hidden className="size-4" />
          </Button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </dialog>
  );
}
