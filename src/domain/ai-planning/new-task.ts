import { MAX_NEW_TASK_TITLE_LENGTH } from "./types";

/**
 * Rules for a model-proposed NEW task's title (Phase 8). A title is one short line of plain
 * text: it is rendered by the UI, quoted back in later prompts and notifications, and stored.
 *
 * Refused: nothing / only whitespace, anything over the cap, control or invisible characters
 * (line breaks, zero-width and bidi-override characters included), angle brackets (markup), and
 * links in any common form. Digits, punctuation and any script are fine — "Problem set 4" and
 * "Pharmacie — ordonnance" are ordinary titles.
 */
const NON_PLAIN = /[\p{C}\p{Zl}\p{Zp}<>]/u;
const LINK =
  /(?:\b[a-z][a-z0-9+.-]{1,15}:\/\/|\b(?:https?|ftp|javascript|data|mailto):|\bwww\.|\]\()/i;

export type TitleCheck = { ok: true; title: string } | { ok: false };

/** The title as it will be stored — trimmed, inner whitespace collapsed — or a refusal. */
export function checkNewTaskTitle(raw: unknown): TitleCheck {
  if (typeof raw !== "string") return { ok: false };
  // Whitespace is collapsed only AFTER control characters are looked for: a line break is a
  // refusal, not something to quietly flatten into a space.
  if (NON_PLAIN.test(raw) || LINK.test(raw)) return { ok: false };
  const title = raw.replace(/\s+/g, " ").trim();
  if (title.length === 0 || title.length > MAX_NEW_TASK_TITLE_LENGTH) return { ok: false };
  return { ok: true, title };
}

/**
 * The key two titles are compared by to call them duplicates: whitespace-collapsed, trimmed,
 * lower-cased. The SQL confirmation applies the same normalization (`lower` of a
 * whitespace-collapsed `btrim`), so what the validator calls a duplicate the database does too.
 */
export function normalizeTitleKey(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

const CLOCK_TIME =
  /\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s?(?:a\.?m\.?|p\.?m\.?)(?![a-z])|\b(?:noon|midnight)\b|\b(?:1[0-2]|[1-9])\s?o'?\s?clock\b/i;

/**
 * Does the text name a clock time ("3pm", "15:30", "noon", "9 o'clock")? A `fixed` task is for a
 * time the user themselves gave; the validator therefore requires the saved briefing to contain
 * one before it will accept any `fixed` task. This is a cheap, deterministic floor — it cannot
 * prove WHICH task the time belongs to, which is why such a task is also shown to the user for
 * explicit confirmation like every other proposed change.
 */
export function mentionsClockTime(text: string): boolean {
  return CLOCK_TIME.test(text);
}
