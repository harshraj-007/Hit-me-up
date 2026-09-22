"use client";

import { useSyncExternalStore } from "react";
import { prefersReducedMotion, subscribeReducedMotion } from "./reduced-motion";

/** Reactive reduced-motion flag. Reports `true` during SSR so no motion runs before hydration. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => true);
}
