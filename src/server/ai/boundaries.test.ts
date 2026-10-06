import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..", "..");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}
const rel = (p: string) => path.relative(SRC, p);
const nonTest = (p: string) => !/\.test\.tsx?$/.test(p);
const imports = (file: string) =>
  [
    ...fs
      .readFileSync(file, "utf8")
      // A negative lookbehind for "." excludes Supabase's `.from("table")` query builder,
      // which this pattern would otherwise conflate with an ES `... from "module"` import.
      .matchAll(/(?<!\.)(?:from|import)\s*\(?\s*["']([^"']+)["']/g),
  ].map((m) => m[1]!);

describe("import boundaries", () => {
  const files = walk(SRC);

  it("only server/ai/anthropic.ts imports the Anthropic SDK (tests may, to build real error shapes)", () => {
    const offenders = files
      .filter(nonTest)
      .filter((f) => imports(f).some((i) => i.startsWith("@anthropic-ai/")))
      .map(rel);
    expect(offenders).toEqual([path.join("server", "ai", "anthropic.ts")]);
  });

  it("no other AI SDK is present", () => {
    for (const f of files) {
      expect(
        imports(f).filter((i) =>
          /^(openai|@google\/genai|@google\/generative-ai|ai|@ai-sdk\/)/.test(i),
        ),
      ).toEqual([]);
    }
  });

  it("pure domain modules import no SDK, server, env, or Supabase code", () => {
    for (const f of files.filter((f) => rel(f).startsWith("domain") && nonTest(f))) {
      const bad = imports(f).filter(
        (i) =>
          i === "server-only" ||
          i.startsWith("@anthropic-ai/") ||
          i.startsWith("@supabase/") ||
          i.startsWith("@/server") ||
          i.startsWith("@/config"),
      );
      expect(bad, rel(f)).toEqual([]);
    }
  });

  it("the provider layer never reaches the database or repositories", () => {
    for (const f of files.filter(
      (f) => rel(f).startsWith(path.join("server", "ai")) && nonTest(f),
    )) {
      const bad = imports(f).filter(
        (i) =>
          i.startsWith("@supabase/") ||
          i.startsWith("@/server/db") ||
          i.startsWith("@/server/services"),
      );
      expect(bad, rel(f)).toEqual([]);
    }
  });

  it("client code never imports the AI layer or reads the Anthropic variables", () => {
    for (const f of files.filter(
      (f) => /^(components|features|app|lib)/.test(rel(f)) && nonTest(f),
    )) {
      expect(
        imports(f).filter((i) => i.startsWith("@/server/ai")),
        rel(f),
      ).toEqual([]);
      expect(fs.readFileSync(f, "utf8"), rel(f)).not.toMatch(/ANTHROPIC_/);
    }
  });

  it("the API key is never read from a NEXT_PUBLIC variable", () => {
    for (const f of files)
      expect(fs.readFileSync(f, "utf8"), rel(f)).not.toMatch(
        new RegExp("NEXT_PUBLIC_" + "ANTHROPIC"),
      );
  });

  it("the AI proposal service is read-only: no writes, RPCs, or mutating repository functions", () => {
    const source = fs.readFileSync(path.join(SRC, "server", "services", "ai-planning.ts"), "utf8");
    for (const forbidden of [
      "ensureDay",
      "createTask",
      "changeTaskStatus",
      "rescheduleTask",
      "applyReplan",
      ".rpc(",
      ".insert(",
      ".update(",
      ".upsert(",
      ".delete(",
      "service_role",
      "SERVICE_ROLE",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    expect(
      imports(path.join(SRC, "server", "services", "ai-planning.ts")).filter((i) =>
        i.startsWith("@anthropic-ai/"),
      ),
    ).toEqual([]);
  });

  it("the plan-from-briefing service writes only through createAiProposal: no RPC, no direct write, no notification, no service role", () => {
    const file = path.join(SRC, "server", "services", "briefing-plan.ts");
    const source = fs
      .readFileSync(file, "utf8")
      // strip comments: the doc comment legitimately names what the code must not do
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of [
      ".rpc(",
      ".insert(",
      ".update(",
      ".upsert(",
      ".delete(",
      "createTask",
      "changeTaskStatus",
      "rescheduleTask",
      "applyReplan",
      "confirmAiProposal",
      "ensureDay",
      "scheduled_notifications",
      "notification",
      "service_role",
      "SERVICE_ROLE",
      "push",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    expect(imports(file).filter((i) => i.startsWith("@anthropic-ai/"))).toEqual([]);
  });

  it("the briefing AI modules (prompt, port, adapter, parse) never reach the database, repositories or services", () => {
    for (const name of [
      "briefing-prompt.ts",
      "briefing-port.ts",
      "anthropic-briefing.ts",
      "generate-briefing.ts",
    ]) {
      const bad = imports(path.join(SRC, "server", "ai", name)).filter(
        (i) =>
          i.startsWith("@supabase/") ||
          i.startsWith("@/server/db") ||
          i.startsWith("@/server/services"),
      );
      expect(bad, name).toEqual([]);
    }
  });

  it("no browser-side module sends the briefing text: the only briefing-plan action input is a date and an optional note", () => {
    const hook = fs.readFileSync(
      path.join(SRC, "features", "dashboard", "ai-planning", "use-ai-plan-flow.ts"),
      "utf8",
    );
    const calls = hook.match(/generateBriefingPlanAction\(\{[\s\S]*?\}\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).not.toMatch(/briefing\w*\s*[:,]/i);
  });
});
