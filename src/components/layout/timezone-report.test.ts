import { describe, expect, it, vi } from "vitest";
import { reportTimezone } from "./timezone-report";

function run(sync: (tz: string) => Promise<{ ok: boolean }>, cancelled = false) {
  const onSaved = vi.fn();
  const onFailed = vi.fn();
  const done = reportTimezone({
    sync,
    timezone: "Asia/Calcutta",
    isCancelled: () => cancelled,
    onSaved,
    onFailed,
  });
  return { done, onSaved, onFailed };
}

describe("reportTimezone", () => {
  it("passes the browser's timezone to the server action", async () => {
    const sync = vi.fn(async () => ({ ok: true }));
    await run(sync).done;
    expect(sync).toHaveBeenCalledExactlyOnceWith("Asia/Calcutta");
  });

  it("calls onSaved — and only onSaved — after the server confirms", async () => {
    const { done, onSaved, onFailed } = run(async () => ({ ok: true }));
    await done;
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("calls onFailed, never onSaved, when the server refuses ({ ok: false })", async () => {
    const { done, onSaved, onFailed } = run(async () => ({ ok: false }));
    await done;
    expect(onFailed).toHaveBeenCalledOnce();
    expect(onSaved).not.toHaveBeenCalled();
  });

  // The regression: a rejected call used to escape as an unhandled rejection and leave the UI
  // on "Setting up your day…" forever, because no callback ran at all.
  it("REGRESSION: a rejected Server Action call ends in onFailed instead of hanging", async () => {
    const { done, onSaved, onFailed } = run(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(done).resolves.toBeUndefined(); // does not reject / go unhandled
    expect(onFailed).toHaveBeenCalledOnce();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("never refreshes after a failure of either kind", async () => {
    for (const sync of [
      async () => ({ ok: false }),
      async () => {
        throw new Error("network down");
      },
    ]) {
      const { done, onSaved } = run(sync);
      await done;
      expect(onSaved).not.toHaveBeenCalled();
    }
  });

  describe("a superseded run (StrictMode's first effect, a retry, unmount) does nothing", () => {
    it.each([
      ["success", async () => ({ ok: true })],
      ["refusal", async () => ({ ok: false })],
      [
        "rejection",
        async () => {
          throw new Error("network down");
        },
      ],
    ])("stays silent on %s", async (_label, sync) => {
      const { done, onSaved, onFailed } = run(sync, true);
      await expect(done).resolves.toBeUndefined();
      expect(onSaved).not.toHaveBeenCalled();
      expect(onFailed).not.toHaveBeenCalled();
    });

    it("re-checks cancellation AFTER the call resolves, not before it starts", async () => {
      let cancelled = false;
      const onSaved = vi.fn();
      const onFailed = vi.fn();
      const done = reportTimezone({
        sync: async () => {
          cancelled = true; // superseded while the request is in flight
          return { ok: true };
        },
        timezone: "Asia/Calcutta",
        isCancelled: () => cancelled,
        onSaved,
        onFailed,
      });
      await done;
      expect(onSaved).not.toHaveBeenCalled();
      expect(onFailed).not.toHaveBeenCalled();
    });
  });
});
