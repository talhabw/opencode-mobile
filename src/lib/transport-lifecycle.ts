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

export type TransportBannerState = {
  phase: TransportPhase
  reconnectAttempts: number
  reconnectVisible: boolean
  recoveryVisible: boolean
}

export function transportBannerState(state: TransportBannerState) {
  return {
    showReconnect: state.reconnectVisible && (state.phase === "connecting" || state.phase === "reconnecting"),
    showRecovery: state.recoveryVisible && state.phase === "ready",
  }
}

export function isCurrentGeneration(current: number, generation: number): boolean {
  return current === generation
}
