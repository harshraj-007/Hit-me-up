import "server-only";
import { z } from "zod";
import { describeIssues, EnvError, getPublicEnv, type PublicEnv } from "./env.public";

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  // AI is optional: the app runs without these (see getAiConfig).
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).optional(),
  // Phase 6.2: gates POST /api/cron/notifications. Optional like everything else here — the
  // route fails closed (401) whether it's merely unset or the caller got it wrong; neither is
  // ever distinguished externally (see getCronSecret()).
  CRON_SECRET: z.string().min(1).optional(),
  // Phase 6.3: Web Push delivery. Server-only, like the AI keys — never read via getServerEnv()
  // (see getWebPushConfig()); declared here only so the full server contract stays visible.
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  VAPID_SUBJECT: z.string().min(1).optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema> & PublicEnv;

let cached: ServerEnv | undefined;

/** Server-only configuration (includes public values). Never import from client code. */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  const result = serverEnvSchema.safeParse({
    NODE_ENV: process.env.NODE_ENV,
    LOG_LEVEL: process.env.LOG_LEVEL || undefined,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || undefined,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || undefined,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || undefined,
  });
  if (!result.success) throw new EnvError(describeIssues("server", result.error));
  cached = { ...result.data, ...getPublicEnv() };
  return cached;
}

/** Logging must work even when env is broken, so it reads only its own variables. */
export function getLogLevel(): ServerEnv["LOG_LEVEL"] {
  const parsed = serverEnvSchema.shape.LOG_LEVEL.safeParse(process.env.LOG_LEVEL || undefined);
  return parsed.success ? parsed.data : "info";
}

export interface AiConfig {
  apiKey: string;
  model: string;
}

/**
 * The AI provider configuration, or `null` when it is not (fully) configured. Like
 * `getLogLevel` it reads ONLY its own variables, so a missing Supabase setting can't break it
 * and a missing AI setting can't break anything else. It never throws and never returns a
 * partial config: both the key and the model must be present.
 */
export function getAiConfig(): AiConfig | null {
  const parsed = serverEnvSchema
    .pick({ ANTHROPIC_API_KEY: true, ANTHROPIC_MODEL: true })
    .safeParse({
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL?.trim() || undefined,
    });
  if (!parsed.success) return null;
  const { ANTHROPIC_API_KEY: apiKey, ANTHROPIC_MODEL: model } = parsed.data;
  return apiKey && model ? { apiKey, model } : null;
}

/**
 * The shared secret `POST /api/cron/notifications` requires, or `null` if unset. Like
 * `getAiConfig`, reads only its own variable and never throws. Vercel Cron sends this exact
 * value as `Authorization: Bearer <CRON_SECRET>` when the env var is configured, which is the
 * convention the route checks against (see `src/server/auth/cron.ts`).
 */
export function getCronSecret(): string | null {
  const value = process.env.CRON_SECRET?.trim();
  return value ? value : null;
}

/**
 * The service-role key, or `null` if unset — read directly, like `getCronSecret`/`getAiConfig`,
 * rather than through `getServerEnv()`'s cached bundle: that cache is a singleton for the
 * process's lifetime, which is exactly wrong for something `createSupabaseServiceRoleClient`
 * needs to re-check fresh every call (and makes unit tests that stub the env between cases
 * predictably fail otherwise). Only `createSupabaseServiceRoleClient` calls this — nothing
 * else needs the service-role key at all.
 */
export function getServiceRoleKey(): string | null {
  const value = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return value ? value : null;
}

export interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * The full VAPID configuration Web Push delivery needs, or `null` unless ALL THREE of the
 * public key (already client-safe since Phase 6.1 — `NEXT_PUBLIC_VAPID_PUBLIC_KEY`), the
 * private key, and the subject are present — the same all-or-nothing posture `getAiConfig`
 * uses, and for the same reason: a partial config is worse than none, since it would let the
 * delivery service start up believing it can send and fail on the first real call instead.
 * Reads its own variables directly, uncached, like `getCronSecret`/`getServiceRoleKey` — so
 * tests can stub fake, non-production values freely between cases. Never throws.
 */
export function getWebPushConfig(): WebPushConfig | null {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}
