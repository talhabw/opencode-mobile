import { test } from "node:test"
import assert from "node:assert/strict"
import { canAutoResume, isCurrentGeneration, transportBannerState } from "./transport-lifecycle.ts"

test("fast pause/resume stays silent", () => {
  assert.deepEqual(transportBannerState({
    phase: "connecting",
    reconnectAttempts: 0,
    reconnectVisible: false,
    recoveryVisible: false,
  }), { showReconnect: false, showRecovery: false })
})

test("retry is visible until the first ready event and then recovers", () => {
  assert.deepEqual(transportBannerState({
    phase: "reconnecting",
    reconnectAttempts: 2,
    reconnectVisible: true,
    recoveryVisible: false,
  }), { showReconnect: true, showRecovery: false })
  assert.deepEqual(transportBannerState({
    phase: "ready",
    reconnectAttempts: 0,
    reconnectVisible: false,
    recoveryVisible: true,
  }), { showReconnect: false, showRecovery: true })
})

test("callbacks from an older stream are not current", () => {
  assert.equal(isCurrentGeneration(4, 3), false)
  assert.equal(isCurrentGeneration(4, 4), true)
})

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
