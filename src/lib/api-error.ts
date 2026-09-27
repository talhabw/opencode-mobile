// Pure classification of HTTP auth failures, extracted so it's unit-testable
// under plain `node --test` without pulling in expo/fetch (sdk.ts is RN-only)
// — same pattern as analytics-classify.ts / diagnostics-classify.ts.
//
// Why this exists: sdk.ts's request()/events() used to throw a generic Error
// for every non-2xx response, so call sites (the SSE reconnect loop, screen
// error states) had no way to tell "your password is wrong" apart from "the
// server is briefly unreachable" — a 401 got treated like any transient
// failure and retried forever (see events.ts's reconnect loop / issue #76).

/** Thrown by sdk.ts's request()/events() when the server responds 401/403,
 *  so call sites can distinguish "bad credentials" from any other failure
 *  (network error, 5xx, timeout) instead of catching a generic Error. */
export class ApiAuthError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiAuthError"
    this.status = status
  }
}

export function apiStatusFor(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const tagged = error as { _tag?: unknown; status?: unknown; cause?: unknown }
  if (tagged._tag === "UnauthorizedError") return 401
  if (tagged._tag === "SessionNotFoundError" || tagged._tag === "MessageNotFoundError") return 404
  if (typeof tagged.status === "number") return tagged.status
  if (tagged.cause && typeof tagged.cause === "object" && "status" in tagged.cause) {
    const status = (tagged.cause as { status?: unknown }).status
    if (typeof status === "number") return status
  }
  return undefined
}

/** Type guard for call sites (e.g. the SSE reconnect loop) that need to branch
 *  on whether a caught error was an auth failure. */
export function isAuthError(error: unknown): error is ApiAuthError {
  return error instanceof ApiAuthError
}
