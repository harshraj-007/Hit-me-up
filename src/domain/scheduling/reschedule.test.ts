import { describe, expect, it } from "vitest";
import { taskDurationMs, validateReschedule } from "./reschedule";

// Thursday 2026-09-22 in UTC; "now" is 10:00.
const bounds = { start: new Date("2026-09-22T00:00:00Z"), end: new Date("2026-09-23T00:00:00Z") };
const now = new Date("2026-09-22T10:00:00Z");
const t = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 22, h, m));
const MIN = 60_000;

/** A stored task of `minutes` minutes starting at 12:00. */
const task = (minutes: number, status: "upcoming" | "completed" | "skipped" = "upcoming") => ({
  status,
  scheduledStart: t(12),
  scheduledEnd: new Date(t(12).getTime() + minutes * MIN),
});

describe("taskDurationMs", () => {
  it("is the stored end minus the stored start", () => {
    expect(taskDurationMs(task(90))).toBe(90 * MIN);
  });
});

describe("validateReschedule keeps the duration: new end = new start + original duration", () => {
  it.each([30, 60, 90, 120])(
    "a %i-minute task moved to a new same-day time stays %i minutes",
    (minutes) => {
      const result = validateReschedule(task(minutes), t(15), bounds, now);
      expect(result).toEqual({
        ok: true,
        start: t(15),
        end: new Date(t(15).getTime() + minutes * MIN),
      });
    },
  );

  it("90 minutes moved to 23:30 runs 23:30 → 01:00 next day and keeps its planning day's rules", () => {
    const result = validateReschedule(task(90), t(23, 30), bounds, now);
    expect(result).toEqual({
      ok: true,
      start: t(23, 30),
      end: new Date(Date.UTC(2026, 8, 23, 1, 0)),
    });
  });

  it("120 minutes moved to 22:30 runs 22:30 → 00:30 next day", () => {
    const result = validateReschedule(task(120), t(22, 30), bounds, now);
    expect(result).toEqual({
      ok: true,
      start: t(22, 30),
      end: new Date(Date.UTC(2026, 8, 23, 0, 30)),
    });
  });

  it("a 30-minute task at the very last minute of the day still ends after midnight", () => {
    const result = validateReschedule(task(30), new Date("2026-09-22T23:59:59.999Z"), bounds, now);
    expect(result).toMatchObject({ ok: true, end: new Date("2026-09-23T00:29:59.999Z") });
  });

  it("the derived duration is exactly the original, to the millisecond", () => {
    const odd = {
      status: "upcoming" as const,
      scheduledStart: t(12),
      scheduledEnd: new Date(t(12).getTime() + 5_400_123),
    };
    const result = validateReschedule(odd, t(16), bounds, now);
    expect(result.ok && result.end.getTime() - result.start.getTime()).toBe(5_400_123);
  });

  it("exactly 24 hours is the longest a rescheduled task can be, and it moves as 24 hours", () => {
    const result = validateReschedule(task(24 * 60), t(23, 30), bounds, now);
    expect(result).toEqual({
      ok: true,
      start: t(23, 30),
      end: new Date(Date.UTC(2026, 8, 23, 23, 30)),
    });
  });

  it("a stored task longer than 24h (impossible today) is refused rather than trimmed", () => {
    expect(validateReschedule(task(24 * 60 + 1), t(12), bounds, now)).toMatchObject({ ok: false });
  });

  it("the end is derived from the STORED task even when the caller believes in another length", () => {
    // Nothing in the signature accepts an end, so a stale or hostile 'end' cannot exist here.
    const result = validateReschedule(task(60), t(15), bounds, now);
    expect(result.ok && result.end).toEqual(t(16));
    expect(validateReschedule.length).toBe(4); // (task, newStart, bounds, now): no end parameter
  });

  it("an in-progress window is fine as long as the derived end is after now", () => {
    expect(validateReschedule(task(60), t(9, 30), bounds, now).ok).toBe(true); // 09:30 → 10:30
    expect(validateReschedule(task(60), t(9), bounds, now).ok).toBe(false); //   09:00 → 10:00 = now
  });
});

describe("validateReschedule — refusals", () => {
  it.each(["completed", "skipped"] as const)("rejects a %s task", (status) => {
    expect(validateReschedule(task(60, status), t(15), bounds, now)).toMatchObject({ ok: false });
  });

  it("rejects an invalid start", () => {
    expect(validateReschedule(task(60), new Date("nonsense"), bounds, now).ok).toBe(false);
  });

  it("rejects a start outside the planning day (before it, or at/after its end)", () => {
    expect(validateReschedule(task(60), new Date("2026-09-21T23:59:59.999Z"), bounds, now).ok).toBe(
      false,
    );
    expect(validateReschedule(task(60), new Date("2026-09-23T00:00:00.000Z"), bounds, now).ok).toBe(
      false,
    );
  });

  it("rejects a move whose whole window is already in the past", () => {
    expect(validateReschedule(task(60), t(8), bounds, now).ok).toBe(false);
  });
});

describe("validateReschedule — a locked (already hand-moved) task", () => {
  it("can be moved again; only a resolved task cannot (the lock is about the PLANNER, not the user)", () => {
    const locked = { ...task(60), scheduleLocked: true };
    expect(validateReschedule(locked, t(15), bounds, now)).toMatchObject({ ok: true });
  });
});
