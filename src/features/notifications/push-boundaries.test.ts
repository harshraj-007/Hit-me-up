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

// Doc comments in this codebase routinely NAME the things a file must never do, to say exactly
// that they don't happen (e.g. "no direct browser API call", "rather than calling
// `Notification.requestPermission()` itself"). Scanning raw source text for those same names
// self-matches its own explanation — the same pitfall `delivery-boundaries.test.ts` (Phase 6.3)
// and `service-worker.test.ts` (Phase 6.4) hit and fixed. These checks strip comments first, so
// only actual code is scanned.
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const files = walk(SRC);
const clientPushFiles = files.filter(
  (f) =>
    (rel(f).startsWith(path.join("features", "notifications")) ||
      rel(f).startsWith(path.join("lib", "push"))) &&
    nonTest(f),
);

/**
 * Phase 6.5 client-boundary review: the browser-side notification UI must reach
 * `push_subscriptions` only through the existing Server Action → service → repository →
 * SECURITY DEFINER RPC chain Phase 6.1 built, never directly, and must never hold anything the
 * server alone is trusted with. These are structural checks (they scan source text), the same
 * style `lib/voice/boundaries.test.ts` and `server/notifications/delivery-boundaries.test.ts`
 * already use for the same reason: the property being guarded ("there is no Supabase client
 * here") is best proven by showing the code that could violate it doesn't exist.
 */
describe("client push code never writes to the database directly", () => {
  it("no feature/lib push file imports the Supabase client or a repository directly", () => {
    for (const f of clientPushFiles) {
      const source = fs.readFileSync(f, "utf8");
      expect(source, rel(f)).not.toMatch(/@supabase\/|@\/server\/db\//);
    }
  });

  it("no feature/lib push file calls an RPC directly (a doc comment naming one is fine — only an actual `.rpc(...)` invocation is not)", () => {
    for (const f of clientPushFiles) {
      expect(fs.readFileSync(f, "utf8"), rel(f)).not.toMatch(/\.rpc\(/);
    }
  });

  it("registerPushSubscriptionAction/revokePushSubscriptionAction are called only from push-notification-flow.ts, never directly from a component", () => {
    const componentFiles = clientPushFiles.filter((f) => f.endsWith(".tsx"));
    for (const f of componentFiles) {
      const source = fs.readFileSync(f, "utf8");
      expect(source, rel(f)).not.toMatch(
        /registerPushSubscriptionAction\(|revokePushSubscriptionAction\(/,
      );
    }
  });
});

describe("client push code holds no credentials and no server-only configuration", () => {
  it("holds no service-role, VAPID private key, CRON_SECRET, or generic credential-shaped string", () => {
    for (const f of clientPushFiles) {
      const source = fs.readFileSync(f, "utf8");
      expect(source, rel(f)).not.toMatch(
        /service[-_]?role|vapid_private|cron_secret|SUPABASE_SERVICE_ROLE_KEY/i,
      );
    }
  });

  it("reads no server-only environment variable (only the client-safe NEXT_PUBLIC_VAPID_PUBLIC_KEY, via getVapidPublicKey())", () => {
    for (const f of clientPushFiles) {
      const source = fs.readFileSync(f, "utf8");
      const envReads = source.match(/process\.env\.(\w+)/g) ?? [];
      for (const read of envReads) {
        expect(read, `${rel(f)}: ${read}`).toMatch(/NEXT_PUBLIC_/);
      }
    }
  });

  it("never persists a raw browser PushSubscription/access/refresh token via localStorage or sessionStorage", () => {
    for (const f of clientPushFiles) {
      const source = fs.readFileSync(f, "utf8");
      expect(source, rel(f)).not.toMatch(/localStorage|sessionStorage/);
    }
  });
});

describe("no user id is ever treated as an ownership authority on the client", () => {
  it("no feature/lib push file references a userId/user_id concept — ownership comes only from the authenticated server session", () => {
    for (const f of clientPushFiles) {
      const source = fs.readFileSync(f, "utf8");
      expect(source, rel(f)).not.toMatch(/\buserId\b|\buser_id\b/);
    }
  });
});

describe("Notification.requestPermission is called from exactly one place, never on mount", () => {
  it("only push-client.ts's subscribeToPush calls Notification.requestPermission", () => {
    const callSites = clientPushFiles.flatMap((f) => {
      const source = codeOnly(fs.readFileSync(f, "utf8"));
      const matches = source.match(/Notification\.requestPermission\(/g) ?? [];
      return matches.map(() => rel(f));
    });
    expect(callSites).toEqual([path.join("lib", "push", "push-client.ts")]);
  });

  it("the mount-time effect in use-push-notifications.ts never calls requestPermission — it only reads Notification.permission", () => {
    const source = fs.readFileSync(
      path.join(SRC, "features", "notifications", "use-push-notifications.ts"),
      "utf8",
    );
    const effectStart = source.indexOf("useEffect(() => {");
    const effectEnd = source.indexOf("}, []);", effectStart);
    const effectBody = source.slice(effectStart, effectEnd);
    expect(effectBody).not.toMatch(/requestPermission/);
    expect(effectBody).toMatch(/Notification\.permission/);
  });

  it("stateAfterMountCheck (push-notification-flow.ts) references no browser global at all — mount-derived state is a pure function of already-observed values", () => {
    const source = codeOnly(
      fs.readFileSync(
        path.join(SRC, "features", "notifications", "push-notification-flow.ts"),
        "utf8",
      ),
    );
    expect(source).not.toMatch(/\bNotification\b\.|navigator\.|window\./);
  });
});
