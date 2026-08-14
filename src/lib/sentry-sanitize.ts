const REDACTED = "<redacted>"
const REDACTED_ERROR = "<redacted-error>"
const REDACTED_EVENT = "<redacted-event>"
const REDACTED_PATH = "<redacted-path>"

const SAFE_ERROR_TYPES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "AggregateError",
])
const SAFE_BREADCRUMB_MESSAGES = new Set([
  "app started",
  "connecting",
  "reconnect scheduled",
  "auth error - stopped retrying",
  "disconnected",
  "select",
  "active connection set",
  "active connection cleared",
])
const DROP_KEY = /(?:authorization|cookie|password|passwd|secret|token|api.?key|credential|prompt|code|content|source|raw|query|body|header|hostname|host|server|address|ip|user|email|username)/i
const PATH_KEY = /(?:^|_)(?:url|uri|path|filename|abs_path|module)(?:$|_)/i

type UnknownRecord = Record<string, unknown>

function record(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function safeBundlePath(value: unknown): string {
  return typeof value === "string" && value.includes("index.android.bundle")
    ? "app:///index.android.bundle"
    : REDACTED_PATH
}

function sanitizeFrame(frame: unknown): UnknownRecord | undefined {
  if (!record(frame)) return undefined
  const clean: UnknownRecord = {}
  if ("filename" in frame) clean.filename = safeBundlePath(frame.filename)
  if ("abs_path" in frame) clean.abs_path = safeBundlePath(frame.abs_path)
  for (const key of ["lineno", "colno", "instruction_addr", "image_addr"] as const) {
    if (typeof frame[key] === "number") clean[key] = frame[key]
  }
  if (typeof frame.in_app === "boolean") clean.in_app = frame.in_app
  if (typeof frame.platform === "string") clean.platform = REDACTED
  return clean
}

function sanitizeStacktrace(value: unknown): UnknownRecord | undefined {
  if (!record(value)) return undefined
  const frames = Array.isArray(value.frames) ? value.frames.map(sanitizeFrame).filter(Boolean) : []
  return frames.length ? { frames } : undefined
}

function sanitizeException(value: unknown): UnknownRecord | undefined {
  if (!record(value)) return undefined
  const values = Array.isArray(value.values)
    ? value.values
        .filter(record)
        .map((exception) => ({
          type: typeof exception.type === "string" && SAFE_ERROR_TYPES.has(exception.type) ? exception.type : "Error",
          value: REDACTED_ERROR,
          ...(sanitizeStacktrace(exception.stacktrace) ? { stacktrace: sanitizeStacktrace(exception.stacktrace) } : {}),
          ...(record(exception.mechanism)
            ? {
                mechanism: {
                  ...(typeof exception.mechanism.handled === "boolean" ? { handled: exception.mechanism.handled } : {}),
                  ...(typeof exception.mechanism.type === "string" ? { type: REDACTED } : {}),
                },
              }
            : {}),
        }))
    : []
  return values.length ? { values } : undefined
}

function sanitizeUnknown(value: unknown, key = ""): unknown {
  if (DROP_KEY.test(key)) return undefined
  if (PATH_KEY.test(key)) return REDACTED_PATH
  if (value === null || typeof value === "boolean" || typeof value === "number") return value
  if (typeof value === "string") return REDACTED
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item)).filter((item) => item !== undefined)
  if (!record(value)) return undefined
  const clean: UnknownRecord = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    const sanitized = sanitizeUnknown(childValue, childKey)
    if (sanitized !== undefined) clean[childKey] = sanitized
  }
  return clean
}

export function sanitizeSentryBreadcrumb(value: unknown): UnknownRecord | null {
  if (!record(value) || value.category === "console") return null
  const clean: UnknownRecord = {}
  clean.category = typeof value.category === "string" ? REDACTED : "event"
  clean.message =
    typeof value.message === "string" && SAFE_BREADCRUMB_MESSAGES.has(value.message) ? value.message : REDACTED_EVENT
  if (["debug", "info", "warning", "error", "fatal"].includes(String(value.level))) clean.level = value.level
  if (typeof value.timestamp === "number") clean.timestamp = value.timestamp
  if (record(value.data)) clean.data = sanitizeUnknown(value.data)
  return clean
}

/** Canonical final boundary for every Sentry event. It intentionally keeps
 * only symbolication coordinates and content-free/coarse metadata. */
export function sanitizeSentryEvent<T extends UnknownRecord>(event: T): T {
  const clean: UnknownRecord = {}
  if (typeof event.event_id === "string" && /^[a-f0-9]{32}$/i.test(event.event_id)) clean.event_id = event.event_id
  if (typeof event.timestamp === "number") clean.timestamp = event.timestamp
  if (typeof event.release === "string" && /^opencode-mobile@[0-9]+(?:\.[0-9]+){0,3}$/.test(event.release)) clean.release = event.release
  if (typeof event.dist === "string" && /^[0-9]+(?:\.[0-9]+){0,3}$/.test(event.dist)) clean.dist = event.dist
  for (const key of ["platform", "level", "environment"] as const) {
    if (typeof event[key] === "string") clean[key] = REDACTED
  }
  if (event.message !== undefined) clean.message = REDACTED_ERROR
  const exception = sanitizeException(event.exception)
  if (exception) clean.exception = exception
  if (Array.isArray(event.breadcrumbs)) {
    clean.breadcrumbs = event.breadcrumbs.map(sanitizeSentryBreadcrumb).filter((item) => item !== null)
  }
  if (record(event.request)) {
    clean.request = typeof event.request.method === "string" ? { method: REDACTED } : {}
  }
  if (event.transaction !== undefined) clean.transaction = REDACTED_EVENT
  for (const key of ["extra", "contexts", "tags", "spans", "sdk", "modules", "fingerprint"] as const) {
    if (event[key] !== undefined) clean[key] = sanitizeUnknown(event[key], key)
  }
  return clean as T
}

export function sanitizeSentryContext(value: Record<string, unknown>): Record<string, unknown> {
  return (sanitizeUnknown(value) as Record<string, unknown>) ?? {}
}
