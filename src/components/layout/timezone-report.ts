export interface ReportTimezoneOptions {
  /** The server action. It can resolve `{ ok: false }`, or *reject outright* when the call never
   *  completes (offline, dropped connection, a stale action id after a deploy) — `runAction`
   *  only turns errors thrown *inside* the action into a result, so transport failures escape it. */
  sync: (timezone: string) => Promise<{ ok: boolean }>;
  timezone: string;
  /** True once this run has been superseded (StrictMode's double effect, a retry, unmount). */
  isCancelled: () => boolean;
  onSaved: () => void;
  onFailed: () => void;
}

/**
 * Reports the browser's timezone and routes the outcome to exactly one callback:
 * `onSaved` only after the server confirmed it, `onFailed` for both a refusal and a rejected
 * call, and neither if the run was cancelled meanwhile. Kept separate from the component so
 * that this decision logic can be tested without a DOM.
 */
export async function reportTimezone({
  sync,
  timezone,
  isCancelled,
  onSaved,
  onFailed,
}: ReportTimezoneOptions): Promise<void> {
  let saved: boolean;
  try {
    saved = (await sync(timezone)).ok;
  } catch {
    saved = false;
  }
  if (isCancelled()) return;
  if (saved) onSaved();
  else onFailed();
}
