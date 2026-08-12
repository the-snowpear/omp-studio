/**
 * Fail-closed error surfaced by the web transport boundary.
 *
 * A malformed response, a non-JSON envelope value, or a call made on a
 * closed transport is raised as a {@link WebTransportError} — never
 * surfaced as a plausible result. `code` reuses {@link ClientErrorCode}
 * vocabulary so callers can branch without parsing messages.
 */
export class WebTransportError extends Error {
  readonly name = "WebTransportError" as const;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
