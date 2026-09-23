import { describe, expect, it } from "vitest";
import { deriveDisplayStatus } from "./derive-status";

const task = (status: "upcoming" | "completed" | "skipped" | "late") => ({
  status,
  scheduledStart: new Date(2026, 8, 22, 9, 0),
  scheduledEnd: new Date(2026, 8, 22, 9, 30),
});

describe("deriveDisplayStatus", () => {
  it("shows an in-window upcoming task as current", () => {
    expect(deriveDisplayStatus(task("upcoming"), new Date(2026, 8, 22, 9, 15))).toBe("current");
  });

  it("is inclusive of the start boundary and exclusive of the end boundary", () => {
    expect(deriveDisplayStatus(task("upcoming"), new Date(2026, 8, 22, 9, 0))).toBe("current");
    expect(deriveDisplayStatus(task("upcoming"), new Date(2026, 8, 22, 9, 30))).toBe("upcoming");
  });

  it("shows an upcoming task outside its window as upcoming", () => {
    expect(deriveDisplayStatus(task("upcoming"), new Date(2026, 8, 22, 8, 0))).toBe("upcoming");
    expect(deriveDisplayStatus(task("upcoming"), new Date(2026, 8, 22, 10, 0))).toBe("upcoming");
  });

  it.each(["completed", "skipped", "late"] as const)(
    "never overrides a resolved status (%s) even inside the window",
    (status) => {
      expect(deriveDisplayStatus(task(status), new Date(2026, 8, 22, 9, 15))).toBe(status);
    },
  );
});
