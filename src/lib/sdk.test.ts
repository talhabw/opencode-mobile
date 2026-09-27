import assert from "node:assert/strict"
import test from "node:test"
import { mock } from "bun:test"

// sdk.ts imports expo/fetch, which pulls React Native internals under Bun. The
// wrapper behavior under test only needs a fetch-shaped function, so replace it
// before the SDK module is evaluated.
type RecordedRequest = {
  url: URL
  method: string
  body: unknown
  headers: Headers
  signal?: AbortSignal | null
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const noContent = () => new Response(null, { status: 204 })

let recorded: RecordedRequest[] = []
let handler: (request: RecordedRequest) => Response = () => json({ _tag: "UnknownError", message: "route not found" }, 404)

mock.module("expo/fetch", () => ({
  fetch: async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input))
    const request: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: new Headers(init?.headers),
      signal: init?.signal,
    }
    recorded.push(request)
    return handler(request)
  },
}))

const { createClient, ApiError, ApiAuthError, isAuthError, V2_REQUIRED_ERROR } = await import("./sdk.ts")

const start = (routes: Record<string, (request: RecordedRequest) => Response>) => {
  recorded = []
  handler = (request) =>
    routes[`${request.method} ${request.url.pathname}`]?.(request) ??
    json({ _tag: "UnknownError", message: "route not found" }, 404)
}

const sessionInfo = (id: string, title = "Session") => ({
  id,
  projectID: "project",
  title,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  location: { directory: "/work" },
})

test("health reads the released identity from GET /api/info", async () => {
  start({ "GET /api/info": () => json({ version: "2.0.18", pid: 1, urls: [], paths: { tmp: "/tmp" } }) })
  const client = createClient({ baseUrl: "http://server.test", auth: { username: "opencode", password: "devpassword" } })

  assert.deepEqual(await client.global.health(), { healthy: true, version: "2.0.18" })
  assert.deepEqual(recorded.map((request) => request.url.pathname), ["/api/info"])
  assert.equal(recorded[0].headers.get("authorization"), `Basic ${btoa("opencode:devpassword")}`)
})

test("a server without the v2 identity fails the connection test with the v2-required error", async () => {
  start({})
  const missing = await createClient({ baseUrl: "http://server.test" })
    .global.health()
    .then(() => null, (error: unknown) => error)
  assert.ok(missing instanceof ApiError)
  assert.equal(missing.status, 404)
  assert.equal(missing.message, "API Error: 404")

  start({ "GET /api/info": () => json({ status: "ok" }) })
  await assert.rejects(
    () => createClient({ baseUrl: "http://server.test" }).global.health(),
    (error: Error) => error.message === V2_REQUIRED_ERROR,
  )
})

test("auth failures become ApiAuthError regardless of the error body", async () => {
  start({ "GET /api/agent": () => json({ _tag: "UnauthorizedError", message: "bad credentials" }, 401) })
  const unauthorized = await createClient({ baseUrl: "http://server.test" })
    .agent.list()
    .then(() => null, (error: unknown) => error)
  assert.ok(unauthorized instanceof ApiAuthError)
  assert.equal(unauthorized.status, 401)
  assert.equal(isAuthError(unauthorized), true)

  // The documented server body is JSON, but a plain-text 401 must classify the
  // same way: the generated client cannot parse a non-JSON declared error.
  start({ "GET /api/agent": () => new Response("Unauthorized", { status: 401, headers: { "content-type": "text/plain" } }) })
  const plain = await createClient({ baseUrl: "http://server.test" })
    .agent.list()
    .then(() => null, (error: unknown) => error)
  assert.ok(plain instanceof ApiAuthError)
  assert.equal(plain.status, 401)

  start({ "GET /api/agent": () => json({ _tag: "ForbiddenError", message: "forbidden" }, 403) })
  const forbidden = await createClient({ baseUrl: "http://server.test" })
    .agent.list()
    .then(() => null, (error: unknown) => error)
  assert.ok(forbidden instanceof ApiAuthError)
  assert.equal(forbidden.status, 403)
})

test("directory scope is sent as location[directory] on every operation", async () => {
  start({
    "GET /api/agent": () => json({ location: { directory: "/work/proj" }, data: [] }),
    "GET /api/session": () => json({ data: [], cursor: {} }),
  })
  const client = createClient({ baseUrl: "http://server.test", directory: "/work/proj" })

  await client.agent.list()
  await client.session.list()

  assert.equal(recorded[0].url.searchParams.get("location[directory]"), "/work/proj")
  assert.equal(recorded[1].url.searchParams.get("directory"), "/work/proj")
  assert.equal(recorded[1].url.searchParams.has("workspace"), false)
})

test("session and message pages normalize through the wrapper cursor shape", async () => {
  start({
    "GET /api/session": () => json({ data: [sessionInfo("ses_1")], cursor: { next: "cursor-1" } }),
    "GET /api/session/ses_1/message": () => json({ data: [{ id: "msg_1", type: "user", time: { created: 1 }, text: "hi" }], cursor: {} }),
  })
  const client = createClient({ baseUrl: "http://server.test" })

  const page = await client.session.page({ limit: 50, parentID: null })
  assert.equal(page.data[0].id, "ses_1")
  assert.equal(page.cursor.next, "cursor-1")
  assert.equal(recorded[0].url.searchParams.get("order"), "desc")
  assert.equal(recorded[0].url.searchParams.get("parentID"), "null")

  const messages = await client.session.messages("ses_1")
  assert.equal(recorded[1].url.searchParams.get("order"), "asc")
  assert.equal(messages[0].info.presentation, "user")
  assert.equal(messages[0].parts[0].text, "hi")
})

