import { describe, expect, it } from "vitest";
import {
  at,
  buildFor,
  DAY_ID,
  makeTask,
  OTHER_DAY_ID,
  USER_ID,
} from "../../../tests/support/ai-planning-fixtures";
import { assignAliases, isAliasShaped } from "./aliases";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("aliases", () => {
  it("are deterministic and independent of input order", () => {
    const a = makeTask({ start: at(12), end: at(13) });
    const b = makeTask({ start: at(10), end: at(11) });
    const c = makeTask({ start: at(15), end: at(16) });
    const one = assignAliases([a, b, c]);
    const two = assignAliases([c, a, b]);
    expect([...one.refToTaskId]).toEqual([...two.refToTaskId]);
    expect(one.refToTaskId.get("t1")).toBe(b.id); // earliest start
    expect(one.refToTaskId.get("t3")).toBe(c.id);
  });
  it("breaks start-time ties by creation time then id", () => {
    const first = makeTask({ start: at(12), end: at(13) });
    const second = makeTask({ start: at(12), end: at(13) });
    expect(assignAliases([second, first]).refToTaskId.get("t1")).toBe(first.id);
  });
  it("only alias-shaped strings pass, never a UUID", () => {
    expect(isAliasShaped("t1")).toBe(true);
    expect(isAliasShaped("t42")).toBe(true);
    expect(isAliasShaped("t0")).toBe(false);
    expect(isAliasShaped("T1")).toBe(false);
    expect(isAliasShaped(DAY_ID)).toBe(false);
    expect(isAliasShaped("t1; drop table tasks")).toBe(false);
  });
});

describe("buildPlanningContext — explicit allow-list", () => {
  const tasks = [
    makeTask({ title: "Gym", start: at(18), end: at(19), notes: "secret note alice@example.com" }),
    makeTask({ title: "DSA", start: at(20), end: at(21, 30), scheduleLocked: true }),
    makeTask({
      title: "Yesterday's late job",
      dayId: OTHER_DAY_ID,
      start: at(23, 30, -1),
      end: at(1),
      source: "user",
    }),
    makeTask({ title: "Done", status: "completed", start: at(7), end: at(8) }),
  ];
  const { context, state } = buildFor(tasks);

  it("exposes exactly the approved top-level fields", () => {
    expect(Object.keys(context).sort()).toEqual(
      [
        "baseRevision",
        "conflicts",
        "dayBounds",
        "now",
        "planningDate",
        "rules",
        "tasks",
        "timezone",
      ].sort(),
    );
  });

  it("exposes exactly the approved task fields", () => {
    for (const t of context.tasks) {
      expect(Object.keys(t).sort()).toEqual(
        [
          "durationMinutes",
          "end",
          "fromPreviousDay",
          "kind",
          "locked",
          "movable",
          "priority",
          "ref",
          "start",
          "status",
          "temporal",
          "title",
        ].sort(),
      );
    }
  });

  it("leaks no UUID, user id, email, notes, or database field names", () => {
    const wire = JSON.stringify(context);
    expect(wire).not.toMatch(UUID);
    for (const forbidden of [
      USER_ID,
      DAY_ID,
      OTHER_DAY_ID,
      "PRIVATE-NOTES-DO-NOT-LEAK",
      "secret note",
      "alice@example.com",
    ]) {
      expect(wire).not.toContain(forbidden);
    }
    for (const field of [
      "userId",
      "user_id",
      "notes",
      "dueAt",
      "createdAt",
      "updatedAt",
      "completedAt",
      "scheduleLocked",
      "dayId",
      "source",
      "history",
      "briefing",
      "revision_",
      "SELECT",
      "apikey",
      "stack",
    ]) {
      expect(wire).not.toContain(field);
    }
    for (const id of tasks.map((t) => t.id)) expect(wire).not.toContain(id);
  });

  it("uses aliases t1..tN and maps them only in server-side state", () => {
    expect(context.tasks.map((t) => t.ref)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(state.refToTaskId.size).toBe(4);
    expect(JSON.stringify(context)).not.toContain([...state.refToTaskId.values()][0]);
  });

  it("marks locked, spillover, resolved and movability correctly", () => {
    const byTitle = Object.fromEntries(context.tasks.map((t) => [t.title, t]));
    expect(byTitle["Gym"]).toMatchObject({
      movable: true,
      locked: false,
      fromPreviousDay: false,
      temporal: "upcoming",
      durationMinutes: 60,
    });
    expect(byTitle["DSA"]).toMatchObject({ movable: false, locked: true, durationMinutes: 90 });
    expect(byTitle["Yesterday's late job"]).toMatchObject({
      movable: false,
      fromPreviousDay: true,
    });
    expect(byTitle["Done"]).toMatchObject({
      movable: false,
      status: "completed",
      temporal: "completed",
    });
  });

  it("gives times as local wall-clock strings and the day bounds", () => {
    expect(context.now).toBe("2026-10-01T09:00");
    expect(context.dayBounds).toEqual({ start: "2026-10-01T00:00", end: "2026-10-02T00:00" });
    expect(context.tasks.find((t) => t.title === "Gym")).toMatchObject({
      start: "2026-10-01T18:00",
      end: "2026-10-01T19:00",
    });
    expect(context.baseRevision).toBe(3);
  });

  it("reports current conflicts by alias", () => {
    const { context: c } = buildFor([
      makeTask({ start: at(18), end: at(19) }),
      makeTask({ start: at(18, 30), end: at(19, 30) }),
    ]);
    expect(c.conflicts).toEqual([{ first: "t1", second: "t2" }]);
  });
});
