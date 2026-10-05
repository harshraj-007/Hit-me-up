// Phase 6 wire-level verification: the REAL `web-push` library (VAPID signing + aes128gcm payload
// encryption) talking to a local HTTPS server standing in for a browser push service. Nothing is
// mocked between `sendWebPush` and the socket, so this proves what the unit tests (which mock the
// library at its boundary) cannot: the request is genuinely VAPID-signed with OUR key, the body
// genuinely decrypts to exactly the Phase 6.3 payload contract with no extra field, and each HTTP
// outcome is classified as designed. Uses freshly generated VAPID/subscription keys — never a real
// project key — and a throwaway self-signed certificate (skipped if `openssl` is unavailable).
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendWebPush } from "@/server/notifications/web-push-provider";
import { buildTaskReminderPayload } from "@/lib/notifications/task-reminder-payload";

const require = createRequire(import.meta.url);
const ece = require("http_ece");
const jws = require("jws");

const webpush = require("web-push");
const vapid = webpush.generateVAPIDKeys() as { publicKey: string; privateKey: string };
const config = {
  publicKey: vapid.publicKey,
  privateKey: vapid.privateKey,
  subject: "mailto:wire-test@example.com",
};

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const b64u = (b: Buffer) => b.toString("base64url");
const ecdh = crypto.createECDH("prime256v1");
ecdh.generateKeys();
const authSecret = crypto.randomBytes(16);
const sub = (urlPath: string, port: number) => ({
  endpoint: `https://localhost:${port}${urlPath}`,
  p256dh: b64u(ecdh.getPublicKey()),
  authKey: b64u(authSecret),
});

let server: https.Server;
let port = 0;
const captured: {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}[] = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-live-"));

const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

beforeAll(async () => {
  if (!hasOpenssl) return;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // the throwaway self-signed cert; restored in afterAll
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      path.join(dir, "k.pem"),
      "-out",
      path.join(dir, "c.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
  server = https.createServer(
    {
      key: fs.readFileSync(path.join(dir, "k.pem")),
      cert: fs.readFileSync(path.join(dir, "c.pem")),
    },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        captured.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
        const status =
          { "/ok": 201, "/gone": 410, "/missing": 404, "/busy": 429, "/boom": 500, "/weird": 400 }[
            req.url ?? ""
          ] ?? 500;
        res.statusCode = status;
        res.end("{}");
      });
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
  if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting;
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const payload = buildTaskReminderPayload({
  notificationId: "n-1",
  taskId: "t-1",
  taskTitle: "DSA practice",
  scheduledStart: new Date("2026-10-06T10:00:00Z"),
});

describe.skipIf(!hasOpenssl)(
  "wire-level Web Push provider path (real web-push, local push service)",
  () => {
    it("201 → success; request is VAPID-signed with OUR key and the body decrypts to exactly the payload", async () => {
      const result = await sendWebPush(config, sub("/ok", port), payload);
      expect(result).toEqual({ outcome: "success", statusCode: 201 });

      const req = captured.find((c) => c.path === "/ok")!;
      expect(req.headers["content-encoding"]).toBe("aes128gcm");
      expect(req.headers.ttl).toBe("900");
      const auth = String(req.headers.authorization);
      expect(auth).toMatch(/^vapid t=.+, k=.+$/);
      const [, token, key] = /^vapid t=(.+), k=(.+)$/.exec(auth)!;
      expect(key).toBe(config.publicKey);
      // JWT verifies against the public key (ES256), subject is the configured one, aud is the push service origin.
      const pem = crypto
        .createPublicKey({
          key: Buffer.concat([
            Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
            Buffer.from(config.publicKey, "base64url"),
          ]),
          format: "der",
          type: "spki",
        })
        .export({ type: "spki", format: "pem" }) as string;
      expect(jws.verify(token, "ES256", pem)).toBe(true);
      const claims = JSON.parse(Buffer.from(token!.split(".")[1]!, "base64url").toString());
      expect(claims.sub).toBe(config.subject);
      expect(claims.aud).toBe(`https://localhost:${port}`);

      const plain = ece.decrypt(req.body, { version: "aes128gcm", privateKey: ecdh, authSecret });
      const decoded = JSON.parse(plain.toString());
      expect(decoded).toEqual(payload);
      // Privacy: exactly the contract's fields, nothing else, and no credential-shaped text.
      expect(Object.keys(decoded).sort()).toEqual(
        ["body", "notificationId", "scheduledStart", "taskId", "title", "type", "url"].sort(),
      );
      expect(plain.toString()).not.toMatch(/user|email|token|secret|vapid|notes|p256dh/i);
      expect(plain.length).toBeLessThan(1024);
    });

    it("410 and 404 → permanently_invalid; 429, 500 and an unexpected 400 → transient_failure", async () => {
      expect((await sendWebPush(config, sub("/gone", port), payload)).outcome).toBe(
        "permanently_invalid",
      );
      expect((await sendWebPush(config, sub("/missing", port), payload)).outcome).toBe(
        "permanently_invalid",
      );
      expect((await sendWebPush(config, sub("/busy", port), payload)).outcome).toBe(
        "transient_failure",
      );
      expect((await sendWebPush(config, sub("/boom", port), payload)).outcome).toBe(
        "transient_failure",
      );
      expect((await sendWebPush(config, sub("/weird", port), payload)).outcome).toBe(
        "transient_failure",
      );
    });

    it("an unreachable push service (connection refused) is transient, never permanent", async () => {
      const result = await sendWebPush(config, sub("/ok", 1), payload);
      expect(result.outcome).toBe("transient_failure");
      expect(result.statusCode).toBeUndefined();
    });
  },
);
