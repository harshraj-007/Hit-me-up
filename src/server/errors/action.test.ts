import { describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "./app-error";
import { runAction } from "./action";

describe("runAction", () => {
  it("returns ok:true with the function's return value on success", async () => {
    const result = await runAction(async () => 42);
    expect(result).toEqual({ ok: true, data: 42 });
  });

  it("classifies a thrown AppError without leaking its cause", async () => {
    const result = await runAction(async () => {
      throw new NotFoundError({ cause: new Error("select failed: password=hunter2") });
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(JSON.stringify(result.error)).not.toContain("hunter2");
      expect(typeof result.error.requestId).toBe("string");
    }
  });

  it("surfaces field issues for a ValidationError", async () => {
    const result = await runAction(async () => {
      throw new ValidationError([{ path: "title", message: "Title is required." }]);
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.issues).toEqual([{ path: "title", message: "Title is required." }]);
  });

  it("wraps an unknown thrown value as INTERNAL_ERROR", async () => {
    const result = await runAction(async () => {
      throw new Error("unexpected");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INTERNAL_ERROR");
  });

  it("never throws itself, even when the logger is exercised", async () => {
    await expect(
      runAction(async () => {
        throw new Error("boom");
      }),
    ).resolves.toMatchObject({ ok: false });
  });
});
