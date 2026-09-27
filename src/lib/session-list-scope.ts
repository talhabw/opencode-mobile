// Pure rule deciding which live SSE session events belong in the currently
// displayed sessions list. Extracted from stores/sessions.ts so the scope
// comparison is unit-testable without pulling in zustand/expo.
//
// The server scopes a session LIST by exact location.directory match, so the
// live path must use the same exact-match rule -- otherwise a session created
// in another workspace would briefly appear (until the next refresh) in a
// workspace-filtered list.

import { stripTrailingSlash } from "./path-utils"

export type SessionListScope = "workspace" | "all"

/**
 * Whether `sessionDirectory` belongs in the list currently being displayed.
 * "all" shows everything; a connection without a directory has no narrower
 * scope than the whole server, so it also admits everything.
 */
export function sessionInListScope(
  scope: SessionListScope,
  activeDirectory: string | null | undefined,
  sessionDirectory: string | null | undefined,
): boolean {
  if (scope !== "workspace") return true
  const active = (activeDirectory ?? "").trim()
  if (!active) return true
  return stripTrailingSlash((sessionDirectory ?? "").trim()) === stripTrailingSlash(active)
}

