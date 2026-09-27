import test from "node:test"
import assert from "node:assert/strict"
import {
  isDurableHistoryEvent,
  isRunCompletion,
  retryFromScheduled,
  revertPatchFromEvent,
  sessionInfoPatchFromEvent,
  RevertResponseGuard,
} from "./session-events.ts"

test("a run completes from either busy or retry, but never from idle", () => {
  assert.equal(isRunCompletion({ type: "busy" }, { type: "idle" }), true)
  assert.equal(isRunCompletion({ type: "retry" }, { type: "idle" }), true)
  assert.equal(isRunCompletion({ type: "idle" }, { type: "idle" }), false)
  assert.equal(isRunCompletion(undefined, { type: "idle" }), false)
  assert.equal(isRunCompletion({ type: "busy" }, { type: "busy" }), false)
  assert.equal(isRunCompletion({ type: "retry" }, { type: "busy" }), false)
})

test("maps session.retry.scheduled to a retry status without completing the run", () => {
  assert.deepEqual(
    retryFromScheduled({
      sessionID: "s1",
      assistantMessageID: "m1",
      attempt: 3,
      at: 123,
      error: { type: "provider", message: "rate limited", status: 429 },
    }),
    { sessionID: "s1", status: { type: "retry", attempt: 3, message: "rate limited" } },
  )
})

test("retry mapping tolerates missing attempt and error fields", () => {
  assert.deepEqual(retryFromScheduled({ sessionID: "s1" }), {
    sessionID: "s1",
    status: { type: "retry", attempt: 0, message: "" },
  })
  assert.deepEqual(retryFromScheduled({ sessionID: "s1", attempt: Number.NaN, error: "boom" }), {
    sessionID: "s1",
    status: { type: "retry", attempt: 0, message: "" },
  })
  assert.equal(retryFromScheduled({ attempt: 1 }), null)
  assert.equal(retryFromScheduled({ sessionID: "" }), null)
})

test("maps staged reverts to the pending revert shape", () => {
  assert.deepEqual(
    revertPatchFromEvent({
      type: "session.revert.staged",
      properties: { sessionID: "s1", revert: { messageID: "m2", partID: "p1", snapshot: "abc" } },
    }),
    { sessionID: "s1", revert: { messageID: "m2", partID: "p1" } },
  )
  assert.deepEqual(
    revertPatchFromEvent({ type: "session.revert.staged", properties: { sessionID: "s1", revert: { messageID: "m2" } } }),
    { sessionID: "s1", revert: { messageID: "m2" } },
  )
  assert.equal(revertPatchFromEvent({ type: "session.revert.staged", properties: { sessionID: "s1" } }), null)
  assert.equal(revertPatchFromEvent({ type: "session.revert.staged", properties: { revert: { messageID: "m2" } } }), null)
})

test("maps cleared and committed reverts to a cleared revert", () => {
  assert.deepEqual(revertPatchFromEvent({ type: "session.revert.cleared", properties: { sessionID: "s1" } }), {
    sessionID: "s1",
    revert: null,
  })
  assert.deepEqual(
    revertPatchFromEvent({ type: "session.revert.committed", properties: { sessionID: "s1", to: "m2" } }),
    { sessionID: "s1", revert: null, committedTo: "m2" },
  )
  // A committed event without a boundary id still clears the pending revert;
  // there is just nothing to truncate locally.
  assert.deepEqual(revertPatchFromEvent({ type: "session.revert.committed", properties: { sessionID: "s1" } }), {
    sessionID: "s1",
    revert: null,
  })
})

test("ignores unrelated session events", () => {
  assert.equal(revertPatchFromEvent({ type: "session.renamed", properties: { sessionID: "s1", title: "x" } }), null)
  assert.equal(revertPatchFromEvent({ type: "session.revert.staged", properties: { sessionID: "" } }), null)
})

test("maps released metadata/permission session events to a cache patch", () => {
  assert.deepEqual(
    sessionInfoPatchFromEvent({
      type: "session.metadata.updated",
      properties: { sessionID: "s1", metadata: { pinned: true, labels: ["a"] } },
    }),
    { sessionID: "s1", metadata: { pinned: true, labels: ["a"] } },
  )
  assert.deepEqual(
    sessionInfoPatchFromEvent({
      type: "session.permissions",
      properties: { sessionID: "s1", permissions: [{ action: "shell", resources: ["git *"] }] },
    }),
    { sessionID: "s1", permissions: [{ action: "shell", resources: ["git *"] }] },
  )
})

test("ignores malformed or unrelated session info events", () => {
  assert.equal(sessionInfoPatchFromEvent({ type: "session.metadata.updated", properties: { sessionID: "s1" } }), null)
  assert.equal(sessionInfoPatchFromEvent({ type: "session.metadata.updated", properties: { sessionID: "s1", metadata: [] } }), null)
  assert.equal(sessionInfoPatchFromEvent({ type: "session.permissions", properties: { sessionID: "s1", permissions: {} } }), null)
  assert.equal(sessionInfoPatchFromEvent({ type: "session.permissions", properties: { permissions: [] } }), null)
  assert.equal(sessionInfoPatchFromEvent({ type: "session.renamed", properties: { sessionID: "s1", title: "x" } }), null)
})

test("a newer revert request invalidates an in-flight response", () => {
  const guard = new RevertResponseGuard()
  const first = guard.begin("s1")
  assert.equal(guard.isCurrent("s1", first), true)
  const second = guard.begin("s1")
  assert.equal(guard.isCurrent("s1", first), false)
  assert.equal(guard.isCurrent("s1", second), true)
})

test("a revert event invalidates an in-flight response for that session only", () => {
  const guard = new RevertResponseGuard()
  const token = guard.begin("s1")
  guard.noteEvent("s2")
  assert.equal(guard.isCurrent("s1", token), true, "events for another session must not invalidate")
  guard.noteEvent("s1")
  assert.equal(guard.isCurrent("s1", token), false)
  // Once superseded, a later request still starts from the new event count.
  const next = guard.begin("s1")
  assert.equal(guard.isCurrent("s1", next), true)
})

test("durable history events bypass the mid-run refresh gate", () => {
  for (const type of [
    "session.skill.activated",
    "session.compaction.started",
    "session.compaction.ended",
    "session.compaction.failed",
    "session.revert.committed",
  ]) {
    assert.equal(isDurableHistoryEvent(type), true, type)
  }
  // Streamed/live events keep the existing gating.
  for (const type of [
    "session.status",
    "session.text.delta",
    "session.tool.progress",
    "session.message.content.updated",
    "session.usage.updated",
  ]) {
    assert.equal(isDurableHistoryEvent(type), false, type)
  }
})
