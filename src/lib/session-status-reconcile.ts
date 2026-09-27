import type { Message } from "./sdk"

// Session status from the server. Kept next to the reconciliation helpers (and
// re-exported through them) so the store's status logic can be tested without
// pulling in React Native.
export type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string }

// The official assistant payload carries `retry` while an attempt failed and
// the server already scheduled the next one. A message in that state is
// in-flight even if a stale `error`/`completed` field survives on it.
function isTerminalAssistantMessage(message: Message | undefined): boolean {
  if (!message || message.role !== "assistant") return false
  if (message.retry) return false
  return Boolean(message.time?.completed) || Boolean(message.error)
}

// The server appends non-conversational bookkeeping rows (the released v2
// `idle` settle marker, compaction/skill/system notices, instructions
// updates). They render as system rows and carry no conversational state, so
// the live tail must be read past them. An `idle` marker is itself evidence:
// the server appends it when a run settles, including a run that was
// interrupted or failed before producing an assistant message.
function isSettledTail(messages: Message[], newestFirst: boolean): boolean {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[newestFirst ? index : messages.length - 1 - index]
    if (!message) return false
    if (message.presentation === "system" && message.systemKind === "idle") return true
    if (message.presentation === "system") continue
    return isTerminalAssistantMessage(message)
  }
  return false
}

/**
 * Decide whether a session the client believes is "busy" has actually
 * finished, based on the tail of its message history.
 *
 * Why this exists (issue #123): `sessionStatus`/`sending` are SSE-driven —
 * the server's busy -> idle `session.status` event is the only thing that
 * normally clears them. If the network drops while a session is busy and
 * that busy -> idle event fires DURING the outage, it is lost: SSE reconnect
 * resumes the stream from "now", it does not replay missed events. Without a
 * resync, the UI shows a stuck 'processing' spinner forever even though the
 * server finished long ago.
 *
 * Heuristic: idle iff the newest conversational message is an assistant
 * message that has terminated — either it completed normally
 * (`time.completed` set) or it ended in error (`error` set; the server still
 * finalizes the message on error, it just never gets a successful
 * `time.completed`). Trailing bookkeeping rows (the v2 `idle` settle marker
 * included) are skipped: the released server appends one after settling, and
 * stopping on it would read every finished run as still busy. Anything else —
 * the newest conversational message is a user prompt still awaiting a reply,
 * or an assistant message that hasn't finished streaming, or an assistant
 * message whose `retry` is still scheduled — means the run may still be in
 * progress server-side. Callers MUST treat that as "still busy" and leave the
 * local state alone: this heuristic only ever clears a stale busy flag, it
 * never forces a session busy that the server hasn't reported as such, so a
 * genuinely still-busy session is never clobbered.
 */
export function isSessionActuallyIdle(messages: Message[] | null | undefined): boolean {
  if (!messages || messages.length === 0) return false
  return isSettledTail(messages, false)
}

/**
 * Newest-first (`order: "desc"`) variant of {@link isSessionActuallyIdle} for
 * the reconnect resync: the first item is the latest message, so the head is
 * the live tail. The resync must fetch the newest page — checking the oldest
 * ascending page would misread an old completed reply as the current state and
 * clear a genuinely running session (a run longer than one server page).
 */
export function isSessionActuallyIdleFromNewestFirst(messages: Message[] | null | undefined): boolean {
  if (!messages || messages.length === 0) return false
  return isSettledTail(messages, true)
}

// Statuses worth resyncing. "retry" (the server is automatically retrying a
// failed step) is still in-flight exactly like "busy", and strands the same
// way when its terminal session.status lands during an outage — so both count
// as stale-running for the resync.
export function isRunningEquivalent(status: SessionStatus | undefined): boolean {
  return status !== undefined && (status.type === "busy" || status.type === "retry")
}

/**
 * Sessions whose status object changed between two snapshots. The reconnect
 * resync captures the status map just before firing its `session.active()`
 * probe; when the probe resolves, any session in this set has a fresher SSE
 * status (or `session.retry.scheduled`) than the probe's snapshot and must
 * keep it — the probe result is older than the event.
 */
export function changedStatusSessionIDs(
  before: Readonly<Record<string, SessionStatus>>,
  after: Readonly<Record<string, SessionStatus>>,
): Set<string> {
  const changed = new Set<string>()
  for (const sessionID of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[sessionID] !== after[sessionID]) changed.add(sessionID)
  }
  return changed
}

/**
 * IDs whose local running-equivalent status still needs the message-tail
 * check. Sessions the authoritative `session.active()` probe just confirmed as
 * running are excluded: the heuristic must never override explicit server
 * truth (a mid-retry message can still carry the failed attempt's `error`, and
 * the released `retry` field is not part of the local message type).
 */
export function staleRunningSessionIDs(
  sessionStatus: Record<string, SessionStatus>,
  confirmedRunning: Record<string, unknown> | null,
): string[] {
  return Object.entries(sessionStatus)
    .filter(([, status]) => isRunningEquivalent(status))
    .map(([sessionID]) => sessionID)
    .filter((sessionID) => confirmedRunning === null || !(sessionID in confirmedRunning))
}

/**
 * Apply `session.active()` (running sessions) to the SSE-driven status map
 * after an SSE reconnect, preserving a pending retry.
 *
 * `running` only says which sessions have work in flight; it cannot know how
 * far the run got while the stream was down. Overwriting a `retry` status with
 * a generic `busy` would drop the attempt count and retry reason the UI is
 * showing, so a retry already recorded for a running session is kept — the
 * next `session.retry.scheduled`/`session.status` event or the busy resync
 * supersedes it. Sessions that are running-equivalent locally but absent from
 * `running` are stale and cleared to idle.
 *
 * `changedSessionIDs` are sessions whose status was replaced by a fresh SSE
 * event while the probe was in flight (see {@link changedStatusSessionIDs}).
 * The probe's snapshot predates those events, so those sessions are left
 * exactly as the event wrote them — otherwise a fresh busy -> idle would be
 * resurrected to busy and a fresh busy would be cleared to idle by an older
 * probe.
 *
 * Returns the same object when nothing needs to change, so subscribers don't
 * re-render on an identical resync.
 */
export function reconcileRunningStatuses(
  sessionStatus: Record<string, SessionStatus>,
  running: Record<string, unknown>,
  changedSessionIDs: ReadonlySet<string> = new Set(),
): Record<string, SessionStatus> {
  let next: Record<string, SessionStatus> | null = null
  const write = (sessionID: string, status: SessionStatus) => {
    if (!next) next = { ...sessionStatus }
    next[sessionID] = status
  }

  for (const [sessionID, status] of Object.entries(sessionStatus)) {
    if (!(sessionID in running) && isRunningEquivalent(status) && !changedSessionIDs.has(sessionID)) write(sessionID, { type: "idle" })
  }
  for (const sessionID of Object.keys(running)) {
    if (changedSessionIDs.has(sessionID)) continue
    const current = sessionStatus[sessionID]
    if (current?.type === "retry") continue
    if (current?.type === "busy") continue
    write(sessionID, { type: "busy" })
  }

  return next ?? sessionStatus
}
