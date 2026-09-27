import { z } from "zod";

/**
 * The browser's `PushSubscription` is never trusted or passed through the application layers
 * as-is (it is a browser-native object with methods like `toJSON()`, not plain data). The
 * client normalizes it into exactly these three strings before it ever reaches a Server
 * Action — see `src/lib/push/push-client.ts` for that normalization. `z.strictObject` refuses
 * anything else the client might attach (a `userId`, for instance): ownership always comes
 * from the authenticated session, never from the payload, so a client-supplied identity field
 * is rejected outright rather than silently ignored — the same posture
 * `rescheduleTaskInputSchema` uses.
 *
 * `p256dh`/`authKey` are base64url-encoded binary keys (an EC point and a random secret,
 * respectively); the regex rejects anything that isn't base64url-shaped, and the length bounds
 * are generous (real values are far shorter) rather than exact, since the precise byte lengths
 * are an implementation detail of the browser's push encryption, not a contract this schema
 * should hard-code.
 */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const pushSubscriptionInputSchema = z.strictObject(
  {
    endpoint: z.url().max(2048),
    p256dh: z.string().regex(BASE64URL, "Must be base64url-encoded.").min(16).max(256),
    authKey: z.string().regex(BASE64URL, "Must be base64url-encoded.").min(8).max(256),
  },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? "Only endpoint, p256dh and authKey are accepted."
        : undefined,
  },
);

export type PushSubscriptionInput = z.infer<typeof pushSubscriptionInputSchema>;

/** Revocation needs only the endpoint to name which subscription — never a client-supplied id
 *  or owner. */
export const revokePushSubscriptionInputSchema = z.strictObject(
  { endpoint: z.url().max(2048) },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys" ? "Only endpoint is accepted." : undefined,
  },
);

export type RevokePushSubscriptionInput = z.infer<typeof revokePushSubscriptionInputSchema>;
