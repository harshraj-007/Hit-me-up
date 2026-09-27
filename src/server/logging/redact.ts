const SENSITIVE_KEY =
  /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|session|credential|service[-_]?role|jwt|email|phone|brain[-_]?dump|content|body|prompt|completion)/i;

const SENSITIVE_VALUE: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, "[REDACTED_JWT]"],
];

const MAX_DEPTH = 6;

export function redactString(value: string): string {
  return SENSITIVE_VALUE.reduce((acc, [re, repl]) => acc.replace(re, repl), value);
}

/** Deep-copies a value, masking sensitive keys and secret-shaped strings. Safe for cycles. */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(v, depth + 1, seen);
  }
  return out;
}
