import { describe, expect, it } from "vitest";
import { pushSubscriptionInputSchema, revokePushSubscriptionInputSchema } from "./push";

const VALID = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  p256dh: "BNcRd" + "A".repeat(80),
  authKey: "abcDEF012_-",
};

describe("pushSubscriptionInputSchema", () => {
  it("accepts a valid subscription payload", () => {
    expect(pushSubscriptionInputSchema.parse(VALID)).toEqual(VALID);
  });

  it("rejects a malformed endpoint (not a URL)", () => {
    expect(() => pushSubscriptionInputSchema.parse({ ...VALID, endpoint: "not-a-url" })).toThrow();
  });

  it("rejects an endpoint over the length bound", () => {
    const endpoint = "https://example.com/" + "a".repeat(2048);
    expect(() => pushSubscriptionInputSchema.parse({ ...VALID, endpoint })).toThrow();
  });

  it("rejects a missing p256dh", () => {
    expect(() =>
      pushSubscriptionInputSchema.parse({ endpoint: VALID.endpoint, authKey: VALID.authKey }),
    ).toThrow();
  });

  it("rejects an empty p256dh", () => {
    expect(() => pushSubscriptionInputSchema.parse({ ...VALID, p256dh: "" })).toThrow();
  });

  it("rejects a missing auth key", () => {
    expect(() =>
      pushSubscriptionInputSchema.parse({ endpoint: VALID.endpoint, p256dh: VALID.p256dh }),
    ).toThrow();
  });

  it("rejects an empty auth key", () => {
    expect(() => pushSubscriptionInputSchema.parse({ ...VALID, authKey: "" })).toThrow();
  });

  it("rejects non-base64url characters in p256dh", () => {
    expect(() =>
      pushSubscriptionInputSchema.parse({ ...VALID, p256dh: "not base64url!!" }),
    ).toThrow();
  });

  it("rejects non-base64url characters in authKey", () => {
    expect(() =>
      pushSubscriptionInputSchema.parse({ ...VALID, authKey: "has spaces here" }),
    ).toThrow();
  });

  it("rejects wrong types for every field", () => {
    expect(() => pushSubscriptionInputSchema.parse({ ...VALID, endpoint: 123 })).toThrow();
    expect(() => pushSubscriptionInputSchema.parse({ ...VALID, p256dh: null })).toThrow();
    expect(() => pushSubscriptionInputSchema.parse({ ...VALID, authKey: {} })).toThrow();
  });

  it("rejects an unrecognized field — a client cannot smuggle a userId or anything else through", () => {
    expect(() => pushSubscriptionInputSchema.parse({ ...VALID, userId: "attacker" })).toThrow(
      /Only endpoint, p256dh and authKey are accepted/,
    );
  });

  it("rejects the raw browser PushSubscription shape (keys.p256dh/keys.auth), not the normalized one", () => {
    expect(() =>
      pushSubscriptionInputSchema.parse({
        endpoint: VALID.endpoint,
        keys: { p256dh: VALID.p256dh, auth: VALID.authKey },
      }),
    ).toThrow();
  });

  it("rejects a completely unexpected structure", () => {
    expect(() => pushSubscriptionInputSchema.parse("just a string")).toThrow();
    expect(() => pushSubscriptionInputSchema.parse(null)).toThrow();
    expect(() => pushSubscriptionInputSchema.parse([VALID])).toThrow();
  });
});

describe("revokePushSubscriptionInputSchema", () => {
  it("accepts an endpoint only", () => {
    expect(revokePushSubscriptionInputSchema.parse({ endpoint: VALID.endpoint })).toEqual({
      endpoint: VALID.endpoint,
    });
  });

  it("rejects a client-supplied identity field alongside the endpoint", () => {
    expect(() =>
      revokePushSubscriptionInputSchema.parse({ endpoint: VALID.endpoint, userId: "attacker" }),
    ).toThrow(/Only endpoint is accepted/);
  });

  it("rejects a missing or malformed endpoint", () => {
    expect(() => revokePushSubscriptionInputSchema.parse({})).toThrow();
    expect(() => revokePushSubscriptionInputSchema.parse({ endpoint: "not-a-url" })).toThrow();
  });
});
