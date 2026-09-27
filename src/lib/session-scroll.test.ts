import { test } from "node:test"
import assert from "node:assert/strict"
import { shouldPinToBottom, anchoredAdjustment, nextAnchoredOffset } from "./session-scroll.ts"

test("optimistic sends always pin an inverted transcript", () => {
  assert.equal(shouldPinToBottom({ trigger: "optimistic-send", nearBottom: false }), true)
})

test("content and layout changes follow a user who is near the bottom", () => {
  assert.equal(shouldPinToBottom({ trigger: "content-change", nearBottom: true }), true)
  assert.equal(shouldPinToBottom({ trigger: "layout-change", nearBottom: true }), true)
})

test("content and layout changes do not move a user reading history", () => {
  assert.equal(shouldPinToBottom({ trigger: "content-change", nearBottom: false }), false)
  assert.equal(shouldPinToBottom({ trigger: "layout-change", nearBottom: false }), false)
})

test("anchor adjustment moves the offset by the tapped card's own height delta", () => {
  // A single expansion's layout lands as several passes; each pass reports a
  // new height for the anchored card and the signed delta is applied.
  assert.equal(anchoredAdjustment({ key: "m1:bash", anchorKey: "m1:bash", previousHeight: 100, height: 220 }), 120)
  assert.equal(anchoredAdjustment({ key: "m1:bash", anchorKey: "m1:bash", previousHeight: 220, height: 240 }), 20)
  assert.equal(anchoredAdjustment({ key: "m1:bash", anchorKey: "m1:bash", previousHeight: 240, height: 100 }), -140)
})

test("anchor adjustment ignores layout reports from unrelated elements", () => {
  // The 500ms pending window may overlap streaming growth in OTHER rows or
  // cards; those layout reports must never shift the tapped card's anchor.
  assert.equal(anchoredAdjustment({ key: "m1:read", anchorKey: "m1:bash", previousHeight: 100, height: 240 }), null)
  assert.equal(anchoredAdjustment({ key: "m2:bash", anchorKey: "m1:bash", previousHeight: 100, height: 240 }), null)
})

test("anchor adjustment does nothing without a pending toggle", () => {
  assert.equal(anchoredAdjustment({ key: "m1:bash", anchorKey: null, previousHeight: 100, height: 240 }), null)
})

test("anchor adjustment baselines the first pass when the pre-tap height is unknown", () => {
  // A card that was never laid out before the tap reports its post-tap height
  // first; that pass is the baseline (0, keep waiting), the next pass carries
  // the real delta.
  assert.equal(anchoredAdjustment({ key: "m1:bash", anchorKey: "m1:bash", previousHeight: null, height: 220 }), 0)
  assert.equal(anchoredAdjustment({ key: "m1:bash", anchorKey: "m1:bash", previousHeight: 220, height: 240 }), 20)
})

test("anchored offsets accumulate across layout passes of the same expansion", () => {
  // onScroll is throttled, so between two layout passes the reported offset is
  // stale; anchoring must accumulate on the last anchored offset instead.
  let offset = 250
  offset = nextAnchoredOffset(offset, 120)
  offset = nextAnchoredOffset(offset, 60)
  assert.equal(offset, 430)
})

test("anchored offsets move back on collapse and clamp at the inverted bottom", () => {
  assert.equal(nextAnchoredOffset(430, -60), 370)
  assert.equal(nextAnchoredOffset(20, -80), 0)
  assert.equal(nextAnchoredOffset(0, -80), 0)
})

test("expand then collapse through the same card nets to the starting offset", () => {
  // Multi-pass expansion followed by collapse must land the viewport exactly
  // where it started, keeping the tapped header pinned throughout.
  const passes = [
    { previousHeight: 100, height: 220 },
    { previousHeight: 220, height: 240 },
    { previousHeight: 240, height: 100 },
  ]
  let offset = 300
  for (const pass of passes) {
    const adjustment = anchoredAdjustment({ key: "m1:bash", anchorKey: "m1:bash", ...pass })
    assert.notEqual(adjustment, null)
    offset = nextAnchoredOffset(offset, adjustment ?? 0)
  }
  assert.equal(offset, 300)
})

test("unrelated streaming growth never moves the anchored offset", () => {
  // Simulate the regression the anchor must prevent: the tapped card expands
  // (+120) while an unrelated card streams (+50). The unrelated report
  // returns null and must not be accumulated, so only the tapped card's own
  // +120 lands.
  let offset = 100
  offset = nextAnchoredOffset(offset, 120)
  const unrelated = anchoredAdjustment({ key: "m1:read", anchorKey: "m1:bash", previousHeight: 80, height: 130 })
  assert.equal(unrelated, null)
  assert.equal(offset, 220)
})
