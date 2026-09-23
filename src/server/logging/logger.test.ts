import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "./logger";

describe("logger", () => {
  beforeEach(() => {
    vi.stubEnv("LOG_LEVEL", "debug");
  });
  afterEach(() => vi.restoreAllMocks());

  it("emits one JSON line with redacted fields and serialized error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.child({ requestId: "r1" }).error("boom", {
      apiKey: "sk-ant-secret",
      err: new Error("bad token Bearer abc123"),
    });
    const line = JSON.parse(String(spy.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      level: "error",
      msg: "boom",
      requestId: "r1",
      apiKey: "[REDACTED]",
    });
    expect(line.err.message).toBe("bad token Bearer [REDACTED]");
  });

  it("respects LOG_LEVEL", () => {
    vi.stubEnv("LOG_LEVEL", "error");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("quiet");
    expect(spy).not.toHaveBeenCalled();
  });
  it("keeps a database error's details and hint (the parts that name the constraint/policy)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const dbError = Object.assign(new Error("duplicate key value"), {
      code: "23505",
      details: "Key (day_id)=(abc) already exists. Bearer abc.def",
      hint: "Use ON CONFLICT",
    });
    logger.error("db failed", { err: dbError });
    const line = JSON.parse(String(spy.mock.calls[0]?.[0]));
    expect(line.err).toMatchObject({ code: "23505", hint: "Use ON CONFLICT" });
    expect(line.err.details).toContain("already exists");
    expect(line.err.details).not.toContain("abc.def");
  });
});
