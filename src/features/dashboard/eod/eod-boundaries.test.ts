import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..", "..", "..");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}
const rel = (p: string) => path.relative(SRC, p);
const nonTest = (p: string) => !/\.test\.tsx?$/.test(p);
const read = (p: string) => fs.readFileSync(p, "utf8");
// Prose comments routinely NAME what a file must never do ("no Supabase client here"); scanning raw
// text would self-match them (the pitfall the Phase 6 boundary tests hit), so only code is scanned.
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
const imports = (p: string) =>
  [...code(p).matchAll(/(?<!\.)(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);

const all = walk(SRC).filter(nonTest);
const inDir = (...parts: string[]) => all.filter((f) => rel(f).startsWith(path.join(...parts)));

const uiFiles = inDir("features", "dashboard", "eod");
const domainFiles = inDir("domain", "eod");
const aiFiles = ["eod-port.ts", "eod-prompt.ts", "anthropic-eod.ts", "generate-eod.ts"].map((f) =>
  path.join(SRC, "server", "ai", f),
);

/**
 * Phase 7 boundaries. The end-of-day review is a READ-AND-REPORT layer: it may read the day's
 * facts, ask a model to interpret them, and store one append-only report row. These are structural
 * (they scan source) because "nothing here can write a task" is best proven by showing the code
 * that could doesn't exist.
 */
describe("the review UI reaches the server only through its one Server Action", () => {
  it("the panel imports no repository, Supabase client, service, or environment (only actions.ts may reach the service)", () => {
    for (const f of uiFiles.filter((u) => !u.endsWith("actions.ts"))) {
      for (const i of imports(f)) {
        expect(i, rel(f)).not.toMatch(
          /@supabase\/|@\/server\/db|@\/server\/services|@\/server\/ai/,
        );
      }
      expect(code(f), rel(f)).not.toMatch(/process\.env|\.rpc\(|localStorage|sessionStorage/);
    }
  });

  it("the Server Action takes NO input: no date, day id or user id for a client to name", () => {
    const action = code(path.join(SRC, "features", "dashboard", "eod", "actions.ts"));
    expect(action).toMatch(/export async function generateEodReportAction\(\)/);
    expect(action).not.toMatch(/\bunknown\b|input|date|userId|dayId/i);
  });

  it("only the action file and the Today snapshot import the EOD service", () => {
    const importers = all
      .filter((f) => imports(f).some((i) => /(^|\/)eod-report$/.test(i)))
      .map(rel)
      .sort();
    expect(importers).toEqual(
      [
        path.join("features", "dashboard", "eod", "actions.ts"),
        path.join("server", "services", "today.ts"),
      ].sort(),
    );
  });
});

describe("the model layer can only interpret — it never sees a repository", () => {
  it("the EOD provider modules import no repository, service, Supabase client, or notification code", () => {
    for (const f of aiFiles) {
      for (const i of imports(f)) {
        expect(i, rel(f)).not.toMatch(
          /@supabase\/|@\/server\/db|@\/server\/services|@\/server\/notifications|supabase-service-role|web-push/,
        );
      }
    }
  });

  it("only anthropic.ts imports the Anthropic SDK — the new adapter goes through it", () => {
    const offenders = all.filter((f) => imports(f).includes("@anthropic-ai/sdk")).map(rel);
    expect(offenders).toEqual([path.join("server", "ai", "anthropic.ts")]);
  });

  it("the service-role client is never reachable from the review path", () => {
    for (const f of [
      ...aiFiles,
      ...uiFiles,
      path.join(SRC, "server", "services", "eod-report.ts"),
    ]) {
      expect(code(f), rel(f)).not.toMatch(/service[-_]?role|createSupabaseServiceRoleClient/i);
    }
  });
});

describe("the review never writes or schedules anything but its own report", () => {
  it("the EOD service imports only READ functions from the task, history and revision repositories", () => {
    const service = code(path.join(SRC, "server", "services", "eod-report.ts"));
    for (const writer of [
      "createTask",
      "changeTaskStatus",
      "rescheduleTask",
      "applyReplan",
      "confirmAiProposal",
      "createAiProposal",
      "ensureDay",
      "resolveCurrentDay",
      "resolveDayForDate",
    ]) {
      expect(service, writer).not.toMatch(new RegExp(`\\b${writer}\\b`));
    }
    expect(service).toMatch(/\bcreateEodReport\b/); // its own single, append-only write
  });

  it("nothing in the notification pipeline imports the review, and the review imports none of it", () => {
    const notificationish = all.filter((f) =>
      /notification|push|web-push|scheduler|delivery/i.test(rel(f)),
    );
    for (const f of notificationish) {
      expect(
        imports(f).filter((i) => /eod/i.test(i)),
        rel(f),
      ).toEqual([]);
    }
    for (const f of [
      ...aiFiles,
      ...domainFiles,
      path.join(SRC, "server", "services", "eod-report.ts"),
    ]) {
      expect(
        imports(f).filter((i) => /notification|push|scheduler|delivery/i.test(i)),
        rel(f),
      ).toEqual([]);
    }
  });

  it("the review is not a second scheduler: no cron, timer, or background hook anywhere in it", () => {
    for (const f of [
      ...aiFiles,
      ...uiFiles,
      ...domainFiles,
      path.join(SRC, "server", "services", "eod-report.ts"),
    ]) {
      expect(code(f), rel(f)).not.toMatch(
        /setInterval|setTimeout|\bcron\b|useEffect|\bschedule(?:Job|Task|Notification|Reminder)\w*\(/,
      );
    }
  });
});

describe("the deterministic domain stays pure", () => {
  it("domain/eod imports no server, Supabase, React, or provider code", () => {
    for (const f of domainFiles) {
      for (const i of imports(f)) {
        expect(i, rel(f)).not.toMatch(/@\/server|@supabase\/|^react|@anthropic-ai|next\//);
      }
    }
  });

  it("domain/eod never reads the clock itself — `now` is always passed in", () => {
    for (const f of domainFiles) {
      expect(code(f), rel(f)).not.toMatch(/Date\.now\(|new Date\(\s*\)/);
    }
  });
});
