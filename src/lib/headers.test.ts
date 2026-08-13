import { test } from "node:test"
import assert from "node:assert/strict"
import { buildRequestHeaders } from "./headers.ts"

// Directory/workspace scope is encoded in v2 request inputs, not headers.
test("omits auth headers when credentials are not provided", () => {
  const h = buildRequestHeaders({})
  assert.equal("x-opencode-directory" in h, false)
  assert.equal("Authorization" in h, false)
})

test("builds a Basic auth header from username and password", () => {
  const h = buildRequestHeaders({ auth: { username: "alice", password: "s3cret" } })
  assert.equal(h["Authorization"], `Basic ${btoa("alice:s3cret")}`)
  // Round-trips back to the credentials.
  assert.equal(atob(h["Authorization"].replace("Basic ", "")), "alice:s3cret")
})

test("sets only the Basic auth header", () => {
  const h = buildRequestHeaders({
    auth: { username: "u", password: "p" },
  })
  assert.equal(h["Authorization"], `Basic ${btoa("u:p")}`)
})

// Hermes' `btoa` is Latin1-only and throws a RangeError on non-ASCII input.
// The auth header must be built with a UTF-8-safe base64 helper so a
// non-ASCII username/password never throws (which otherwise surfaces as an
// unhandled rejection and a stuck connect spinner).

test("ASCII credentials produce the exact same header as plain btoa (no behavior change)", () => {
  const h = buildRequestHeaders({ auth: { username: "alice", password: "s3cret" } })
  assert.equal(h["Authorization"], `Basic ${btoa("alice:s3cret")}`)
})

test("non-ASCII username does not throw and round-trips back to the credentials", () => {
  const auth = { username: "usér", password: "s3cret" }
  assert.doesNotThrow(() => buildRequestHeaders({ auth }))
  const h = buildRequestHeaders({ auth })
  const b64 = h["Authorization"].replace("Basic ", "")
  const decoded = decodeURIComponent(escape(atob(b64)))
  assert.equal(decoded, `${auth.username}:${auth.password}`)
})

test("non-ASCII password does not throw and round-trips back to the credentials", () => {
  const auth = { username: "admin", password: "pässwörd123" }
  assert.doesNotThrow(() => buildRequestHeaders({ auth }))
  const h = buildRequestHeaders({ auth })
  const b64 = h["Authorization"].replace("Basic ", "")
  const decoded = decodeURIComponent(escape(atob(b64)))
  assert.equal(decoded, `${auth.username}:${auth.password}`)
})
