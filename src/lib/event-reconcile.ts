import type { Event } from "./protocol-v2"

export type ResyncPlan = {
  sessions: boolean
  messages: boolean
  pending: boolean
  active: boolean
}

export function resyncPlan(hasCurrentSession: boolean): ResyncPlan {
  return { sessions: true, messages: hasCurrentSession, pending: true, active: true }
}

export function mergeSendingState(
  sending: Record<string, boolean>,
  running: Record<string, unknown>,
): Record<string, boolean> {
  const sessionIDs = [...new Set([...Object.keys(sending), ...Object.keys(running)])]
  return Object.fromEntries(sessionIDs.map((sessionID) => [sessionID, sessionID in running]))
}

const CANONICAL_REFRESH_EVENTS = new Set([
  "session.error",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.instructions.updated",
  "session.step.ended",
  "session.step.failed",
  "session.text.ended",
  "session.reasoning.ended",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.synthetic",
])

// Terminal/error events always refresh the canonical page: they are the only
// authoritative end-of-run state, so they must not be gated by busy-ness.
// "session.status" here means the normalized idle transition — normalizeEvent
// only ever stamps canonicalRefresh on status events for
// execution.succeeded/interrupted/idle (and the failed -> idle pair), and a
// plain status event never passes shouldRefreshCanonicalMessages.
const TERMINAL_REFRESH_EVENTS = new Set([
  "session.error",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.status",
])

// Durable history the live part stream never carries. `session.instructions.
// updated` projects a System bookkeeping row into session history mid-run; no
// streamed part reflects it, so the mid-run refresh that surfaces the row is
// not redundant and must not be suppressed while the session is busy.
const DURABLE_REFRESH_EVENTS = new Set([...TERMINAL_REFRESH_EVENTS, "session.instructions.updated"])

export function shouldRefreshCanonicalMessages(event: Event, sessionBusy?: boolean): boolean {
  if (!CANONICAL_REFRESH_EVENTS.has(event.type) && event.properties.canonicalRefresh !== true) return false
  // While a session is mid-run, its live events already carry the same data
  // the canonical page would, and each mid-run refresh re-parses and re-renders
  // the whole thread (Markdown included) for no new information. The terminal
  // busy -> idle execution transition triggers the authoritative refresh, so
  // skipping mid-run refreshes loses nothing. Durable updates (terminal
  // transitions, instruction updates) are exempt: their data is only on the
  // canonical page, never in the live stream.
  if (sessionBusy === true && !DURABLE_REFRESH_EVENTS.has(event.type)) return false
  return true
}

export function eventSessionID(event: Event): string | undefined {
  const value = event.properties.sessionID
  return typeof value === "string" ? value : undefined
}

export function reconnectDelay(attempt: number, random = 0.5): number {
  const delays = [1000, 2000, 4000, 8000, 15000] as const
  const base = delays[Math.min(Math.max(attempt - 1, 0), delays.length - 1)]
  return Math.min(15_000, Math.round(base * (0.75 + random * 0.5)))
}
