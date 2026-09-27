export type DefaultAction = "inherit" | "concrete" | "unavailable"

// Without a persisted session override the generic "Default" row is always
// offered — even when the server's default cannot be resolved — so the user
// can clear a pending explicit choice. With a persisted override the row is
// only meaningful when a concrete resolved default exists: switching to it is
// an explicit selection, and pretending otherwise (reset/inheritance) would
// misrepresent the wire semantics.
export function defaultActionDecision(hasPersistedOverride: boolean, resolved: boolean): DefaultAction {
  if (!hasPersistedOverride) return "inherit"
  return resolved ? "concrete" : "unavailable"
}

// Toolbar/picker display label, mirroring the TUI prompt bar: an explicit
// selection wins, otherwise the concrete resolved default is shown — never an
// "Auto"/"Server default" placeholder. `fallback` covers the unresolved case
// with a concrete server-derived value where one exists (e.g. the first agent
// the server lists).
export function selectorLabel(
  explicit: string | null | undefined,
  resolvedDefault: string | null | undefined,
  fallback = "",
): string {
  if (explicit) return explicit
  return resolvedDefault || fallback
}
