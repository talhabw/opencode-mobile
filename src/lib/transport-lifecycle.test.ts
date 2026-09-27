import { test } from "node:test"
import assert from "node:assert/strict"
import { canAutoResume, streamLiveTransition } from "./transport-lifecycle.ts"

test("auto-resume is allowed from paused, stopped, and reconnecting phases", () => {
  for (const phase of ["paused", "stopped", "reconnecting"] as const) {
    assert.equal(canAutoResume(phase), true, `expected ${phase} to allow auto-resume`)
  }
})

test("auto-resume is blocked while a stream is live or auth-rejected", () => {
  for (const phase of ["connecting", "ready", "auth-error"] as const) {
    assert.equal(canAutoResume(phase), false, `expected ${phase} to block auto-resume`)
  }
})

test("auth-error auto-resume would reconnect a fixed-credential failure on app activate", () => {
  // Regression guard for issue #76: resume() must not start a fresh SSE stream
  // merely because Android became active while the server rejected our
  // credentials. Recovery only happens via a manual connect() after the user
  // edits the connection.
  assert.equal(canAutoResume("auth-error"), false)
})

test("an open error-free stream that yields no event transitions ready on the stability timer", () => {
  // Regression guard: a healthy idle stream may never emit an SSE event, so
  // the ready transition must also come from the stability timer, not only
  // from the first event. Without this the phase stays stuck in
  // connecting/reconnecting and the retry banner stays up forever.
  assert.deepEqual(streamLiveTransition({ phase: "connecting", reconnectVisible: false }), {
    connected: true,
    phase: "ready",
    reconnectAttempts: 0,
    reconnectVisible: false,
    recoveryVisible: false,
  })
})

test("timer-based recovery preserves the recovery UI for a visible retry", () => {
  // recoveryVisible mirrors the previous reconnectVisible, so a reconnect that
  // recovered via the stability timer still shows the "connected" flash.
  assert.deepEqual(streamLiveTransition({ phase: "reconnecting", reconnectVisible: true }), {
    connected: true,
    phase: "ready",
    reconnectAttempts: 0,
    reconnectVisible: false,
    recoveryVisible: true,
  })
})

test("a stream already made ready by a real event needs no re-transition", () => {
  // The first SSE event already applied the ready transition and ran the
  // one-time resync; the stability timer must not re-apply it (which would
  // duplicate the resync).
  assert.equal(streamLiveTransition({ phase: "ready", reconnectVisible: false }), null)
})
