export type TransportPhase = "stopped" | "paused" | "connecting" | "reconnecting" | "ready" | "auth-error"

// Phases from which resume() may auto-reconnect without user action. Paused
// (app backgrounded) and reconnecting (transient drop) are routine; stopped is
// a client-less disconnect so an existing client means it is safe to try.
// auth-error is deliberately excluded: the server rejected our credentials,
// so resuming merely because Android became active would hammer the same
// failing auth with no path to recovery (issue #76). Retrying after
// credentials change is a manual connect(), which must stay possible.
export function canAutoResume(phase: TransportPhase): boolean {
  return phase === "paused" || phase === "stopped" || phase === "reconnecting"
}

export type StreamLiveSnapshot = {
  phase: TransportPhase
  reconnectVisible: boolean
}

// The transition that marks a subscription live. Applied both when the first
// SSE event arrives (fast path) and when the stability timer fires on a
// healthy idle stream that never yields an event — an open, error-free stream
// is live even without traffic, so without this the phase stays stuck in
// connecting/reconnecting and the retry banner stays up forever. Returns null
// when the stream already went ready (a real event established it), so callers
// skip the redundant transition and the one-time resync. recoveryVisible
// mirrors the previous reconnectVisible so a visible retry is followed by the
// recovery UI; fast pause/resume (never visible) stays silent.
export function streamLiveTransition(previous: StreamLiveSnapshot) {
  if (previous.phase === "ready") return null
  return {
    connected: true,
    phase: "ready" as const,
    reconnectAttempts: 0,
    reconnectVisible: false,
    recoveryVisible: previous.reconnectVisible,
  }
}
