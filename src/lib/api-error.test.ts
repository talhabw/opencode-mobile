import { test } from "node:test"
import assert from "node:assert/strict"
import { ApiAuthError, apiStatusFor, isAuthError } from "./api-error.ts"

test("apiStatusFor maps generated client errors to HTTP semantics", () => {
  assert.equal(apiStatusFor({ _tag: "UnauthorizedError" }), 401)
  assert.equal(apiStatusFor({ _tag: "SessionNotFoundError" }), 404)
  assert.equal(apiStatusFor({ _tag: "MessageNotFoundError" }), 404)
  assert.equal(apiStatusFor({ cause: { status: 503 } }), 503)
  assert.equal(apiStatusFor(new Error("unknown")), undefined)
})

test("isAuthError: type guard matches only ApiAuthError instances", () => {
  assert.equal(isAuthError(new ApiAuthError(401, "nope")), true)
  assert.equal(isAuthError(new Error("some other error")), false)
  assert.equal(isAuthError("401"), false)
  assert.equal(isAuthError(undefined), false)
  assert.equal(isAuthError(null), false)
})
