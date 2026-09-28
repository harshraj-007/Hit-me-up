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
    ...fs.readFileSync(file, "utf8").matchAll(/(?<!\.)(?:from|import)\s*\(?\s*["']([^"']+)["']/g),
  ].map((m) => m[1]!);

describe("Phase 6.3 delivery boundaries", () => {
  const files = walk(SRC);
  const nonTestFiles = files.filter(nonTest);

  it("only web-push-provider.ts imports the web-push library", () => {
    const offenders = nonTestFiles.filter((f) => imports(f).some((i) => i === "web-push")).map(rel);
    expect(offenders).toEqual([path.join("server", "notifications", "web-push-provider.ts")]);
  });

  it("no route or Server Action calls the delivery/scheduler services directly — only the cron route does", () => {
    const offenders = nonTestFiles
      .filter((f) => rel(f) !== path.join("app", "api", "cron", "notifications", "route.ts"))
      .filter((f) => rel(f) !== path.join("server", "services", "notification-scheduler.ts"))
      .filter((f) =>
        imports(f).some(
          (i) =>
            i.endsWith("/notification-scheduler") ||
            i.endsWith("/notification-delivery") ||
            i === "./notification-scheduler" ||
            i === "./notification-delivery",
        ),
      )
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("no user-facing code (features/app/components/lib) imports the delivery pipeline or the service-role client", () => {
    const offenders = nonTestFiles
      .filter((f) => /^(components|features|lib)/.test(rel(f)))
      .filter((f) =>
        imports(f).some(
          (i) =>
            i.includes("notification-delivery") ||
            i.includes("notification-scheduler") ||
            i.includes("web-push-provider") ||
            i.includes("supabase-service-role"),
        ),
      )
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("AI planning/confirmation code never imports any Phase 6 notification/delivery/service-role module", () => {
    const aiFiles = [
      "server/services/ai-planning.ts",
      "server/services/ai-confirmation.ts",
      "server/ai/anthropic.ts",
    ].map((p) => path.join(SRC, p));
    for (const f of aiFiles) {
      const bad = imports(f).filter(
        (i) =>
          i.includes("notification") ||
          i.includes("push-subscription") ||
          i.includes("web-push") ||
          i.includes("service-role") ||
          i.includes("scheduled-notifications"),
      );
      expect(bad, rel(f)).toEqual([]);
    }
    for (const f of nonTestFiles.filter((f) =>
      rel(f).startsWith(path.join("domain", "ai-planning")),
    )) {
      const bad = imports(f).filter((i) => i.includes("notification") || i.includes("push"));
      expect(bad, rel(f)).toEqual([]);
    }
  });

  it("process.env.VAPID_PRIVATE_KEY is read in exactly one place: env.server.ts", () => {
    // Checks the actual READ (`process.env.VAPID_PRIVATE_KEY`), not the bare name — redact.ts
    // legitimately mentions the name in a doc comment explaining why it's redacted, which is
    // not a read and is exactly the kind of file that should be allowed to reference it.
    const offenders = nonTestFiles
      .filter((f) => rel(f) !== path.join("config", "env.server.ts"))
      .filter((f) => fs.readFileSync(f, "utf8").includes("process.env.VAPID_PRIVATE_KEY"))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("CRON_SECRET is read in exactly one place: env.server.ts", () => {
    const offenders = nonTestFiles
      .filter((f) => rel(f) !== path.join("config", "env.server.ts"))
      .filter((f) => fs.readFileSync(f, "utf8").includes("process.env.CRON_SECRET"))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("the VAPID private key never appears in a NEXT_PUBLIC_ variable name anywhere", () => {
    // Application code only — this file's own text necessarily contains the pattern it checks
    // for (in the regex literal below), so checking test files here would just self-match.
    for (const f of nonTestFiles) {
      expect(fs.readFileSync(f, "utf8"), rel(f)).not.toMatch(/NEXT_PUBLIC_VAPID_PRIVATE/);
    }
  });

  it("no file constructs (calls) a service-role client outside src/server/db and the notification services", () => {
    // Matches an actual CALL — `createSupabaseServiceRoleClient(` — not a doc-comment mention
    // of the name, which several files (including this one's own neighbors) legitimately have.
    const allowed = new Set([
      path.join("server", "db", "supabase-service-role.ts"),
      path.join("server", "services", "notification-scheduler.ts"),
      path.join("server", "services", "notification-delivery.ts"),
    ]);
    const offenders = nonTestFiles
      .filter((f) => !allowed.has(rel(f)))
      .filter((f) => fs.readFileSync(f, "utf8").includes("createSupabaseServiceRoleClient("))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
