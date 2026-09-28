import { describe, expect, it, vi } from "vitest";

const { FakeWebPushError, sendNotification } = vi.hoisted(() => {
  class FakeWebPushError extends Error {
    statusCode: number;
    headers = {};
    body = "";
    endpoint = "https://push.example/e1";
    constructor(statusCode: number, message = "push failed") {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return { FakeWebPushError, sendNotification: vi.fn() };
});

vi.mock("web-push", () => ({
  default: { sendNotification, WebPushError: FakeWebPushError },
}));

import { sendWebPush } from "./web-push-provider";

const CONFIG = { publicKey: "pub", privateKey: "priv", subject: "mailto:test@example.test" };
const SUBSCRIPTION = {
  endpoint: "https://push.example/e1",
  p256dh: "p256dh-val",
  authKey: "auth-val",
};
const PAYLOAD = { type: "task_reminder", title: "Task reminder" };

describe("sendWebPush", () => {
  it("sends the exact subscription shape web-push expects (keys.p256dh / keys.auth, not authKey)", async () => {
    sendNotification.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
    await sendWebPush(CONFIG, SUBSCRIPTION, PAYLOAD);
    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint: "https://push.example/e1", keys: { p256dh: "p256dh-val", auth: "auth-val" } },
      JSON.stringify(PAYLOAD),
      expect.objectContaining({
        vapidDetails: {
          subject: CONFIG.subject,
          publicKey: CONFIG.publicKey,
          privateKey: CONFIG.privateKey,
        },
      }),
    );
  });

  it("passes a bounded TTL and request timeout", async () => {
    sendNotification.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
    await sendWebPush(CONFIG, SUBSCRIPTION, PAYLOAD);
    const options = sendNotification.mock.calls[0]?.[2] as { TTL: number; timeout: number };
    expect(options.TTL).toBeGreaterThan(0);
    expect(options.timeout).toBeGreaterThan(0);
  });

  it("serializes the payload as a JSON string, not a raw object", async () => {
    sendNotification.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
    await sendWebPush(CONFIG, SUBSCRIPTION, PAYLOAD);
    const sentPayload = sendNotification.mock.calls[0]?.[1];
    expect(typeof sentPayload).toBe("string");
    expect(JSON.parse(sentPayload as string)).toEqual(PAYLOAD);
  });

  it("classifies a 2xx response as success, with the status code", async () => {
    sendNotification.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
    await expect(sendWebPush(CONFIG, SUBSCRIPTION, PAYLOAD)).resolves.toEqual({
      outcome: "success",
      statusCode: 201,
    });
  });

  it.each([404, 410])("classifies HTTP %s as permanently_invalid", async (statusCode) => {
    sendNotification.mockRejectedValue(new FakeWebPushError(statusCode));
    await expect(sendWebPush(CONFIG, SUBSCRIPTION, PAYLOAD)).resolves.toEqual({
      outcome: "permanently_invalid",
      statusCode,
    });
  });

  it.each([429, 500, 502, 503])(
    "classifies HTTP %s as transient_failure, never permanent",
    async (statusCode) => {
      sendNotification.mockRejectedValue(new FakeWebPushError(statusCode));
      await expect(sendWebPush(CONFIG, SUBSCRIPTION, PAYLOAD)).resolves.toEqual({
        outcome: "transient_failure",
        statusCode,
      });
    },
  );

  it.each([400, 401, 403, 413])(
    "classifies an unrecognized 4xx (%s) as transient_failure, not silently permanent",
    async (statusCode) => {
      sendNotification.mockRejectedValue(new FakeWebPushError(statusCode));
      await expect(sendWebPush(CONFIG, SUBSCRIPTION, PAYLOAD)).resolves.toEqual({
        outcome: "transient_failure",
        statusCode,
      });
    },
  );

  it("classifies a network-level failure (no HTTP status at all) as transient_failure", async () => {
    sendNotification.mockRejectedValue(new Error("ETIMEDOUT"));
    await expect(sendWebPush(CONFIG, SUBSCRIPTION, PAYLOAD)).resolves.toEqual({
      outcome: "transient_failure",
    });
  });

  it("never throws for an ordinary delivery failure", async () => {
    sendNotification.mockRejectedValue(new FakeWebPushError(500));
    await expect(sendWebPush(CONFIG, SUBSCRIPTION, PAYLOAD)).resolves.toBeDefined();
  });
});
