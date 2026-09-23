import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ requireUserForAction: vi.fn() }));
vi.mock("@/server/db/supabase-server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({})),
}));
vi.mock("@/server/db/repositories/briefings", () => ({ insertBriefing: vi.fn() }));
vi.mock("./day", () => ({ resolveCurrentDay: vi.fn() }));

import { requireUserForAction } from "@/server/auth/session";
import { insertBriefing } from "@/server/db/repositories/briefings";
import { resolveCurrentDay } from "./day";
import { saveBriefingForToday } from "./briefings";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUserForAction).mockResolvedValue({ id: "user-1", email: "a@b.com" });
  vi.mocked(resolveCurrentDay).mockResolvedValue({
    id: "day-1",
    userId: "user-1",
    localDate: "2026-09-22",
    timezone: "UTC",
  });
});

describe("saveBriefingForToday", () => {
  it("rejects empty text before resolving the day", async () => {
    await expect(saveBriefingForToday({ rawText: "   " })).rejects.toThrow();
    expect(resolveCurrentDay).not.toHaveBeenCalled();
  });

  it("inserts the (trimmed) briefing under the caller's current day", async () => {
    vi.mocked(insertBriefing).mockResolvedValue({
      id: "b1",
      rawText: "Finish the report",
      createdAt: new Date(),
    });

    const result = await saveBriefingForToday({ rawText: "  Finish the report  " });

    expect(result.rawText).toBe("Finish the report");
    expect(insertBriefing).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "day-1",
      "Finish the report",
    );
  });
});
