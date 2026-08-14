import { test } from "node:test"
import assert from "node:assert/strict"
import { sanitizeSentryBreadcrumb, sanitizeSentryContext, sanitizeSentryEvent } from "./sentry-sanitize.ts"

const SECRET = "synthetic-secret-user:pass@private-host.local/project/file.ts?token=abc"

test("Sentry sanitizer removes synthetic secrets from every recursive event shape", () => {
  const event = {
    event_id: SECRET,
    message: `failed ${SECRET}`,
    transaction: SECRET,
    user: { id: SECRET, ip_address: "10.1.2.3", email: SECRET },
    request: {
      url: `https://${SECRET}`,
      method: `POST ${SECRET}`,
      headers: { authorization: SECRET, cookie: SECRET },
      cookies: SECRET,
      query_string: SECRET,
      data: { prompt: SECRET },
    },
    exception: {
      values: [{
        type: `Custom${SECRET}`,
        value: SECRET,
        stacktrace: {
          frames: [{
            filename: `/home/${SECRET}`,
            abs_path: `https://${SECRET}`,
            function: SECRET,
            context_line: SECRET,
            pre_context: [SECRET],
            post_context: [SECRET],
            vars: { password: SECRET },
            lineno: 12,
            colno: 4,
          }],
        },
      }],
    },
    breadcrumbs: [
      { category: "console", message: SECRET, data: { raw: SECRET } },
      { category: SECRET, message: SECRET, data: { reason: SECRET, url: SECRET, nested: [{ content: SECRET }] } },
    ],
    extra: { prompt: SECRET, nested: { arbitrary: SECRET, path: SECRET } },
    contexts: { runtime: { name: SECRET, code: SECRET }, trace: { span_id: SECRET } },
    tags: { host: SECRET, classification: SECRET },
    spans: [{ op: SECRET, description: SECRET, data: { query: SECRET } }],
    sdk: { name: SECRET, integrations: [SECRET] },
  }

  const clean = sanitizeSentryEvent(event)
  const serialized = JSON.stringify(clean)
  assert.ok(!serialized.includes(SECRET))
  assert.ok(!serialized.includes("private-host"))
  assert.equal(clean.user, undefined)
  assert.equal(clean.breadcrumbs.length, 1)
  assert.deepEqual(clean.request, { method: "<redacted>" })
  assert.deepEqual(clean.exception.values[0].stacktrace.frames[0], {
    filename: "<redacted-path>",
    abs_path: "<redacted-path>",
    lineno: 12,
    colno: 4,
  })
})

test("Sentry sanitizer retains only normalized bundle paths for source maps", () => {
  const clean = sanitizeSentryEvent({
    release: "opencode-mobile@0.4.14",
    dist: "0.4.14",
    exception: { values: [{ type: "TypeError", value: SECRET, stacktrace: { frames: [{ filename: "file:///data/index.android.bundle", lineno: 9 }] } }] },
  })
  assert.equal(clean.release, "opencode-mobile@0.4.14")
  assert.equal(clean.exception.values[0].stacktrace.frames[0].filename, "app:///index.android.bundle")
})

test("scope and breadcrumb sanitizers are safe before SDK scope insertion", () => {
  assert.ok(!JSON.stringify(sanitizeSentryContext({ extra: { rawError: SECRET }, label: SECRET })).includes(SECRET))
  assert.equal(sanitizeSentryBreadcrumb({ category: "console", message: SECRET }), null)
  assert.ok(!JSON.stringify(sanitizeSentryBreadcrumb({ category: SECRET, message: SECRET, data: { token: SECRET } })).includes(SECRET))
})
