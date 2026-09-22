const QUERY = "(prefers-reduced-motion: reduce)";

/** Single source of truth for reduced motion. Server and unsupported environments: no motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(QUERY).matches;
}

export function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** Collapses any duration to 0 when the user prefers reduced motion. Route all timings through this. */
export function motionSeconds(seconds: number): number {
  return prefersReducedMotion() ? 0 : seconds;
}
