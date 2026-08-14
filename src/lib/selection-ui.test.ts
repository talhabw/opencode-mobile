import { expect, test } from "bun:test"
import { defaultActionDecision, selectorLabel } from "./selection-ui.ts"

test("default action distinguishes inheritance from a concrete switch", () => {
  expect(defaultActionDecision(false, true)).toBe("inherit")
  expect(defaultActionDecision(false, false)).toBe("inherit")
  expect(defaultActionDecision(true, true)).toBe("concrete")
  expect(defaultActionDecision(true, false)).toBe("unavailable")
})

test("selector labels never call an unresolved default Auto", () => {
  expect(selectorLabel(null, null, "Server default")).toBe("Server default")
  expect(selectorLabel(null, "Build", "Server default")).toBe("Build · Server default")
})
