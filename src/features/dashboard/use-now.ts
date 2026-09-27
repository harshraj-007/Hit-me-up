"use client";

import { useEffect, useRef, useState } from "react";

const MINUTE_MS = 60_000;

/**
 * The one clock for the whole dashboard: the header, the Now marker and every task's
 * current/late state all read the `Date` this returns, so they can never disagree.
 *
 * It starts at the server's `initialNow` (so server and client render identically — no
 * hydration mismatch) and then ticks on real minute boundaries, which is the finest
 * granularity anything on screen has. It re-syncs immediately when the tab becomes visible
 * again, because browsers throttle timers in background tabs. It never touches the database.
 *
 * `beforeTick` runs just before each update so a layout animation can snapshot the DOM first.
 */
export function useNow(initialNow: Date, beforeTick?: () => void): Date {
  const [now, setNow] = useState(initialNow);
  const beforeTickRef = useRef(beforeTick);
  useEffect(() => {
    beforeTickRef.current = beforeTick;
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    function tick() {
      beforeTickRef.current?.();
      setNow(new Date());
    }
    function schedule() {
      timer = setTimeout(
        () => {
          tick();
          schedule();
        },
        MINUTE_MS - (Date.now() % MINUTE_MS) + 25,
      );
    }
    function onVisibility() {
      if (document.visibilityState === "visible") tick();
    }

    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return now;
}
