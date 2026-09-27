import { test } from "node:test"
import assert from "node:assert/strict"
import {
  changedStatusSessionIDs,
  isSessionActuallyIdle,
  isSessionActuallyIdleFromNewestFirst,
  isRunningEquivalent,
  reconcileRunningStatuses,
  staleRunningSessionIDs,
} from "./session-status-reconcile.ts"
import type { SessionStatus } from "./session-status-reconcile.ts"
import type { Message } from "./sdk.ts"

const userMsg = (id: string, overrides: Partial<Message> = {}): Message => ({
  id,
  sessionID: "s1",
  role: "user",
  time: { created: 1 },
  ...overrides,
})

const assistantMsg = (id: string, overrides: Partial<Message> = {}): Message => ({
  id,
  sessionID: "s1",
  role: "assistant",
  time: { created: 1 },
  ...overrides,
})

const systemMsg = (id: string, systemKind: Message["systemKind"], overrides: Partial<Message> = {}): Message => ({
  id,
  sessionID: "s1",
  role: "assistant",
  presentation: "system",
  systemKind,
  time: { created: 1 },
  ...overrides,
})

test("no messages -> still busy (nothing to reconcile from)", () => {
  assert.equal(isSessionActuallyIdle(undefined), false)
  assert.equal(isSessionActuallyIdle(null), false)
  assert.equal(isSessionActuallyIdle([]), false)
})

test("last message is a completed assistant reply -> idle (the missed-event case)", () => {
  const messages = [userMsg("u1"), assistantMsg("a1", { time: { created: 1, completed: 5 } })]
  assert.equal(isSessionActuallyIdle(messages), true)
})

test("last message is an assistant reply that errored out -> idle", () => {
  const messages = [userMsg("u1"), assistantMsg("a1", { error: { message: "boom" } })]
  assert.equal(isSessionActuallyIdle(messages), true)
})

test("last message is a user prompt awaiting a reply -> still busy", () => {
  const messages = [assistantMsg("a1", { time: { created: 1, completed: 5 } }), userMsg("u2")]
  assert.equal(isSessionActuallyIdle(messages), false)
})

test("last message is an assistant reply still streaming (no completed, no error) -> still busy", () => {
  const messages = [userMsg("u1"), assistantMsg("a1")]
  assert.equal(isSessionActuallyIdle(messages), false)
})

test("a follow-up user prompt after a completed assistant reply -> still busy again", () => {
  // Server queued a second turn: the previous reply completed, but a new user
  // message was appended after it, so the run may be in progress again.
  const messages = [
    userMsg("u1"),
    assistantMsg("a1", { time: { created: 1, completed: 5 } }),
    userMsg("u2"),
  ]
  assert.equal(isSessionActuallyIdle(messages), false)
})

test("a retry in flight is never idle, even if a stale error/completed survives on the message", () => {
  const retrying = {
    ...assistantMsg("a1", { time: { created: 1, completed: 5 } }),
    retry: { attempt: 3, at: 2, error: { message: "rate limited" } },
  } as Message
  assert.equal(isSessionActuallyIdle([userMsg("u1"), retrying]), false)
  assert.equal(isSessionActuallyIdleFromNewestFirst([retrying, userMsg("u1")]), false)
})

test("newest-first pages read the head, not the tail", () => {
  // order:"desc" puts the newest message first; checking the tail (oldest of
  // the page) is exactly the reconnect bug for sessions longer than one page.
  const completed = assistantMsg("a_new", { time: { created: 9, completed: 10 } })
  const older = userMsg("u_old")
  assert.equal(isSessionActuallyIdleFromNewestFirst([completed, older]), true)
  assert.equal(isSessionActuallyIdleFromNewestFirst([older, completed]), false)
  // The ascending helper's tail semantics must stay unchanged.
  assert.equal(isSessionActuallyIdle([older, completed]), true)
  assert.equal(isSessionActuallyIdleFromNewestFirst([]), false)
  assert.equal(isSessionActuallyIdleFromNewestFirst(null), false)
})

test("a trailing idle bookkeeping row counts as settled", () => {
  // Released v2 appends an `idle` marker when a run settles. It is the newest
  // row, so reading only that row without recognizing it left every finished
  // run looking busy in the reconnect fallback.
  const idle = systemMsg("idle", "idle")
  assert.equal(isSessionActuallyIdleFromNewestFirst([idle, userMsg("u1")]), true)
  assert.equal(isSessionActuallyIdle([userMsg("u1"), idle]), true)
  // Even a run that produced no assistant reply (interrupted early) settled
  // when the marker is there.
  assert.equal(isSessionActuallyIdleFromNewestFirst([idle]), true)
})

test("newest-first idle checks skip other bookkeeping rows to the conversational tail", () => {
  const completed = assistantMsg("a1", { time: { created: 1, completed: 5 } })
  const streaming = assistantMsg("a2")
  // Compaction/instructions rows are not settle markers, but they also carry
  // no conversational state: keep looking behind them.
  assert.equal(isSessionActuallyIdleFromNewestFirst([systemMsg("c1", "compaction"), completed, userMsg("u1")]), true)
  assert.equal(isSessionActuallyIdleFromNewestFirst([systemMsg("i1", "system"), completed, userMsg("u1")]), true)
  // The message behind the bookkeeping row decides when there is no idle marker.
  assert.equal(isSessionActuallyIdleFromNewestFirst([systemMsg("c1", "compaction"), streaming, userMsg("u1")]), false)
  assert.equal(isSessionActuallyIdleFromNewestFirst([systemMsg("c1", "compaction"), userMsg("u2")]), false)
  // The settle marker itself wins over anything behind it.
  assert.equal(isSessionActuallyIdleFromNewestFirst([systemMsg("idle", "idle"), streaming, userMsg("u1")]), true)
})

