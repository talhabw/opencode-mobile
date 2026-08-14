import { test } from "node:test"
import assert from "node:assert/strict"
import { shouldPinToBottom, expansionAnchorDelta } from "./session-scroll.ts"

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

test("expansion anchor moves the offset by the signed content delta in both directions", () => {
  assert.equal(expansionAnchorDelta({ delta: 120, pending: true }), 120)
  assert.equal(expansionAnchorDelta({ delta: -80, pending: true }), -80)
})

test("expansion anchor does nothing without a pending toggle", () => {
  assert.equal(expansionAnchorDelta({ delta: 120, pending: false }), null)
  assert.equal(expansionAnchorDelta({ delta: -120, pending: false }), null)
})

test("expansion anchor keeps waiting when the content size has not changed yet", () => {
  assert.equal(expansionAnchorDelta({ delta: 0, pending: true }), null)
})
