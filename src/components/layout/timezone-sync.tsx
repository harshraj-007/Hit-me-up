"use client";

import { useEffect } from "react";
import { syncTimezoneAction } from "./timezone-actions";

const STORAGE_KEY = "hitmeup.lastSyncedTimezone";

/**
 * The one-time timezone capture from domain/days/timezone.ts, run once per browser (not
 * every page load) via a localStorage cache. Renders nothing — this is a side effect, not
 * a UI. Failing to read/write localStorage (private browsing, blocked storage) just means
 * it retries next time; it never blocks rendering or throws.
 */
export function TimezoneSync() {
  useEffect(() => {
    let timezone: string;
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }

    let lastSynced: string | null = null;
    try {
      lastSynced = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // Storage unavailable — fine, just means this runs again next visit.
    }
    if (lastSynced === timezone) return;

    void syncTimezoneAction(timezone).then((result) => {
      if (!result.ok) return;
      try {
        window.localStorage.setItem(STORAGE_KEY, timezone);
      } catch {
        // Non-fatal: worst case, this runs again next visit.
      }
    });
  }, []);

  return null;
}
