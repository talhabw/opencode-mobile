import type { ConnectionErrorClass } from "./analytics-classify"

export enum AnalyticsEvent {
  AppOpened = "app_opened",
  ConnectionFormSubmitted = "connection_form_submitted",
  ConnectionAttempted = "connection_attempted",
  ConnectionSucceeded = "connection_succeeded",
  ConnectionFailed = "connection_failed",
  MessageSent = "message_sent",
  ResponseReceived = "response_received",
  DemoStarted = "demo_started",
  DemoStepAdvanced = "demo_step_advanced",
  DemoCompleted = "demo_completed",
  DemoExitedToConnect = "demo_exited_to_connect",
}

export type ConnectionTestSource = "onboarding" | "edit_test" | "sse"
export type AnalyticsProps = Record<string, unknown>
export type SanitizedAnalyticsProps = Record<string, string | number | boolean>

const SOURCES = new Set<ConnectionTestSource>(["onboarding", "edit_test", "sse"])
const ERROR_CLASSES = new Set<ConnectionErrorClass>([
  "malformed-url",
  "no-internet",
  "server-unreachable",
  "unauthorized",
  "tls-error",
  "timeout",
  "unknown",
])
const MODES = new Set(["quick", "advanced"])
const REPLIES = new Set(["once", "always", "reject"])
const OUTCOMES = new Set(["completed", "denied"])
const EVENTS = new Set<string>(Object.values(AnalyticsEvent))

function allowedString(value: unknown, values: Set<string>): value is string {
  return typeof value === "string" && values.has(value)
}

/** Runtime payload boundary. Every event has an exact property schema; unknown
 * keys, nested values, and invalid enum values are discarded. */
export function sanitizeAnalyticsProperties(event: AnalyticsEvent, input?: AnalyticsProps): SanitizedAnalyticsProps {
  const props = input ?? {}
  if (event === AnalyticsEvent.AppOpened) {
    return typeof props.is_first_open === "boolean" ? { is_first_open: props.is_first_open } : {}
  }
  if (event === AnalyticsEvent.ConnectionFormSubmitted) {
    return allowedString(props.mode, MODES) ? { mode: props.mode } : {}
  }
  if (
    event === AnalyticsEvent.ConnectionAttempted ||
    event === AnalyticsEvent.ConnectionSucceeded
  ) {
    return allowedString(props.source, SOURCES) ? { source: props.source } : {}
  }
  if (event === AnalyticsEvent.ConnectionFailed) {
    const clean: SanitizedAnalyticsProps = {}
    if (allowedString(props.source, SOURCES)) clean.source = props.source
    if (allowedString(props.error_class, ERROR_CLASSES)) clean.error_class = props.error_class
    return clean
  }
  if (event === AnalyticsEvent.DemoStepAdvanced) {
    const clean: SanitizedAnalyticsProps = {}
    if (props.step_index === 1) clean.step_index = 1
    if (props.step_name === "permission_replied") clean.step_name = "permission_replied"
    if (allowedString(props.reply, REPLIES)) clean.reply = props.reply
    return clean
  }
  if (event === AnalyticsEvent.DemoCompleted) {
    return allowedString(props.outcome, OUTCOMES) ? { outcome: props.outcome } : {}
  }
  if (event === AnalyticsEvent.DemoExitedToConnect) {
    return typeof props.reached_completion === "boolean" ? { reached_completion: props.reached_completion } : {}
  }
  return {}
}

export function hasTelemetryRuntimeConfig(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0
}

export function isAnalyticsEvent(value: unknown): value is AnalyticsEvent {
  return typeof value === "string" && EVENTS.has(value)
}
