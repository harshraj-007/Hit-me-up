import { loadAnime } from "./engines";
import { prefersReducedMotion } from "./reduced-motion";

/**
 * Anime.js ownership: a small pop-and-settle on a single status icon right after it changes
 * (task marked complete/skipped/late). Fires and forgets; callers don't await the visual.
 */
export async function pulseStatusIcon(el: Element | null): Promise<void> {
  if (!el || prefersReducedMotion()) return;
  const { animate } = await loadAnime();
  animate(el, {
    scale: [0.55, 1.12, 1],
    duration: 420,
    ease: "outElastic(1, .6)",
  });
}
