import { test } from "node:test"
import assert from "node:assert/strict"
import { installPromiseWithResolvers, withResolvers, type Deferred } from "./promise-with-resolvers.ts"

// The @opencode/client shared event transport calls Promise.withResolvers() when it
// queues the next event-stream read; Hermes on Android lacks it. The app must
// provide a spec-compatible fallback — and must never touch a platform that
// already has an implementation.

// The test runner (Node) has a native Promise.withResolvers, so the
// module-level auto-install at import must have been a no-op here.
test("module auto-install preserves the native implementation", () => {
  assert.equal(typeof Promise.withResolvers, "function")
  assert.notEqual(Promise.withResolvers, withResolvers)
})

test("withResolvers: resolve fulfills the returned promise", async () => {
  const { promise, resolve } = withResolvers<string>()
  resolve("ok")
  assert.equal(await promise, "ok")
})

test("withResolvers: returned promise stays pending until settled", async () => {
  const { promise, resolve } = withResolvers<number>()
  let settled = false
  void promise.then(() => {
    settled = true
  })
  await new Promise((done) => setTimeout(done, 10))
  assert.equal(settled, false)
  resolve(42)
  await promise
  assert.equal(settled, true)
})

test("withResolvers: reject rejects the returned promise with the reason", async () => {
  const { promise, reject } = withResolvers<number>()
  const boom = new Error("boom")
  reject(boom)
  await assert.rejects(promise, boom)
})

test("withResolvers: resolve adopts a promise-like value", async () => {
  const { promise, resolve } = withResolvers<string>()
  resolve(Promise.resolve("adopted"))
  assert.equal(await promise, "adopted")
})

test("withResolvers: instances are independent", async () => {
  const first = withResolvers<string>()
  const second = withResolvers<string>()
  let secondSettled = false
  void second.promise.then(() => {
    secondSettled = true
  })
  first.resolve("first")
  assert.equal(await first.promise, "first")
  await new Promise((done) => setTimeout(done, 10))
  assert.equal(secondSettled, false)
  second.resolve("second")
  assert.equal(await second.promise, "second")
})

test("withResolvers: the shape the SDK streams with ({ done, value }) resolves", async () => {
  const { promise, resolve } = withResolvers<{ done: boolean; value?: string }>()
  resolve({ done: false, value: "event" })
  assert.deepEqual(await promise, { done: false, value: "event" })
})

const promiseCtor = Promise as unknown as { withResolvers?: unknown }

test("installPromiseWithResolvers: never replaces an existing implementation", () => {
  const native = promiseCtor.withResolvers
  assert.equal(typeof native, "function")
  const sentinel = () => ({ promise: Promise.resolve(1), resolve: () => {}, reject: () => {} })
  promiseCtor.withResolvers = sentinel
  try {
    installPromiseWithResolvers()
    assert.equal(promiseCtor.withResolvers, sentinel)
    // Repeated calls stay no-ops while an implementation exists.
    installPromiseWithResolvers()
    assert.equal(promiseCtor.withResolvers, sentinel)
  } finally {
    if (native !== undefined) promiseCtor.withResolvers = native
  }
})

test("installPromiseWithResolvers: installs the fallback only when missing", async () => {
  const native = promiseCtor.withResolvers
  try {
    delete promiseCtor.withResolvers
    installPromiseWithResolvers()
    assert.equal(promiseCtor.withResolvers, withResolvers)
    // The installed fallback behaves like the spec: { promise, resolve, reject }.
    const installed = promiseCtor.withResolvers as <T>() => Deferred<T>
    const { promise, resolve } = installed<number>()
    resolve(7)
    assert.equal(await promise, 7)
    // Installing again is harmless.
    installPromiseWithResolvers()
    assert.equal(promiseCtor.withResolvers, withResolvers)
  } finally {
    if (native !== undefined) promiseCtor.withResolvers = native
  }
})