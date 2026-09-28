import { describe, expect, it } from "vitest";
import { redact, redactString } from "./redact";

describe("redact", () => {
  it("masks sensitive keys at any depth", () => {
    const out = redact({
      userId: "u1",
      apiKey: "abc",
      nested: { Authorization: "Bearer xyz", password: "p", safe: 1 },
      list: [{ token: "t" }],
    });
    expect(out).toEqual({
      userId: "u1",
      apiKey: "[REDACTED]",
      nested: { Authorization: "[REDACTED]", password: "[REDACTED]", safe: 1 },
      list: [{ token: "[REDACTED]" }],
    });
  });

  it("scrubs secret-shaped strings in otherwise innocent fields", () => {
    expect(redactString("failed with sk-ant-api03-AbC_123 and Bearer abc.def")).toBe(
      "failed with [REDACTED] and Bearer [REDACTED]",
    );
  });

  it("handles circular references", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(redact(a)).toEqual({ name: "a", self: "[CIRCULAR]" });
  });

  it("masks provider secrets and model content by key", () => {
    const out = redact({
      apiKey: "a",
      api_key: "b",
      "x-api-key": "c",
      authorization: "d",
      prompt: "e",
      completion: "f",
      provider: "anthropic",
      latencyMs: 12,
    }) as Record<string, unknown>;
    for (const key of ["apiKey", "api_key", "x-api-key", "authorization", "prompt", "completion"]) {
      expect(out[key]).toBe("[REDACTED]");
    }
    expect(out.provider).toBe("anthropic");
    expect(out.latencyMs).toBe(12);
  });

  it("masks a voice transcript and audio-related fields by key, wherever they appear", () => {
    const out = redact({
      transcript: "move gym after 8pm",
      transcriptText: "move gym after 8pm",
      audioBlob: "base64...",
      audioDurationMs: 4200,
      voice: { transcript: "nested transcript" },
    }) as Record<string, unknown>;
    expect(out.transcript).toBe("[REDACTED]");
    expect(out.transcriptText).toBe("[REDACTED]");
    expect(out.audioBlob).toBe("[REDACTED]");
    expect(out.audioDurationMs).toBe("[REDACTED]"); // "audio" alone is enough to mask the key
    expect((out.voice as Record<string, unknown>).transcript).toBe("[REDACTED]");
  });

  it("masks Web Push subscription credentials by key, wherever they appear (Phase 6.1)", () => {
    const out = redact({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
      p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA",
      auth_key: "tBHItJI5svbpez7KI4CCXg",
      authKey: "tBHItJI5svbpez7KI4CCXg",
      subscription: { endpoint: "nested", p256dh: "nested" },
      userId: "u1",
    }) as Record<string, unknown>;
    expect(out.endpoint).toBe("[REDACTED]");
    expect(out.p256dh).toBe("[REDACTED]");
    expect(out.auth_key).toBe("[REDACTED]");
    expect(out.authKey).toBe("[REDACTED]");
    expect((out.subscription as Record<string, unknown>).endpoint).toBe("[REDACTED]");
    expect((out.subscription as Record<string, unknown>).p256dh).toBe("[REDACTED]");
    expect(out.userId).toBe("u1"); // an id is fine; the point is the credentials, not the row
  });

  it("redacts endpoint and p256dh even inside a raw, unnormalized browser subscription shape", () => {
    // The browser's own PushSubscriptionJSON nests keys as `{ p256dh, auth }` — note `auth`,
    // not this app's `authKey`. `endpoint`/`p256dh` are still caught by key name at any depth;
    // a bare `auth` is NOT (it would also match "authorization"-family false positives if it
    // were added, e.g. any unrelated "author" field), which is exactly why the application
    // never logs this raw shape at all — `normalizeSubscription` (src/lib/push/push-client.ts)
    // converts it to `{ endpoint, p256dh, authKey }` before it crosses any boundary, and
    // `authKey`/`auth_key` ARE covered (see the test above). This test documents that residual
    // gap deliberately, rather than leaving it undiscovered.
    const rawBrowserShape = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
      expirationTime: null,
      keys: { p256dh: "P", auth: "A" },
    };
    const out = redact({ subscription: rawBrowserShape }) as Record<string, unknown>;
    const nested = out.subscription as Record<string, unknown>;
    expect(nested.endpoint).toBe("[REDACTED]");
    expect((nested.keys as Record<string, unknown>).p256dh).toBe("[REDACTED]");
  });

  it("masks the service-role key and CRON_SECRET by key, wherever they appear (Phase 6.2)", () => {
    const out = redact({
      SUPABASE_SERVICE_ROLE_KEY: "srk_secret",
      serviceRoleKey: "srk_secret",
      cronSecret: "cron_secret",
      CRON_SECRET: "cron_secret",
      claimedCount: 3,
    }) as Record<string, unknown>;
    expect(out.SUPABASE_SERVICE_ROLE_KEY).toBe("[REDACTED]");
    expect(out.serviceRoleKey).toBe("[REDACTED]");
    expect(out.cronSecret).toBe("[REDACTED]");
    expect(out.CRON_SECRET).toBe("[REDACTED]");
    expect(out.claimedCount).toBe(3); // operational metadata is fine — the point is the secrets
  });

  it("masks the VAPID private key by key, but never the public one (Phase 6.3)", () => {
    const out = redact({
      VAPID_PRIVATE_KEY: "priv_secret",
      privateKey: "priv_secret",
      NEXT_PUBLIC_VAPID_PUBLIC_KEY: "pub_safe_to_log",
      publicKey: "pub_safe_to_log",
    }) as Record<string, unknown>;
    expect(out.VAPID_PRIVATE_KEY).toBe("[REDACTED]");
    expect(out.privateKey).toBe("[REDACTED]");
    // The public key is deliberately NOT redacted — it's meant for the browser, not a secret.
    expect(out.NEXT_PUBLIC_VAPID_PUBLIC_KEY).toBe("pub_safe_to_log");
    expect(out.publicKey).toBe("pub_safe_to_log");
  });

  it("masks delivery-result metadata only where it's actually sensitive (Phase 6.3)", () => {
    const out = redact({
      notificationId: "n1",
      taskId: "t1",
      subscriptionId: "s1",
      statusCode: 410,
      attemptNumber: 2,
      outcome: "permanently_invalid",
    }) as Record<string, unknown>;
    // None of these are secrets — ids, status codes and outcomes are safe operational metadata.
    expect(out).toEqual({
      notificationId: "n1",
      taskId: "t1",
      subscriptionId: "s1",
      statusCode: 410,
      attemptNumber: 2,
      outcome: "permanently_invalid",
    });
  });
});
