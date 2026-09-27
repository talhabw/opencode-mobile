// Pure compatibility helpers for official v2 session lifecycle events that the
// live part stream does not normalize into message/part updates. Kept free of
// React Native and SDK runtime imports so `node --test` can cover them directly
// (the stores themselves pull in expo modules).
import type { Event } from "../lib/protocol-v2"

export type RetryStatus = { type: "retry"; attempt: number; message: string }

export interface RetryStatusUpdate {
  sessionID: string
  status: RetryStatus
}

/**
 * A run finishes on the in-flight -> idle transition. "retry" counts as
 * in-flight exactly like "busy": the server re-attempts a failed step, and
 * when the run finally succeeds or fails the status goes idle from "retry".
 * Without this a completed-after-retry run would not be recognized as a
 * completion (no notification, no review credit), because busy was replaced
 * by retry along the way.
 */
export function isRunCompletion(
  previous: { type: string } | undefined,
  next: { type: string },
): boolean {
  return (previous?.type === "busy" || previous?.type === "retry") && next.type === "idle"
}

/**
 * Official per-attempt retry event (`session.retry.scheduled`). The server
 * emits it while an execution is still in flight after a provider attempt
 * failed, so the UI must show a retrying state — never a completion. The
 * structured error carries the reason; only a short message is kept for
 * display.
 */
export function retryFromScheduled(properties: Record<string, unknown>): RetryStatusUpdate | null {
  const sessionID = properties.sessionID
  if (typeof sessionID !== "string" || sessionID.length === 0) return null
  const attempt = typeof properties.attempt === "number" && Number.isFinite(properties.attempt) ? properties.attempt : 0
  const error = properties.error
  const message =
    error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : ""
  return { sessionID, status: { type: "retry", attempt, message } }
}

export interface SessionInfoPatch {
  sessionID: string
  // Free-form session metadata from `session.metadata.updated`.
  metadata?: Record<string, unknown>
  // Session permission ruleset from `session.permissions`.
  permissions?: unknown[]
}

/**
 * Released v2 session-info updates: `session.metadata.updated` carries
 * free-form metadata, `session.permissions` carries the session permission
 * ruleset. Neither maps to the fields the mobile UI renders, but other clients
 * (TUI, desktop, other phones) change them, so the cached session is kept in
 * sync instead of dropping the events. Anything malformed is ignored rather
 * than written as undefined.
 */
export function sessionInfoPatchFromEvent(event: Event): SessionInfoPatch | null {
  const sessionID = event.properties.sessionID
  if (typeof sessionID !== "string" || sessionID.length === 0) return null
  if (event.type === "session.metadata.updated") {
    const metadata = event.properties.metadata
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null
    return { sessionID, metadata: metadata as Record<string, unknown> }
  }
  if (event.type === "session.permissions") {
    const permissions = event.properties.permissions
    if (!Array.isArray(permissions)) return null
    return { sessionID, permissions }
  }
  return null
}

export interface RevertResponseToken {
  request: number
  events: number
}

/**
 * Orders revert mutations (stage/clear/commit) against each other and against
 * the `session.revert.*` SSE events. Each request records a token before its
 * HTTP call; the response is applied only if no newer request and no revert
 * event for that session has been observed since. Without this, a slow stage
 * response can reinstall a pending revert that a newer clear (local or from
 * another client) already removed.
 */
export class RevertResponseGuard {
  private requestSeq = 0
  private readonly eventSeqs = new Map<string, number>()

  begin(sessionID: string): RevertResponseToken {
    return { request: ++this.requestSeq, events: this.eventSeqs.get(sessionID) ?? 0 }
  }

  // Called for every revert lifecycle event, even when nothing local was
  // cached for the session: the server state moved on, so any request that
  // started before this event must not overwrite it.
  noteEvent(sessionID: string): void {
    this.eventSeqs.set(sessionID, (this.eventSeqs.get(sessionID) ?? 0) + 1)
  }

  isCurrent(sessionID: string, token: RevertResponseToken): boolean {
    return token.request === this.requestSeq && token.events === (this.eventSeqs.get(sessionID) ?? 0)
  }
}

export interface RevertPatch {
  sessionID: string
  revert: { messageID: string; partID?: string } | null
  // Present on `session.revert.committed`: the boundary message the server
  // reverted to. The boundary message and everything after it are gone
  // server-side, so the local transcript must drop them too.
  committedTo?: string
}

/**
 * Revert lifecycle events (`session.revert.staged/cleared/committed`). The
 * client keeps `session.revert` for the pending-revert banner; without these
 * events a revert staged or cleared by another client (TUI, another app)
 * would leave the banner stale until the next full session fetch.
 */
export function revertPatchFromEvent(event: Event): RevertPatch | null {
  const sessionID = event.properties.sessionID
  if (typeof sessionID !== "string" || sessionID.length === 0) return null
  if (event.type === "session.revert.staged") {
    const revert = event.properties.revert
    if (!revert || typeof revert !== "object") return null
    const messageID = (revert as { messageID?: unknown }).messageID
    if (typeof messageID !== "string" || messageID.length === 0) return null
    const partID = (revert as { partID?: unknown }).partID
    return { sessionID, revert: { messageID, ...(typeof partID === "string" && partID ? { partID } : {}) } }
  }
  if (event.type === "session.revert.cleared") return { sessionID, revert: null }
  if (event.type === "session.revert.committed") {
    const to = event.properties.to
    return { sessionID, revert: null, ...(typeof to === "string" && to.length > 0 ? { committedTo: to } : {}) }
  }
  return null
}

// Durable history events whose rows (or removed rows) only exist on the
// canonical session page. The live part stream never carries them, so a
// canonical refresh is the only way they appear before a run ends; unlike
// streamed deltas these are rare, so they must bypass the mid-run refresh
// gate that keeps streaming responsive.
//
// `session.message.content.updated` is deliberately NOT in this set: its
// content is already covered by the live text/reasoning/tool delta events,
// and refreshing on every content rewrite would re-render the whole thread
// mid-run for data the UI already has.
const DURABLE_HISTORY_EVENTS: ReadonlySet<string> = new Set([
  "session.skill.activated",
  "session.compaction.started",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.revert.committed",
])

export function isDurableHistoryEvent(type: string): boolean {
  return DURABLE_HISTORY_EVENTS.has(type)
}
