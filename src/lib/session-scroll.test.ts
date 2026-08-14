import { test } from "node:test"
import assert from "node:assert/strict"
import { shouldPinToBottom } from "./session-scroll.ts"

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
