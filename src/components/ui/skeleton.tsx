import clsx from "clsx";

/** Loading placeholder. `animate-pulse` is a trivial CSS animation — already neutralised by
 *  the global reduced-motion reset in globals.css, so no JS gate is needed here. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={clsx("animate-pulse rounded-md bg-surface-hover", className)} />
  );
}
