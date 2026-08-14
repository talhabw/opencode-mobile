import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const dir = path.dirname(fileURLToPath(import.meta.url))
const messageBubble = readFileSync(path.join(dir, "MessageBubble.tsx"), "utf8")
const toolCallCard = readFileSync(path.join(dir, "ToolCallCard.tsx"), "utf8")

test("transcript roles use localized editorial treatment instead of AI chat decoration", () => {
  assert.match(messageBubble, /chat\.messageBubble\.you/)
  assert.match(messageBubble, /chat\.messageBubble\.assistant/)
  assert.match(messageBubble, /borderLeftColor: acc\.cur\.accent/)
  assert.doesNotMatch(messageBubble, /sparkles|#f0f0ff/i)
})

test("transcript restyle preserves expensive content and user actions", () => {
  assert.match(messageBubble, /<Markdown fontSize=\{fontSize\}>/)
  assert.match(messageBubble, /<ToolCallCard key=\{tool\.id\}/)
  assert.match(messageBubble, /onLongPress\(message\.id\)/)
  assert.match(messageBubble, /prev\.parts\[i\] !== next\.parts\[i\]/)
})

test("message failures remain visible without replacing transcript content", () => {
  assert.match(messageBubble, /message\.error &&/)
  assert.match(messageBubble, /accessibilityRole="alert"/)
  assert.match(messageBubble, /message\.error\.message/)
})

test("streaming uses bounded plain text and stable selector fallbacks", () => {
  assert.match(messageBubble, /isStreaming && text\.length > 2_000/)
  assert.match(messageBubble, /text\.slice\(-2_000\)/)
  assert.match(toolCallCard, /EMPTY_PENDING_QUESTIONS/)
  assert.doesNotMatch(toolCallCard, /state\.questions\[link\.sessionID\] \?\? \[\]/)
})