test("session.rename PATCHes the session and re-reads the normalized result", async () => {
  start({
    "PATCH /api/session/ses_1": () => noContent(),
    "GET /api/session/ses_1": () => json({ data: sessionInfo("ses_1", "Renamed") }),
  })
  const client = createClient({ baseUrl: "http://server.test" })

  const session = await client.session.rename("ses_1", "Renamed")

  assert.equal(session.title, "Renamed")
  assert.equal(recorded[0].method, "PATCH")
  assert.deepEqual(recorded[0].body, { title: "Renamed" })
})

test("session.command posts the released {name, text, files} body after agent/model switches", async () => {
  start({
    "POST /api/session/ses_1/agent": () => noContent(),
    "POST /api/session/ses_1/model": () => noContent(),
    "POST /api/session/ses_1/command": () => noContent(),
  })
  const client = createClient({ baseUrl: "http://server.test" })

  await client.session.command("ses_1", {
    command: "review",
    arguments: "focus",
    agent: "plan",
    model: { providerID: "provider", modelID: "model" },
    variant: "deep",
    parts: [{ type: "file", mime: "image/png", url: "data:image/png;base64,YQ==", filename: "a.png" }],
  })

  assert.deepEqual(recorded.map((request) => `${request.method} ${request.url.pathname}`), [
    "POST /api/session/ses_1/agent",
    "POST /api/session/ses_1/model",
    "POST /api/session/ses_1/command",
  ])
  assert.deepEqual(recorded[1].body, { model: { providerID: "provider", id: "model", variant: "deep" } })
  assert.deepEqual(recorded[2].body, {
    name: "review",
    text: "focus",
    files: [{ uri: "data:image/png;base64,YQ==", name: "a.png" }],
  })
})

test("interrupt uses ?resume and permission replies use {decision}", async () => {
  start({
    "POST /api/session/ses_1/interrupt": () => json({ interrupted: true }),
    "POST /api/session/ses_1/permission/per_1/reply": () => noContent(),
  })
  const client = createClient({ baseUrl: "http://server.test" })

  assert.deepEqual(await client.session.interrupt("ses_1", true), { interrupted: true })
  assert.equal(recorded[0].url.searchParams.get("resume"), "true")

  assert.equal(await client.permission.reply("per_1", "always", "ses_1"), true)
  assert.deepEqual(recorded[1].body, { decision: "always" })
})

test("form discovery and cancellation use the released routes", async () => {
  start({
    "GET /api/form": () => json({
      location: { directory: "/work" },
      data: [{ id: "frm_1", sessionID: "ses_1", title: "Questions", metadata: { kind: "question" }, fields: [] }],
    }),
    "DELETE /api/session/ses_1/form/frm_1": () => noContent(),
  })
  const client = createClient({ baseUrl: "http://server.test", directory: "/work" })

  const forms = await client.form.requestList()
  assert.equal(forms.length, 1)
  assert.equal(recorded[0].url.searchParams.get("location[directory]"), "/work")

  await client.form.cancel({ sessionID: "ses_1", formID: "frm_1" })
  assert.equal(recorded[1].method, "DELETE")
  assert.equal(recorded[1].url.pathname, "/api/session/ses_1/form/frm_1")
})

test("provider.list assembles the normalized catalog from the released endpoints", async () => {
  const model = {
    id: "m",
    modelID: "m",
    providerID: "p",
    name: "Model",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }],
    limit: { context: 10, output: 5 },
    variants: [{ id: "fast" }],
    status: "active",
    enabled: true,
    time: { released: 0 },
  }
  start({
    "GET /api/provider": () => json({ location: { directory: "" }, data: [{ id: "p", name: "Provider", activation: "enabled", package: "x" }] }),
    "GET /api/model": () => json({ location: { directory: "" }, data: [model] }),
    "GET /api/model/default": () => json({ location: { directory: "" }, data: model }),
  })

  const catalog = await createClient({ baseUrl: "http://server.test" }).provider.list()
  assert.deepEqual(catalog.connected, ["p"])
  assert.equal(catalog.all[0].models.m.id, "m")
  assert.deepEqual(catalog.default, { p: "m" })
})

test("events normalize the released SSE stream and preserve unknown events", async () => {
  const frames = [
    { type: "session.execution.started", data: { sessionID: "ses_1" } },
    { type: "session.text.started", data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0 } },
    { type: "session.text.delta", data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, delta: "hello" } },
    { type: "server.connected", data: {} },
  ]
  start({
    "GET /api/event": (request) => {
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
          request.signal?.addEventListener("abort", () => {
            try { controller.close() } catch {}
          })
        },
        cancel() {},
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    },
  })

  const controller = new AbortController()
  const events: Array<{ type: string; properties: Record<string, unknown> }> = []
  for await (const event of createClient({ baseUrl: "http://server.test" }).global.events(controller.signal)) {
    events.push(event as { type: string; properties: Record<string, unknown> })
    if (events.length === frames.length) break
  }
  controller.abort()

  assert.deepEqual(events.map((event) => event.type), [
    "session.status",
    "message.part.updated",
    "message.part.updated",
    "server.connected",
  ])
  assert.deepEqual(events[0].properties, { sessionID: "ses_1", status: { type: "busy" } })
  assert.equal((events[2].properties.part as { text: string }).text, "hello")
})

test("event stream auth failures become ApiAuthError", async () => {
  start({ "GET /api/event": () => json({ _tag: "UnauthorizedError", message: "no" }, 401) })
  const iterator = createClient({ baseUrl: "http://server.test" }).global.events()[Symbol.asyncIterator]()

  await assert.rejects(
    () => iterator.next(),
    (error: unknown) => error instanceof ApiAuthError && error.status === 401,
  )
})
