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
  assert.equal(shouldRefreshCanonicalMessages({ type: "session.synthetic", properties: { sessionID: "s1", text: "<shell id=\"c\" state=\"completed\">" } }), true)
  assert.equal(shouldRefreshCanonicalMessages({ type: "message.part.updated", properties: { canonicalRefresh: true } }), true)
  assert.equal(shouldRefreshCanonicalMessages({ type: "message.part.updated", properties: {} }), false)
  assert.equal(shouldRefreshCanonicalMessages({ type: "session.shell.ended", properties: { canonicalRefresh: true } }), true)
  assert.equal(shouldRefreshCanonicalMessages({ type: "session.shell.started", properties: {} }), false)
  assert.equal(shouldRefreshCanonicalMessages({ type: "future.event", properties: { sessionID: "s1" } }), false)
  assert.equal(eventSessionID({ type: "future.event", properties: { sessionID: "s1" } }), "s1")
  assert.equal(eventSessionID({ type: "future.event", properties: { sessionID: 1 } }), undefined)
})

test("busy sessions skip mid-run refreshes but never terminal or error refreshes", () => {
  const midRun = [
    { type: "session.step.ended", properties: {} },
    { type: "session.step.failed", properties: {} },
    { type: "session.text.ended", properties: {} },
    { type: "session.reasoning.ended", properties: {} },
    { type: "session.tool.called", properties: {} },
    { type: "session.tool.success", properties: {} },
    { type: "session.tool.failed", properties: {} },
    { type: "session.shell.ended", properties: { canonicalRefresh: true } },
    { type: "session.synthetic", properties: { sessionID: "s1" } },
    { type: "message.part.updated", properties: { canonicalRefresh: true, sessionID: "s1" } },
  ]
  for (const event of midRun) assert.equal(shouldRefreshCanonicalMessages(event, true), false, event.type)

  const terminal = [
    { type: "session.error", properties: {} },
    { type: "session.execution.succeeded", properties: {} },
    { type: "session.execution.failed", properties: {} },
    { type: "session.execution.interrupted", properties: {} },
    { type: "session.status", properties: { sessionID: "s1", status: { type: "idle" }, canonicalRefresh: true } },
  ]
  for (const event of terminal) assert.equal(shouldRefreshCanonicalMessages(event, true), true, event.type)

  // Events that never trigger a refresh stay gated off even while busy.
  assert.equal(shouldRefreshCanonicalMessages({ type: "session.text.delta", properties: {} }, true), false)
})

test("idle sessions and unknown busy state keep today's refresh behavior", () => {
  for (const busy of [undefined, false]) {
    assert.equal(shouldRefreshCanonicalMessages({ type: "session.tool.called", properties: {} }, busy), true)
    assert.equal(shouldRefreshCanonicalMessages({ type: "session.execution.succeeded", properties: {} }, busy), true)
    assert.equal(shouldRefreshCanonicalMessages({ type: "session.shell.ended", properties: { canonicalRefresh: true } }, busy), true)
    assert.equal(shouldRefreshCanonicalMessages({ type: "message.part.updated", properties: {} }, busy), false)
  }
})
