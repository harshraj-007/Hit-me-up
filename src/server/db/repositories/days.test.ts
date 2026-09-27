import { describe, expect, it, vi } from "vitest";
import { ExternalServiceError, ValidationError } from "@/server/errors";
import { ensureDay, findDayByDate, findDayById } from "./days";

const ROW = { id: "d1", user_id: "u1", local_date: "2026-09-25", timezone: "Asia/Kolkata" };

function rpcClient(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => result);
  return { client: { rpc } as never, rpc };
}

describe("ensureDay", () => {
  it("calls ensure_day with a date only (null = today) and maps the row", async () => {
    const { client, rpc } = rpcClient({ data: ROW, error: null });
    await expect(ensureDay(client, "2026-09-25")).resolves.toEqual({
      id: "d1",
      userId: "u1",
      localDate: "2026-09-25",
      timezone: "Asia/Kolkata",
    });
    expect(rpc).toHaveBeenCalledWith("ensure_day", { p_local_date: "2026-09-25" });
  });

  it("passes null for 'today' and sends nothing else — no timezone, no user id", async () => {
    const { client, rpc } = rpcClient({ data: ROW, error: null });
    await ensureDay(client);
    expect(rpc).toHaveBeenCalledWith("ensure_day", { p_local_date: null });
  });

  it("maps P0002 (no profile yet) to the needs-timezone ValidationError", async () => {
    const { client } = rpcClient({ data: null, error: { code: "P0002", message: "x" } });
    const error = await ensureDay(client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).issues[0]?.path).toBe("timezone");
  });

  it("maps 22023 (outside the horizon / unknown timezone) to a planningDate ValidationError", async () => {
    const { client } = rpcClient({ data: null, error: { code: "22023", message: "x" } });
    const error = await ensureDay(client, "2030-01-01").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).issues[0]?.path).toBe("planningDate");
  });

  it("wraps anything else as an upstream failure", async () => {
    const { client } = rpcClient({ data: null, error: { code: "XX000", message: "secret" } });
    await expect(ensureDay(client)).rejects.toBeInstanceOf(ExternalServiceError);
  });
});

describe("findDayByDate / findDayById (read-only)", () => {
  function selectClient(data: unknown, seen: string[]) {
    const chain = {
      select: () => chain,
      eq: (c: string, v: string) => (seen.push(`${c}=${v}`), chain),
      maybeSingle: async () => ({ data, error: null }),
    };
    return { from: () => chain } as never;
  }

  it("findDayByDate queries by user and date and returns null when absent", async () => {
    const seen: string[] = [];
    expect(await findDayByDate(selectClient(null, seen), "u1", "2026-09-30")).toBeNull();
    expect(seen).toEqual(["user_id=u1", "local_date=2026-09-30"]);
  });

  it("findDayById maps a visible day", async () => {
    expect(await findDayById(selectClient(ROW, []), "d1")).toMatchObject({
      id: "d1",
      localDate: "2026-09-25",
    });
  });

  it("exposes only ensureDay as a writer", async () => {
    const mod = await import("./days");
    expect(Object.keys(mod).sort()).toEqual(["ensureDay", "findDayByDate", "findDayById"]);
  });
});
