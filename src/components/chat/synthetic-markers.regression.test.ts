import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

// Synthetic marker rows (server-injected `<shell …>` / `<subagent …>` tags)
// must never regress to the raw-tag system row, and read-tool cards must show
// their output. The runtime is React Native so components can't be rendered
// under node:test (see wide-content-scroll.regression.test.ts); these checks
// assert on the exact source markers that prove the wiring exists.

function readComponent(relativePath: string): string {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  return readFileSync(path.join(dir, relativePath), "utf8")
}

test("MessageBubble routes the subagent presentation to the dedicated marker row", () => {
  const src = readComponent("MessageBubble.tsx")
  assert.match(src, /presentation === "subagent"/)
  assert.match(src, /<SubagentMessage message=\{message\} isDark=\{isDark\} \/>/)
  // Synthetic shell tags reuse the existing shell row via presentation === "shell".
  assert.match(src, /presentation === "shell"/)
})

test("SubagentMessage opens the exact child session via the cached-session resolution path", () => {
  const src = readComponent("SyntheticMessage.tsx")
  assert.match(src, /findCachedSession\(subagent\.refID/)
  assert.match(src, /clientForDirectory\(directory\)/)
  assert.match(src, /pathname: "\/session\/\[id\]"/)
  assert.match(src, /params: \{ id: session\.id/)
})

test("ReadDetail renders read tool output in a bounded monospace code block", () => {
  const src = readComponent("ToolCallCard.tsx")
  assert.match(src, /<ReadDetail input=\{input\} output=\{output\} isDark=\{isDark\} \/>/)
  const detail = src.slice(src.indexOf("function ReadDetail"), src.indexOf("function WriteDetail"))
  assert.match(detail, /out !== undefined && out\.length > 0/)
  assert.match(detail, /numberOfLines=\{80\}/)
})
