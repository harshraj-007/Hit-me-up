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
});
