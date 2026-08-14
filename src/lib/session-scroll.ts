export type BottomPinTrigger = "optimistic-send" | "content-change" | "layout-change"

export interface BottomPinDecision {
  trigger: BottomPinTrigger
  nearBottom: boolean
}

/** Inverted lists use offset zero as the newest-message position. */
export function shouldPinToBottom({ trigger, nearBottom }: BottomPinDecision): boolean {
  return trigger === "optimistic-send" || nearBottom
}

export interface ExpansionAnchorDecision {
  /** Signed content-height delta (new height minus old height). */
  delta: number
  /** Whether a row expansion is awaiting its layout change. */
  pending: boolean
}

/**
 * Offset adjustment that keeps a tapped row's header anchored while it
 * expands or collapses in an inverted transcript. Growing a row by `delta`
 * pushes the content above it up by `delta` relative to the viewport (offset
 * zero is the newest message), so the header stays put only if the offset
 * moves by the same signed `delta`; a collapse reports a negative delta and
 * moves the offset back down. Returns null when nothing should move: no
 * toggle is pending, or the delta is zero (the expansion has not changed the
 * content size yet — the caller should keep waiting). A non-null result also
 * means this particular content change must NOT bottom-pin.
 */
export function expansionAnchorDelta({ delta, pending }: ExpansionAnchorDecision): number | null {
  if (!pending || delta === 0) return null
  return delta
}
