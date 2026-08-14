export type SpeechFailureReason =
  | "permission-denied"
  | "permission-blocked"
  | "recognizer-unavailable"
  | "audio-capture"
  | "network"
  | "busy"
  | "language-not-supported"
  | "runtime"

export type SpeechPermission = {
  granted: boolean
  canAskAgain: boolean
}

export function classifySpeechPermission(permission: SpeechPermission): SpeechFailureReason | null {
  if (permission.granted) return null
  return permission.canAskAgain ? "permission-denied" : "permission-blocked"
}

export function mapSpeechError(error: string, nativeCode?: number): SpeechFailureReason | null {
  if (error === "aborted" || error === "no-speech" || error === "speech-timeout") return null
  if (error === "not-allowed" || nativeCode === 9) return "permission-denied"
  if (error === "service-not-allowed") return "recognizer-unavailable"
  if (error === "audio-capture" || nativeCode === 3) return "audio-capture"
  if (error === "network" || nativeCode === 1 || nativeCode === 2) return "network"
  if (error === "busy" || nativeCode === 8) return "busy"
  if (error === "language-not-supported" || nativeCode === 12 || nativeCode === 13) {
    return "language-not-supported"
  }
  return "runtime"
}
