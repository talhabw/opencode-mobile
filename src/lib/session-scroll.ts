export type BottomPinTrigger = "optimistic-send" | "content-change" | "layout-change"

export interface BottomPinDecision {
  trigger: BottomPinTrigger
  nearBottom: boolean
}

/** Inverted lists use offset zero as the newest-message position. */
export function shouldPinToBottom({ trigger, nearBottom }: BottomPinDecision): boolean {
  return trigger === "optimistic-send" || nearBottom
}
