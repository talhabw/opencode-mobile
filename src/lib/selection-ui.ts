export type DefaultAction = "inherit" | "concrete" | "unavailable"

// Without a persisted session override the generic "Use server default" row is
// always offered — even when the server's default cannot be resolved — so the
// user can clear a pending explicit choice. With a persisted override the row
// is only meaningful when a concrete resolved default exists: switching to it
// is an explicit selection, and pretending otherwise (reset/inheritance) would
// misrepresent the wire semantics.
export function defaultActionDecision(hasPersistedOverride: boolean, resolved: boolean): DefaultAction {
  if (!hasPersistedOverride) return "inherit"
  return resolved ? "concrete" : "unavailable"
}

export function selectorLabel(explicit: string | null | undefined, resolvedLabel: string | null | undefined, serverDefault: string): string {
  if (explicit) return explicit
  return resolvedLabel ? `${resolvedLabel} · ${serverDefault}` : serverDefault
}
