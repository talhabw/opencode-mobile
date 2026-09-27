// Pure reply lifecycle and rollback rules for PermissionPrompt. Kept separate
// from the component so they are unit-testable, mirroring the
// question-prompt.ts / QuestionPrompt.tsx split.

export type PermissionReply = "once" | "always" | "reject"

/**
 * Reply progress for one prompt. A failed reply must return to "idle" so the
 * buttons are usable again after the parent restores the prompt: an immediate
 * failure (offline, rejected credentials) must not strand a permanently dead
 * prompt. A successful reply stays "done" so a prompt that lingers (or is
 * re-delivered) cannot be answered twice.
 */
export type PermissionReplyPhase = "idle" | "sending" | "done"

export function permissionReplyPhaseAfter(
  current: PermissionReplyPhase,
  succeeded: boolean,
): PermissionReplyPhase {
  if (current !== "sending") return current
  return succeeded ? "done" : "idle"
}

/**
 * `onReply` handlers may be fire-and-forget (demo, older call sites) and
 * resolve nothing; only an explicit `false` means the reply failed.
 */
export function permissionReplySucceeded(result: void | boolean): boolean {
  return result !== false
}

/**
 * Merge a failed reply's request back into its session bucket. Only the
 * request that failed is re-added, and only when it is not already present:
 * replacing the whole bucket with a pre-reply snapshot would resurrect other
 * requests that were resolved (by SSE or a refresh) while this reply was in
 * flight. Returns null when there is nothing to change.
 */
export function restoreFailedPermission<T extends { id: string }>(
  bucket: readonly T[] | undefined,
  request: T | undefined,
): T[] | null {
  if (!request) return null
  const current = bucket ?? []
  if (current.some((item) => item.id === request.id)) return null
  return [...current, request]
}
