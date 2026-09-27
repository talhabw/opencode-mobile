export type BottomPinTrigger = "optimistic-send" | "content-change" | "layout-change"

export interface BottomPinDecision {
  trigger: BottomPinTrigger
  nearBottom: boolean
}

/** Inverted lists use offset zero as the newest-message position. */
export function shouldPinToBottom({ trigger, nearBottom }: BottomPinDecision): boolean {
  return trigger === "optimistic-send" || nearBottom
}

export interface AnchoredElementDecision {
  /** Message-scoped key of the element that just reported a layout height. */
  key: string
  /** Key of the element being anchored; null when no expansion is pending. */
  anchorKey: string | null
  /** The anchored element's height from its previous layout pass. */
  previousHeight: number | null
  /** The anchored element's freshly measured height. */
  height: number
}

/**
 * Signed offset adjustment that keeps a tapped card's header anchored while
 * that card expands or collapses in an inverted transcript. Only the tapped
 * card's OWN measured height changes are attributed to the anchor: a layout
 * report from any other element (or with no anchor pending) returns null, so
 * content growth from unrelated streaming rows can never shift the tapped
 * header. Growing a row by `delta` pushes the content above it up by `delta`
 * relative to the viewport (offset zero is the newest message), so the header
 * stays put only if the offset moves by the same signed delta; a collapse
 * reports a negative delta and moves the offset back down. A non-null result
 * also means this layout change must NOT bottom-pin, or the snap to offset 0
 * would yank the tapped header back to the bottom mid-settling.
 *
 * Returns null when the report is not part of the anchored element's settling
 * (the normal pin decision applies). Returns 0 when the pre-tap height is
 * unknown — that first pass becomes the baseline and the caller must keep
 * waiting for the passes that carry the real deltas.
 */
export function anchoredAdjustment({ key, anchorKey, previousHeight, height }: AnchoredElementDecision): number | null {
  if (anchorKey === null || key !== anchorKey) return null
  if (previousHeight === null) return 0
  return height - previousHeight
}

/**
 * Offset that keeps the tapped card anchored after one of its layout passes.
 * Must accumulate on top of the LAST ANCHORED offset rather than a fresh
 * onScroll sample: scroll events are throttled, so reading the reported
 * offset between two layout passes of the same expansion would scroll back by
 * the first pass's delta. Clamps at 0 (the inverted-list bottom).
 */
export function nextAnchoredOffset(currentOffset: number, delta: number): number {
  return Math.max(0, currentOffset + delta)
}
