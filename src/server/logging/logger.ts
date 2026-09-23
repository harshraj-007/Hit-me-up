import "server-only";
import { getLogLevel } from "@/config/env.server";
import { redact, redactString } from "./redact";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level | "silent", number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) return redact(error);
  const isProd = process.env.NODE_ENV === "production";
  const out: Record<string, unknown> = {
    name: error.name,
    message: redactString(error.message),
  };
  if ("code" in error && typeof error.code === "string") out.code = error.code;
  // Postgres/PostgREST errors carry the diagnosis in `details` and `hint`, not just `message`.
  // Dropping them made "which constraint/policy?" unanswerable from logs alone.
  const fields: Record<string, unknown> = { ...error };
  for (const key of ["details", "hint"]) {
    const value = fields[key];
    if (typeof value === "string") out[key] = redactString(value);
  }
  if (!isProd && error.stack) out.stack = redactString(error.stack);
  if (error.cause) out.cause = serializeError(error.cause);
  return out;
}

function create(bindings: LogFields): Logger {
  const write = (level: Level, msg: string, fields: LogFields = {}) => {
    if (ORDER[level] < ORDER[getLogLevel()]) return;
    const { err, ...rest } = fields;
    const line = {
      level,
      time: new Date().toISOString(),
      msg,
      ...(redact({ ...bindings, ...rest }) as LogFields),
      ...(err === undefined ? {} : { err: serializeError(err) }),
    };
    const out = JSON.stringify(line);
    if (level === "error") console.error(out);
    else if (level === "warn") console.warn(out);
    else console.log(out);
  };

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (b) => create({ ...bindings, ...b }),
  };
}

/** Structured JSON logger. Pass errors as `{ err }`; sensitive keys are redacted automatically. */
export const logger: Logger = create({ service: "hitmeup" });
