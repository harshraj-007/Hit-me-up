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
