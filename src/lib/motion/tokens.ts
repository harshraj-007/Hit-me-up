/** Shared motion vocabulary. Durations are in seconds (GSAP) unless suffixed `Ms`. */
export const duration = {
  instant: 0.1,
  fast: 0.18,
  base: 0.28,
  slow: 0.45,
} as const;

/** Named eases as GSAP strings; Anime.js callers should map these via `animeEase`. */
export const ease = {
  out: "power2.out",
  inOut: "power2.inOut",
  emphasized: "expo.out",
} as const;

export type Duration = keyof typeof duration;
