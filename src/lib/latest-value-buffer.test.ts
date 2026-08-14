import assert from "node:assert/strict"
import test from "node:test"
import { LatestValueBuffer } from "./latest-value-buffer.ts"

test("coalesces updates by key and commits the latest values", () => {
  const commits: string[][] = []
  const buffer = new LatestValueBuffer<string>(60_000, (values) => commits.push(values))

  buffer.push("first", "old")
  buffer.push("second", "other")
  buffer.push("first", "latest")
  buffer.flush()

  assert.deepEqual(commits, [["latest", "other"]])
})

test("flushes final values immediately", () => {
  const commits: string[][] = []
  const buffer = new LatestValueBuffer<string>(60_000, (values) => commits.push(values))

  buffer.push("part", "partial")
  buffer.push("part", "complete", true)

  assert.deepEqual(commits, [["complete"]])
})
