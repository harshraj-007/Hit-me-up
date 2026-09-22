/**
 * Lazy loaders for the two animation engines, keeping them out of the initial bundle.
 * Ownership rule: an animation is driven by exactly one engine.
 *  - GSAP: orchestration, timelines, layout/reorder, page and dashboard transitions.
 *  - Anime.js: isolated micro-interactions (icons, status feedback, value tweens).
 *  - CSS: trivial hover/focus states.
 * Callers must gate on `prefersReducedMotion()` / `motionSeconds()` before animating.
 */
export async function loadGsap() {
  const { gsap } = await import("gsap");
  return gsap;
}

export async function loadAnime() {
  return import("animejs");
}
