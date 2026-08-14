import { test } from "node:test"
import assert from "node:assert/strict"
import { AnalyticsEvent, hasTelemetryRuntimeConfig, isAnalyticsEvent, sanitizeAnalyticsProperties } from "./analytics-events.ts"

const SECRET = "synthetic-secret-user:pass@private-host.local/project/file.ts"

test("analytics sanitizer enforces each event's exact primitive schema", () => {
  const cases = [
    [AnalyticsEvent.AppOpened, { is_first_open: true }, { is_first_open: true }],
    [AnalyticsEvent.ConnectionFormSubmitted, { mode: "quick" }, { mode: "quick" }],
    [AnalyticsEvent.ConnectionAttempted, { source: "onboarding" }, { source: "onboarding" }],
    [AnalyticsEvent.ConnectionSucceeded, { source: "edit_test" }, { source: "edit_test" }],
    [AnalyticsEvent.ConnectionFailed, { source: "sse", error_class: "timeout" }, { source: "sse", error_class: "timeout" }],
    [AnalyticsEvent.MessageSent, {}, {}],
    [AnalyticsEvent.ResponseReceived, {}, {}],
    [AnalyticsEvent.DemoStarted, {}, {}],
    [
      AnalyticsEvent.DemoStepAdvanced,
      { step_index: 1, step_name: "permission_replied", reply: "once" },
      { step_index: 1, step_name: "permission_replied", reply: "once" },
    ],
    [AnalyticsEvent.DemoCompleted, { outcome: "denied" }, { outcome: "denied" }],
    [AnalyticsEvent.DemoExitedToConnect, { reached_completion: false }, { reached_completion: false }],
  ] as const

  for (const [event, input, expected] of cases) {
    assert.deepEqual(sanitizeAnalyticsProperties(event, { ...input, unknown: SECRET, nested: { secret: SECRET } }), expected)
  }
})

test("analytics sanitizer drops wrong primitive types and invalid enum values", () => {
  assert.deepEqual(
    sanitizeAnalyticsProperties(AnalyticsEvent.ConnectionFailed, {
      source: SECRET,
      error_class: { raw: SECRET },
      url: SECRET,
    }),
    {},
  )
  assert.deepEqual(sanitizeAnalyticsProperties(AnalyticsEvent.AppOpened, { is_first_open: "true" }), {})
})

test("missing or blank runtime telemetry configuration is disabled", () => {
  assert.equal(hasTelemetryRuntimeConfig(undefined), false)
  assert.equal(hasTelemetryRuntimeConfig(""), false)
  assert.equal(hasTelemetryRuntimeConfig("  "), false)
  assert.equal(hasTelemetryRuntimeConfig("public-ingest-value"), true)
})

test("analytics event names have a runtime allowlist", () => {
  for (const event of Object.values(AnalyticsEvent)) assert.equal(isAnalyticsEvent(event), true)
  assert.equal(isAnalyticsEvent("prompt_captured"), false)
  assert.equal(isAnalyticsEvent({ event: AnalyticsEvent.AppOpened }), false)
})
