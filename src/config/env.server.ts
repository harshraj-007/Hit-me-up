import "server-only";
import { z } from "zod";
import { describeIssues, EnvError, getPublicEnv, type PublicEnv } from "./env.public";

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
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
