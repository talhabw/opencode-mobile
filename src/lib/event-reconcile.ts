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
  "session.step.ended",
  "session.step.failed",
  "session.text.ended",
  "session.reasoning.ended",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
])

export function shouldRefreshCanonicalMessages(event: Event): boolean {
  return CANONICAL_REFRESH_EVENTS.has(event.type) || event.properties.canonicalRefresh === true
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
