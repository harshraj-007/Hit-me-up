import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AuthenticationError,
  ExternalServiceError,
  InternalError,
  NotFoundError,
  ValidationError,
  errorResponse,
  toAppError,
} from "./index";

describe("toAppError", () => {
  it("passes AppErrors through", () => {
    const e = new NotFoundError();
    expect(toAppError(e)).toBe(e);
  });

  it("maps ZodError to ValidationError with field issues", () => {
    const parsed = z.object({ name: z.string() }).safeParse({ name: 1 });
    const err = toAppError(parsed.error);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues[0]?.path).toBe("name");
  });

  it("wraps unknown errors as InternalError and keeps the cause", () => {
    const cause = new Error("db password=hunter2");
    const err = toAppError(cause);
    expect(err).toBeInstanceOf(InternalError);
    expect(err.cause).toBe(cause);
  });
});

describe("status mapping", () => {
  it.each([
    [new ValidationError(), 400, "VALIDATION_ERROR"],
    [new AuthenticationError(), 401, "UNAUTHENTICATED"],
    [new NotFoundError(), 404, "NOT_FOUND"],
    [new ExternalServiceError("claude"), 502, "EXTERNAL_SERVICE_ERROR"],
    [new InternalError(), 500, "INTERNAL_ERROR"],
  ])("%s", (err, status, code) => {
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
  });
});

describe("errorResponse", () => {
  it("never leaks internal cause detail to the client", async () => {
    const res = errorResponse(
      new Error("connect ECONNREFUSED db.internal:5432 password=hunter2"),
      "req-1",
    );
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("ECONNREFUSED");
    expect(JSON.parse(text).error).toMatchObject({ code: "INTERNAL_ERROR", requestId: "req-1" });
  });

  it("does not expose the wrapped cause of an external service failure", async () => {
    const res = errorResponse(
      new ExternalServiceError("claude", { cause: new Error("sk-ant-secret123") }),
    );
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("sk-ant");
  });
});
