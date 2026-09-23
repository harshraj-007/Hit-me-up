import { describe, expect, it } from "vitest";
import { safeInternalPath } from "./redirect";

const ORIGIN = "http://localhost:3000";

describe("safeInternalPath", () => {
  it.each(["/today", "/foo/bar", "/history", "/today?x=1", "/a/b#frag", "/%2Fevil.example"])(
    "allows the internal path %s unchanged",
    (path) => {
      expect(safeInternalPath(path)).toBe(path);
    },
  );

  it.each([
    ["absolute https URL", "https://evil.example"],
    ["absolute http URL", "http://evil.example/phish"],
    ["protocol-relative", "//evil.example"],
    ["protocol-relative with path", "//evil.example/phish"],
    ["triple slash", "///evil.example"],
    ["slash-backslash", "/\\evil.example"],
    ["bare backslash", "\\evil.example"],
    ["backslash later in the path", "/foo\\bar"],
    ["tab smuggled between slashes", "/\t/evil.example"],
    ["newline smuggled between slashes", "/\n/evil.example"],
    ["carriage return", "/\r/evil.example"],
    ["javascript: URL", "javascript:alert(1)"],
    ["scheme without slashes", "http:evil.example"],
    ["bare host", "evil.example"],
    ["leading space", " /today"],
    ["empty string", ""],
  ])("falls back to /today for %s", (_label, candidate) => {
    expect(safeInternalPath(candidate)).toBe("/today");
  });

  it("falls back for a missing value", () => {
    expect(safeInternalPath(null)).toBe("/today");
    expect(safeInternalPath(undefined)).toBe("/today");
  });

  it("honours a custom fallback", () => {
    expect(safeInternalPath("//evil.example", "/login")).toBe("/login");
  });

  // Belt-and-braces: whatever survives must actually resolve inside our own origin.
  it("never returns a value that resolves outside the app's origin", () => {
    const hostile = [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "///evil.example",
      "\\\\evil.example",
      "/\u0000/evil.example",
      "http:evil.example",
      "/ /evil.example",
      "/%09/evil.example",
      "/.//evil.example",
    ];
    for (const candidate of hostile) {
      const resolved = new URL(safeInternalPath(candidate), ORIGIN);
      expect(resolved.origin, JSON.stringify(candidate)).toBe(ORIGIN);
    }
  });
});
