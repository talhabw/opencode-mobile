import assert from "node:assert/strict"
import test from "node:test"
import type { Part } from "./sdk.ts"
import { taskSubagentLink } from "./task-subagent.ts"

const part = (overrides: Partial<Part> = {}): Part => ({
  id: "part", messageID: "message", type: "tool", tool: "task", state: { status: "completed", metadata: { sessionId: "child", parentSessionId: "root" } }, ...overrides,
})

test("extracts only the canonical task metadata session id", () => {
  assert.deepEqual(taskSubagentLink(part()), { sessionID: "child", parentSessionID: "root" })
  assert.equal(taskSubagentLink(part({ tool: "bash" })), null)
  assert.equal(taskSubagentLink(part({ state: { status: "completed", metadata: { parentSessionId: "root" } } })), null)
  assert.equal(taskSubagentLink(part({ state: { status: "completed", metadata: { sessionId: "" } } })), null)
  assert.equal(taskSubagentLink(part({ state: { status: "completed", title: "child" } })), null)
})
