import assert from "node:assert/strict"
import test from "node:test"
import { normalizeFetchInput } from "./fetch-input.ts"

test("normalizes generated-client URL objects for React Native fetch", () => {
  assert.equal(normalizeFetchInput(new URL("http://127.0.0.1:4099/api/health")), "http://127.0.0.1:4099/api/health")
})

test("preserves string fetch inputs", () => {
  assert.equal(normalizeFetchInput("http://127.0.0.1:4099/api/health"), "http://127.0.0.1:4099/api/health")
})

test("normalizes Request inputs", () => {
  assert.equal(normalizeFetchInput(new Request("http://127.0.0.1:4099/api/health")), "http://127.0.0.1:4099/api/health")
})
