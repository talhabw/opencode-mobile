/**
 * Promise.withResolvers polyfill (Hermes / SDK boundary).
 *
 * The @opencode/client shared event transport (shared-events.js) calls
 * `Promise.withResolvers()` every time it queues another read from the event
 * stream. Hermes on Android (React Native 0.81) does not implement it, so
 * every `raw.event.subscribe()` attempt throws
 * `TypeError: Promise.withResolvers is not a function` and the event stream
 * never connects. HTTP requests are unaffected, which leaves the app stuck on
 * the persistent "reconnecting" banner.
 *
 * This module installs a minimal, standards-compatible fallback (per
 * https://tc39.es/ecma262/#sec-promise.withresolvers) at the app/client
 * boundary: src/lib/sdk.ts imports it before @opencode/client, so the
 * fallback is in place before the SDK can call it. The global mutation is
 * narrowly conditional — an existing (e.g. native) implementation is never
 * replaced.
 */

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

/** Standalone implementation of Promise.withResolvers, spec-compatible. */
export function withResolvers<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Promise constructor viewed as possibly missing the withResolvers static. */
const promiseCtor = Promise as unknown as { withResolvers?: <T>() => Deferred<T> }

/**
 * Install the fallback on the global Promise only when it is absent.
 * Safe to call repeatedly; never clobbers a native or prior implementation.
 */
export function installPromiseWithResolvers(): void {
  if (typeof promiseCtor.withResolvers === "function") return
  promiseCtor.withResolvers = withResolvers
}

// Install at module load. This module is imported by src/lib/sdk.ts before
// @opencode/client, so the fallback exists before the SDK evaluates (and
// calls) Promise.withResolvers on platforms that lack it.
installPromiseWithResolvers()