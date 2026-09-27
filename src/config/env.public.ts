import { z } from "zod";

const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url().default("http://localhost:3000"),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

/**
 * Only non-secret values belong here. Each variable is referenced literally so Next.js can
 * inline it into the client bundle. Parsed lazily so `next build` works without env present.
 */
export function getPublicEnv(): PublicEnv {
  const result = publicEnvSchema.safeParse({
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || undefined,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  if (!result.success) throw new EnvError(describeIssues("public", result.error));
  return result.data;
}

/** Names only — never echoes values, which may be secrets. */
export function describeIssues(scope: string, error: z.ZodError): string {
  const names = [...new Set(error.issues.map((i) => i.path.join(".") || "(root)"))];
  return `Invalid ${scope} environment configuration: ${names.join(", ")}. See .env.example.`;
}

/** True when Supabase public config is present and valid; used by health without throwing. */
export function isSupabaseConfigured(): boolean {
  return publicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  }).success;
}

/**
 * The VAPID public key for Web Push, or `null` if it isn't configured yet — safe to send to
 * the browser (that is its entire purpose; the matching private key never leaves the server).
 * Deliberately NOT part of `publicEnvSchema`: that schema throws when Supabase config is
 * missing, and this value being unset must never break unrelated public config. Like
 * `getAiConfig()`, this reads only its own variable and never throws; the "Enable
 * notifications" UI treats `null` the same as an unsupported browser — the feature simply
 * isn't available yet. Actual push delivery (which needs the matching private key) is a later
 * Phase 6 step; Phase 6.1 only needs this to call `PushManager.subscribe()`.
 */
export function getVapidPublicKey(): string | null {
  const value = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  return value ? value : null;
}
