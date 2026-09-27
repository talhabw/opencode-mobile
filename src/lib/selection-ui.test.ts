import { expect, test } from "bun:test"
import { defaultActionDecision, selectorLabel } from "./selection-ui.ts"

test("default action distinguishes inheritance from a concrete switch", () => {
  expect(defaultActionDecision(false, true)).toBe("inherit")
  expect(defaultActionDecision(false, false)).toBe("inherit")
  expect(defaultActionDecision(true, true)).toBe("concrete")
  expect(defaultActionDecision(true, false)).toBe("unavailable")
})

test("selector labels show the concrete resolved value without annotation", () => {
  expect(selectorLabel(null, "Build")).toBe("Build")
  expect(selectorLabel(null, null)).toBe("")
  expect(selectorLabel(null, null, "Plan")).toBe("Plan")
  expect(selectorLabel("Plan", "Build")).toBe("Plan")
})
