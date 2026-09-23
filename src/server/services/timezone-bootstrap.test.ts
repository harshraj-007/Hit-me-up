import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "../../../tests/support/fake-db";

const holder: { db: FakeDb; signedIn: boolean } = { db: createFakeDb(), signedIn: true };

vi.mock("@/server/auth/session", () => ({
  requireUserForAction: vi.fn(async () => {
    if (!holder.signedIn) throw new Error("not signed in");
    return { id: "user-1", email: null };
  }),
}));
vi.mock("@/server/db/supabase-server", () => ({
  createSupabaseServerClient: vi.fn(async () => holder.db.client),
}));

import { resolveLocalDate } from "@/domain/days";
import { ValidationError } from "@/server/errors";
import { findCurrentDay, resolveCurrentDay } from "./day";
import { syncTimezone } from "./profile";

const USER = "user-1";
/** The instant of the real incident: 02:38 in Calcutta on the 24th, but still the 23rd in UTC. */
const INCIDENT = new Date("2026-09-23T21:08:00Z");

const localDates = (db: FakeDb) => db.tables.days.map((d) => d.local_date);

beforeEach(() => {
  holder.db = createFakeDb();
  holder.signedIn = true;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(INCIDENT);
});
afterEach(() => vi.useRealTimers());

describe("first-visit timezone bootstrap", () => {
  it("premise: at this instant UTC and the user's real timezone disagree on the date", () => {
    expect(resolveLocalDate(INCIDENT, "UTC")).toBe("2026-09-23");
    expect(resolveLocalDate(INCIDENT, "Asia/Calcutta")).toBe("2026-09-24");
  });

  // The regression itself. Written only against resolveCurrentDay/syncTimezone so the very same
  // test also runs against the pre-fix code, where it produced two `days` rows.
  it("REGRESSION: a request before the browser reports its zone must not leave a stray day", async () => {
    // The first authenticated request — before the browser has said where the user is.
    await resolveCurrentDay(holder.db.client, USER).catch(() => undefined);
    // The browser then reports its real timezone, and the user keeps using the app.
    await syncTimezone("Asia/Calcutta");
    const day = await resolveCurrentDay(holder.db.client, USER);

    expect(day.localDate).toBe("2026-09-24");
    expect(localDates(holder.db)).toEqual(["2026-09-24"]); // pre-fix: ["2026-09-23", "2026-09-24"]
  });

  it("creates nothing at all while the timezone is unknown — no day, and no placeholder profile", async () => {
    expect(await findCurrentDay(holder.db.client, USER)).toBeNull();
    expect(holder.db.tables.days).toHaveLength(0);
    expect(holder.db.tables.profiles).toHaveLength(0);
    expect(holder.db.writes).toHaveLength(0);
  });

  it("refuses a mutation that arrives before the timezone is known, rather than filing it under a guess", async () => {
    const error = await resolveCurrentDay(holder.db.client, USER).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(holder.db.writes).toHaveLength(0);
  });

  it("after the browser reports its zone there is exactly one day, and every later visit reuses it", async () => {
    await syncTimezone("Asia/Calcutta");
    const first = await findCurrentDay(holder.db.client, USER);
    const again = await Promise.all([1, 2, 3].map(() => findCurrentDay(holder.db.client, USER)));

    expect(first?.localDate).toBe("2026-09-24");
    expect(again.map((d) => d?.id)).toEqual([first?.id, first?.id, first?.id]);
    expect(holder.db.tables.days).toHaveLength(1);
  });

  it("mirror case west of UTC: the stray day used to be *tomorrow's* UTC date", async () => {
    vi.setSystemTime(new Date("2026-09-24T02:00:00Z")); // 19:00 on the 23rd in Los Angeles
    expect(resolveLocalDate(new Date(), "UTC")).toBe("2026-09-24");
    await resolveCurrentDay(holder.db.client, USER).catch(() => undefined);
    await syncTimezone("America/Los_Angeles");
    await resolveCurrentDay(holder.db.client, USER);
    expect(localDates(holder.db)).toEqual(["2026-09-23"]);
  });

  it("concurrent first requests before the report all no-op", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => findCurrentDay(holder.db.client, USER)),
    );
    expect(results.every((r) => r === null)).toBe(true);
    expect(holder.db.writes).toHaveLength(0);
  });

  it("concurrent reports and renders converge on one profile and one day", async () => {
    await Promise.all([syncTimezone("Asia/Calcutta"), syncTimezone("Asia/Calcutta")]);
    await Promise.all([1, 2, 3].map(() => findCurrentDay(holder.db.client, USER)));
    expect(holder.db.tables.profiles).toHaveLength(1);
    expect(holder.db.tables.days).toHaveLength(1);
  });

  it("a browser that genuinely is in UTC is a confirmed timezone, not an unknown one", async () => {
    await syncTimezone("UTC");
    const day = await findCurrentDay(holder.db.client, USER);
    expect(day?.localDate).toBe("2026-09-23");
  });
});

describe("syncTimezone", () => {
  it("creates the profile with the timezone the browser reported, never a default", async () => {
    await syncTimezone("Asia/Calcutta");
    expect(holder.db.tables.profiles).toEqual([{ id: USER, timezone: "Asia/Calcutta" }]);
  });

  it("performs no write when the stored timezone already matches", async () => {
    await syncTimezone("Asia/Calcutta");
    holder.db.writes.length = 0;
    await syncTimezone("Asia/Calcutta");
    expect(holder.db.writes).toHaveLength(0);
  });

  it("updates the timezone when the browser reports a different one (e.g. travel)", async () => {
    await syncTimezone("Asia/Calcutta");
    await syncTimezone("America/New_York");
    expect(holder.db.tables.profiles).toEqual([{ id: USER, timezone: "America/New_York" }]);
  });

  it("travelling files new activity under the new local date — a different real day, not a duplicate", async () => {
    await syncTimezone("Asia/Calcutta");
    await findCurrentDay(holder.db.client, USER); // 2026-09-24
    await syncTimezone("America/Los_Angeles");
    await findCurrentDay(holder.db.client, USER); // still the 23rd there
    expect(localDates(holder.db).sort()).toEqual(["2026-09-23", "2026-09-24"]);
  });

  it("rejects an unrecognised timezone and writes nothing", async () => {
    await expect(syncTimezone("Not/AZone")).rejects.toThrow();
    expect(holder.db.writes).toHaveLength(0);
  });

  it("rejects an unauthenticated caller and writes nothing", async () => {
    holder.signedIn = false;
    await expect(syncTimezone("Asia/Calcutta")).rejects.toThrow();
    expect(holder.db.writes).toHaveLength(0);
  });
});
