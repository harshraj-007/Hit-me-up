/**
 * Accepts a post-login `next` target only if it is a plain same-site path; anything else
 * becomes `fallback`. This is a security boundary (an unchecked `next` is an open redirect),
 * so it is an allow-list, not a block-list of known-bad prefixes:
 *
 *  - must start with `/` (rules out absolute URLs, `javascript:`, bare hosts, leading space)
 *  - must not start with `//` (protocol-relative: `//evil.example` is a different origin)
 *  - must not start with `/\` (browsers treat `\` as `/`, so `/\evil.example` is `//evil.example`)
 *  - must contain no backslash or control character at all — the WHATWG URL parser silently
 *    strips tab/CR/LF, so `/<TAB>/evil.example` would otherwise collapse into `//evil.example`
 */
export function safeInternalPath(
  candidate: string | null | undefined,
  fallback = "/today",
): string {
  if (!candidate) return fallback;
  if (!candidate.startsWith("/")) return fallback;
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(candidate)) return fallback;
  return candidate;
}
