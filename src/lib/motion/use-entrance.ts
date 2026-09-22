"use client";

import { useRef } from "react";
import { gsap, useGSAP } from "./gsap-client";
import { prefersReducedMotion } from "./reduced-motion";
import { duration, ease } from "./tokens";

interface UseEntranceOptions {
  /** Selector, evaluated within the returned scope, for elements to fade/lift in. */
  selector?: string;
  stagger?: number;
  /** Re-runs the effect (e.g. when a task list gains/loses items after a replan). */
  dependencies?: unknown[];
}

/**
 * GSAP ownership: orchestrated entrance for a scope of elements (dashboard sections, a
 * timeline's task blocks, a stagger-in list). Elements are located via `data-animate` so
 * markup doesn't need per-element refs.
 *
 * Only genuinely new DOM nodes are faded/lifted in — nodes this hook has already animated
 * (tracked by identity in `seen`, which survives React re-rendering the same element with
 * new props because list items keep a stable `key`) are snapped straight to the resting
 * state. Without that check, every re-run — e.g. a task's status changing, which changes
 * the `tasks` array reference — would replay the fade for the *entire* already-visible
 * list. Skips straight to the end state for everyone when the user prefers reduced motion.
 */
export function useEntrance<T extends HTMLElement>({
  selector = "[data-animate]",
  stagger = 0.06,
  dependencies = [],
}: UseEntranceOptions = {}) {
  const scope = useRef<T>(null);
  const seen = useRef<WeakSet<Element>>(new WeakSet());

  useGSAP(
    () => {
      if (!scope.current) return;
      const targets = gsap.utils.toArray<HTMLElement>(selector, scope.current);
      if (targets.length === 0) return;

      if (prefersReducedMotion()) {
        gsap.set(targets, { opacity: 1, y: 0 });
        targets.forEach((el) => seen.current.add(el));
        return;
      }

      const fresh = targets.filter((el) => !seen.current.has(el));
      const alreadyShown = targets.filter((el) => seen.current.has(el));
      targets.forEach((el) => seen.current.add(el));

      if (alreadyShown.length)
        gsap.set(alreadyShown, { opacity: 1, y: 0, clearProps: "transform" });
      if (fresh.length === 0) return;

      gsap.fromTo(
        fresh,
        { opacity: 0, y: 12 },
        {
          opacity: 1,
          y: 0,
          duration: duration.slow,
          ease: ease.out,
          stagger,
          clearProps: "transform",
        },
      );
    },
    { scope, dependencies },
  );

  return scope;
}