test("reconcileRunningStatuses preserves retry attempts for running sessions", () => {
  const retry: SessionStatus = { type: "retry", attempt: 3, message: "rate limited" }
  const status: Record<string, SessionStatus> = {
    s1: retry,
    s2: { type: "busy" },
    s3: { type: "idle" },
    s4: { type: "retry", attempt: 1, message: "boom" },
  }
  const running = { s1: {}, s2: {}, s3: {} }

  assert.deepEqual(reconcileRunningStatuses(status, running), {
    // The active list confirms s1 is still running: keep its attempt/reason.
    s1: retry,
    s2: { type: "busy" },
    s3: { type: "busy" },
    // s4 was running-equivalent locally but is gone from the active list.
    s4: { type: "idle" },
  })
})

test("reconcileRunningStatuses returns the same map when nothing changes", () => {
  const status: Record<string, SessionStatus> = { s1: { type: "busy" }, s2: { type: "idle" } }
  assert.equal(reconcileRunningStatuses(status, { s1: {} }), status)
  const empty: Record<string, SessionStatus> = {}
  assert.equal(reconcileRunningStatuses(empty, {}), empty)
})

test("changedStatusSessionIDs reports only statuses a newer event replaced", () => {
  const busy: SessionStatus = { type: "busy" }
  const retry: SessionStatus = { type: "retry", attempt: 2, message: "backing off" }
  const before: Record<string, SessionStatus> = { s1: busy, s2: busy }
  const after: Record<string, SessionStatus> = { s1: { type: "idle" }, s2: busy, s3: retry }
  assert.deepEqual([...changedStatusSessionIDs(before, after)].sort(), ["s1", "s3"])
})

test("a status a fresher event replaced during the probe is not clobbered by it", () => {
  // The active probe was fired while s1 was busy and s2 idle. While it was in
  // flight, SSE delivered s1's idle and s2's busy. The probe's older snapshot
  // must not resurrect s1 as busy or clear s2 to idle.
  const before: Record<string, SessionStatus> = { s1: { type: "busy" }, s2: { type: "idle" } }
  const after: Record<string, SessionStatus> = { s1: { type: "idle" }, s2: { type: "busy" } }
  const changed = changedStatusSessionIDs(before, after)
  assert.equal(reconcileRunningStatuses(after, { s1: {}, s2: {} }, changed), after)
  // Without the guard (no event arrived) the probe applies normally.
  const applied = reconcileRunningStatuses(after, { s2: {}, s3: {} })
  assert.deepEqual(applied, { s1: { type: "idle" }, s2: { type: "busy" }, s3: { type: "busy" } })
})

test("staleRunningSessionIDs excludes sessions the active probe confirmed running", () => {
  const status: Record<string, SessionStatus> = {
    s1: { type: "busy" },
    s2: { type: "retry", attempt: 2, message: "backing off" },
    s3: { type: "idle" },
  }
  // s1 was confirmed running by session.active(): the message heuristic must
  // not clear it. s2 was not confirmed, so it stays eligible for the check.
  assert.deepEqual(staleRunningSessionIDs(status, { s1: {} }), ["s2"])
  // Without a successful active probe, every running-equivalent status is
  // still eligible (the issue #123 fallback).
  assert.deepEqual(staleRunningSessionIDs(status, null), ["s1", "s2"])
  assert.deepEqual(staleRunningSessionIDs(status, {}), ["s1", "s2"])
})

test("reconnect resync keeps a long, actively-retrying session running", () => {
  // Regression scenario (issue #123 resync): a session longer than one server
  // page. The oldest ascending page ends in a completed assistant reply, so
  // the pre-fix resync read it as idle even though the run was still going.
  const oldestPageTail = [userMsg("u1"), assistantMsg("a1", { time: { created: 1, completed: 2 } })]
  assert.equal(isSessionActuallyIdle(oldestPageTail), true)
  // The newest message is a user prompt still awaiting its reply, so the
  // newest page correctly reports "still busy".
  assert.equal(isSessionActuallyIdleFromNewestFirst([userMsg("u2")]), false)

  // The active probe confirms the run; the retry status survives the status
  // reconcile and is never handed to the message-tail fallback.
  const status: Record<string, SessionStatus> = { s1: { type: "retry", attempt: 2, message: "rate limited" } }
  const running = { s1: {} }
  assert.equal(reconcileRunningStatuses(status, running), status)
  assert.deepEqual(staleRunningSessionIDs(status, running), [])
})

test("isRunningEquivalent counts busy and retry, but not idle or unknown", () => {
  assert.equal(isRunningEquivalent({ type: "busy" }), true)
  assert.equal(isRunningEquivalent({ type: "retry", attempt: 1, message: "x" }), true)
  assert.equal(isRunningEquivalent({ type: "idle" }), false)
  assert.equal(isRunningEquivalent(undefined), false)
})
