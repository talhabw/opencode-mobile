import { test } from "node:test"
import assert from "node:assert/strict"
import { sessionInListScope } from "./session-list-scope.ts"

test("sessionInListScope: all scope admits every directory", () => {
  assert.equal(sessionInListScope("all", "/home/user/proj", "/elsewhere"), true)
  assert.equal(sessionInListScope("all", null, null), true)
})

test("sessionInListScope: workspace scope without an active directory is unfiltered", () => {
  // A connection with no directory set queries the server unscoped, so the
  // live path must match that behavior.
  assert.equal(sessionInListScope("workspace", null, "/anything"), true)
  assert.equal(sessionInListScope("workspace", undefined, undefined), true)
})

test("sessionInListScope: workspace scope matches the active directory exactly", () => {
  assert.equal(sessionInListScope("workspace", "/home/user/proj", "/home/user/proj"), true)
  assert.equal(sessionInListScope("workspace", "/home/user/proj", "/home/user/other"), false)
})

test("sessionInListScope: subdirectories are a different workspace, matching server behavior", () => {
  // Verified against opencode serve: GET /api/session?directory=X filters by
  // exact location.directory; querying a parent does not include sessions
  // created in a child directory.
  assert.equal(sessionInListScope("workspace", "/home/user/proj", "/home/user/proj/sub"), false)
})

test("sessionInListScope: trailing separators are normalized before comparing", () => {
  assert.equal(sessionInListScope("workspace", "/home/user/proj", "/home/user/proj/"), true)
  assert.equal(sessionInListScope("workspace", "/home/user/proj/", "/home/user/proj"), true)
})

test("sessionInListScope: missing session directory never matches a scoped workspace", () => {
  assert.equal(sessionInListScope("workspace", "/home/user/proj", null), false)
  assert.equal(sessionInListScope("workspace", "/home/user/proj", ""), false)
})
