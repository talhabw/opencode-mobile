import assert from "node:assert/strict"
import test from "node:test"
import { eventSessionID, mergeSendingState, reconnectDelay, resyncPlan, shouldRefreshCanonicalMessages } from "./event-reconcile.ts"

test("resync includes authoritative server state on initial connect and reconnect", () => {
  assert.deepEqual(resyncPlan(false), { sessions: true, messages: false, pending: true, active: true })
  assert.deepEqual(resyncPlan(true), { sessions: true, messages: true, pending: true, active: true })
})

test("resync merges sending and active sessions without iterator helpers", () => {
  assert.deepEqual(
    mergeSendingState({ stale: true, active: false }, { active: {}, new: {} }),
    { stale: false, active: true, new: true },
  )
})

test("reconnect delay is bounded and deterministic at jitter midpoint", () => {
  assert.equal(reconnectDelay(1), 1000)
  assert.equal(reconnectDelay(99, 1), 15000)
})

test("canonical refresh covers lifecycle and tool completion but ignores unknown events", () => {
  assert.equal(shouldRefreshCanonicalMessages({ type: "session.step.ended", properties: {} }), true)
  assert.equal(shouldRefreshCanonicalMessages({ type: "session.tool.success", properties: {} }), true)
  assert.equal(shouldRefreshCanonicalMessages({ type: "message.part.updated", properties: { canonicalRefresh: true } }), true)
  assert.equal(shouldRefreshCanonicalMessages({ type: "message.part.updated", properties: {} }), false)
  assert.equal(shouldRefreshCanonicalMessages({ type: "future.event", properties: { sessionID: "s1" } }), false)
  assert.equal(eventSessionID({ type: "future.event", properties: { sessionID: "s1" } }), "s1")
  assert.equal(eventSessionID({ type: "future.event", properties: { sessionID: 1 } }), undefined)
})
