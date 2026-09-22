import { describe, expect, it, vi } from "vitest";
import { motionSeconds, prefersReducedMotion } from "./reduced-motion";

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches, addEventListener: () => {}, removeEventListener: () => {} }),
  });
}

describe("reduced motion", () => {
  it("defaults to reduced when there is no window (SSR)", () => {
    expect(prefersReducedMotion()).toBe(true);
    expect(motionSeconds(0.3)).toBe(0);
  });

  it("zeroes durations only when the user prefers reduced motion", () => {
    stubMatchMedia(true);
    expect(motionSeconds(0.3)).toBe(0);
    stubMatchMedia(false);
    expect(motionSeconds(0.3)).toBe(0.3);
  });
});
