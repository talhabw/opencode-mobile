// Pure composer guards for the session screen (app/session/[id].tsx). Kept
// out of the screen component so the wrong-session-send and draft-overwrite
// rules can be unit tested without rendering React Native.

export interface ComposerDraft {
  text: string
  attachments: ReadonlyArray<{ uri: string }>
}

/**
 * True only when the session selected in the store is the session this screen
 * was opened for and no other selection is in flight.
 *
 * The store keeps a single global `currentSession`, so a screen that is cold
 * loading (or whose load failed) still sees the previously selected session.
 * `sendMessage`, `abortSession` and the permission/question replies all act on
 * whatever the store has selected. Gating them on this check is what keeps
 * this screen's draft from being delivered to a different session.
 */
export function isComposerSessionReady(
  routeSessionID: string | undefined,
  selectedSessionID: string | undefined,
  isSessionLoading: boolean,
): boolean {
  return routeSessionID !== undefined && routeSessionID === selectedSessionID && !isSessionLoading
}

/**
 * True when the composer still holds exactly the snapshot captured when an
 * async edit/undo operation started. Only then may that operation replace or
 * clear the composer — a draft typed while the request was in flight wins over
 * the late result.
 */
export function sameComposerDraft(a: ComposerDraft, b: ComposerDraft): boolean {
  if (a.text !== b.text || a.attachments.length !== b.attachments.length) return false
  return a.attachments.every((attachment, index) => attachment.uri === b.attachments[index]?.uri)
}
