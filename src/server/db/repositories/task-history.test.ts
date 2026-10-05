import { describe, expect, it } from "vitest";
import { ExternalServiceError } from "@/server/errors";
import { listTaskHistoryForTasks } from "./task-history";

const row = (over: Record<string, unknown> = {}) => ({
  id: "h1",
  task_id: "t1",
  user_id: "u1",
  previous_status: "upcoming",
  new_status: "upcoming",
  source: "ai",
  event: "replanned",
  previous_start: "2026-10-01T10:00:00Z",
  previous_end: "2026-10-01T11:00:00Z",
  new_start: "2026-10-01T13:00:00Z",
  new_end: "2026-10-01T14:00:00Z",
  previous_unscheduled: false,
  new_unscheduled: false,
  revision_id: "rev1",
  changed_at: "2026-10-01T09:00:00Z",
  ...over,
});

function client(pages: { data: unknown; error: unknown }[], seen: string[][] = []) {
  let call = 0;
  const chain: Record<string, unknown> = {
    select: () => chain,
    in: (_c: string, ids: string[]) => (seen.push(ids), chain),
    order: async () => pages[call++]!,
  };
  return {
    from: (t: string) =>
      t === "task_history"
        ? chain
        : (() => {
            throw new Error(t);
          })(),
  } as never;
}

describe("listTaskHistoryForTasks (read-only)", () => {
  it("maps rows, including the 'ai' source and null windows", async () => {
    const entries = await listTaskHistoryForTasks(
      client([
        {
          data: [
            row(),
            row({
              id: "h2",
              event: "created",
              previous_start: null,
              previous_end: null,
              new_start: null,
              new_end: null,
            }),
          ],
          error: null,
        },
      ]),
      ["t1"],
    );
    expect(entries[0]).toMatchObject({
      taskId: "t1",
      event: "replanned",
      source: "ai",
      previousStart: new Date("2026-10-01T10:00:00Z"),
      newEnd: new Date("2026-10-01T14:00:00Z"),
      changedAt: new Date("2026-10-01T09:00:00Z"),
    });
    expect(entries[1]).toMatchObject({ event: "created", previousStart: null, newStart: null });
  });

  it("queries in chunks so the request size is bounded, and concatenates the results", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `t${i}`);
    const seen: string[][] = [];
    const entries = await listTaskHistoryForTasks(
      client(
        [
          { data: [row({ id: "a" })], error: null },
          { data: [row({ id: "b" })], error: null },
          { data: [row({ id: "c" })], error: null },
        ],
        seen,
      ),
      ids,
    );
    expect(seen.map((c) => c.length)).toEqual([50, 50, 20]);
    expect(entries.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("makes no query at all for no tasks", async () => {
    expect(await listTaskHistoryForTasks(client([]), [])).toEqual([]);
  });

  it("wraps a database failure without leaking it", async () => {
    const error = await listTaskHistoryForTasks(
      client([{ data: null, error: { code: "XX000", message: "SECRET" } }]),
      ["t1"],
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect(String((error as Error).message)).not.toContain("SECRET");
  });

  it("exposes no write path", async () => {
    const mod = await import("./task-history");
    expect(Object.keys(mod)).toEqual(["listTaskHistoryForTasks"]);
  });
});
