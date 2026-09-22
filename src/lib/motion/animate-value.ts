import { loadAnime } from "./engines";
import { prefersReducedMotion } from "./reduced-motion";

interface AnimateValueOptions {
  from: number;
  to: number;
  durationMs?: number;
  formatter?: (value: number) => string;
}

/**
 * Anime.js ownership: tweens a number into an element's text (e.g. "2 of 9 done"). Jumps
 * straight to the final value with no animation when the user prefers reduced motion.
 */
export async function animateValue(
  el: HTMLElement | null,
  { from, to, durationMs = 500, formatter = (v) => String(Math.round(v)) }: AnimateValueOptions,
): Promise<void> {
  if (!el) return;
  if (from === to || prefersReducedMotion()) {
    el.textContent = formatter(to);
    return;
  }
  const proxy = { value: from };
  const { animate } = await loadAnime();
  animate(proxy, {
    value: to,
    duration: durationMs,
    ease: "outQuad",
    onUpdate: () => {
      el.textContent = formatter(proxy.value);
    },
  });
}
