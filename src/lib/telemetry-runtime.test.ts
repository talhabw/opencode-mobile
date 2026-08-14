import { test } from "node:test"
import assert from "node:assert/strict"
import { transitionTelemetryRuntime, type TelemetryRuntime } from "./telemetry-runtime.ts"

test("consent allow, revoke, and re-enable invoke only gated runtime transitions", async () => {
  let sentry = false
  let analytics = false
  const calls: string[] = []
  const runtime: TelemetryRuntime = {
    sentryEnabled: () => sentry,
    analyticsEnabled: () => analytics,
    initSentry: () => { sentry = true; calls.push("sentry:on") },
    initAnalytics: () => { analytics = true; calls.push("analytics:on") },
    trackAppOpened: () => calls.push("app:opened"),
    disableSentry: async () => { sentry = false; calls.push("sentry:off") },
    shutdownAnalytics: async () => { analytics = false; calls.push("analytics:off") },
  }

  await transitionTelemetryRuntime(true, runtime)
  await transitionTelemetryRuntime(false, runtime)
  await transitionTelemetryRuntime(true, runtime)

  assert.deepEqual(calls, [
    "sentry:on",
    "analytics:on",
    "app:opened",
    "sentry:off",
    "analytics:off",
    "sentry:on",
    "analytics:on",
    "app:opened",
  ])
})

test("denied consent never initializes telemetry", async () => {
  const calls: string[] = []
  await transitionTelemetryRuntime(false, {
    sentryEnabled: () => false,
    analyticsEnabled: () => false,
    initSentry: () => calls.push("sentry:on"),
    initAnalytics: () => calls.push("analytics:on"),
    trackAppOpened: () => calls.push("app:opened"),
    disableSentry: async () => calls.push("sentry:off"),
    shutdownAnalytics: async () => calls.push("analytics:off"),
  })
  assert.deepEqual(calls, ["sentry:off", "analytics:off"])
})
