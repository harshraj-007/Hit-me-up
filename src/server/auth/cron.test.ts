import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAuthorizedCronRequest } from "./cron";

function requestWithAuth(header: string | null): Request {
  const headers = new Headers();
  if (header !== null) headers.set("authorization", header);
  return new Request("https://example.test/api/cron/notifications", { method: "POST", headers });
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "the-real-secret");
});

describe("isAuthorizedCronRequest", () => {
  it("authorizes the exact configured secret", () => {
    expect(isAuthorizedCronRequest(requestWithAuth("Bearer the-real-secret"))).toBe(true);
  });

  it("rejects a missing Authorization header", () => {
    expect(isAuthorizedCronRequest(requestWithAuth(null))).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(isAuthorizedCronRequest(requestWithAuth("Bearer wrong-secret"))).toBe(false);
  });

  it("rejects a non-Bearer scheme", () => {
    expect(isAuthorizedCronRequest(requestWithAuth("Basic the-real-secret"))).toBe(false);
  });

  it("rejects a Bearer header with no token", () => {
    expect(isAuthorizedCronRequest(requestWithAuth("Bearer"))).toBe(false);
  });

  it("rejects a secret that merely starts with the right prefix (no partial match)", () => {
    expect(isAuthorizedCronRequest(requestWithAuth("Bearer the-real-secret-extra"))).toBe(false);
  });

  it("is indistinguishable from the outside whether CRON_SECRET is unset or just wrong — both are false", () => {
    vi.stubEnv("CRON_SECRET", "");
    expect(isAuthorizedCronRequest(requestWithAuth("Bearer anything"))).toBe(false);
    expect(isAuthorizedCronRequest(requestWithAuth(null))).toBe(false);
  });
});
