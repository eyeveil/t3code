/**
 * Pure parsers for provider-login PTY output.
 *
 * Login CLIs (codex device-auth, claude setup-token) print a verification URL
 * and — for device flows — a short user code the user must confirm. The web
 * login dialog surfaces these prominently above the raw terminal output. These
 * helpers are intentionally dependency-free and side-effect-free so they can be
 * unit-tested and reused across surfaces.
 */

// ANSI/OSC control sequences the terminal emits around URLs; stripped so a URL
// wrapped in escape codes still matches.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\[[0-9;?]*[ -/]*[@-~]|\][^]*(?:|\\)/g;

// Trailing punctuation that commonly hugs a URL in prose but is not part of it.
const URL_TRAILING_PUNCTUATION = /[).,;:'"\]}>]+$/;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

/**
 * Extract the first http(s) URL from accumulated login output. Returns
 * `undefined` when none is present yet.
 */
export function parseProviderLoginUrl(text: string): string | undefined {
  const cleaned = stripAnsi(text);
  const match = cleaned.match(/https?:\/\/[^\s]+/);
  const url = match?.[0];
  if (url === undefined) {
    return undefined;
  }
  return url.replace(URL_TRAILING_PUNCTUATION, "");
}

/**
 * Extract the first device/user code of the shape `XXXX-XXXX` (letters and
 * digits, case-insensitive) from accumulated login output. Codex device-auth
 * prints an 8-character grouped code; claude does not use one, so this returns
 * `undefined` for its flow.
 */
export function parseProviderLoginCode(text: string): string | undefined {
  const cleaned = stripAnsi(text);
  // Bounded on both sides by a non-alphanumeric (or string edge) so we don't
  // slice a code out of the middle of a longer token.
  const match = cleaned.match(/(?<![A-Za-z0-9])([A-Za-z0-9]{4}-[A-Za-z0-9]{4})(?![A-Za-z0-9])/);
  return match?.[1]?.toUpperCase();
}
