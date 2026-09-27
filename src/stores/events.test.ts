import assert from "node:assert/strict"
import test, { after } from "node:test"
import { mock } from "bun:test"
import type { MessageWithParts, Session } from "../lib/sdk"

// Module mocks in this suite replace real modules process-wide, and other
// store tests import the same modules (connections.test.ts real, sessions
// test with its own SDK mock). Reset the registry when this file is done.
after(() => mock.restore())

// events.ts (and the sessions store it drives) import the network SDK, the
// connection/settings stores, and the notification/Sentry/analytics wrappers.
// This suite exercises the reconnect resync and the SSE status switch, so all
// of those are replaced before the stores are evaluated.
mock.module("../lib/sdk", () => ({
  ApiError: class ApiError extends Error {
    readonly status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
  isAuthError: () => false,
  // The real connection store is imported by this suite; its module namespace
  // must carry these exports even though the tests inject clients directly.
  createClient: () => ({}),
  V2_REQUIRED_ERROR: "An OpenCode v2 server is required",
}))

mock.module("../lib/sentry", () => ({ addBreadcrumb: () => {} }))

mock.module("../lib/analytics", () => ({
  AnalyticsEvent: {
    MessageSent: "message_sent",
    ResponseReceived: "response_received",
    ConnectionAttempted: "connection_attempted",
    ConnectionSucceeded: "connection_succeeded",
    ConnectionFailed: "connection_failed",
  },
  // The real connection store is imported by this suite and calls this in its
  // testConnection catch path.
  classifyConnectionError: () => "unknown",
  track: () => {},
}))

mock.module("../lib/store-review", () => ({ recordSuccessfulSession: async () => {} }))
mock.module("../lib/notifications", () => ({ send: async () => {} }))

mock.module("./settings", () => ({
  useSettings: { getState: () => ({ pageSize: 20, sessionListScope: "workspace" }) },
}))

// The real connection store is imported below (connections.test.ts needs it
// real too), so its native dependencies are mocked compatibly instead of
// replacing the module itself.
mock.module("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}))

mock.module("expo-crypto", () => ({
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}))

const { useConnections } = await import("./connections.ts")
const { useEvents } = await import("./events.ts")
const { useSessions } = await import("./sessions.ts")

interface EventInput {
  type: string
  properties: Record<string, unknown>
}

interface PendingPermissionInput {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
}

interface FakeClient {
  global: { events: (signal?: AbortSignal) => AsyncGenerator<EventInput> }
  permission: { list: () => Promise<PendingPermissionInput[]> }
  form: { requestList: () => Promise<unknown[]> }
  session: {
    active: () => Promise<Record<string, unknown>>
    page: (params?: unknown, timeoutMs?: number) => Promise<{ data: Session[]; cursor: Record<string, never> }>
    list: (params?: unknown, timeoutMs?: number) => Promise<Session[]>
    messagePage: (sessionID: string, params?: unknown) => Promise<{ data: MessageWithParts[]; cursor: Record<string, never> }>
  }
}

interface FakeOptions {
  events?: EventInput[]
  permissions?: () => Promise<PendingPermissionInput[]>
  forms?: () => Promise<unknown[]>
  active?: () => Promise<Record<string, unknown>>
  page?: (params?: unknown, timeoutMs?: number) => Promise<{ data: Session[]; cursor: Record<string, never> }>
  messagePage?: (sessionID: string, params?: unknown) => Promise<{ data: MessageWithParts[]; cursor: Record<string, never> }>
}

interface FakeCalls {
  permissionList: number
  formList: number
  active: number
  page: number
  messagePage: number
}

function makeClient(options: FakeOptions = {}): { client: FakeClient; calls: FakeCalls } {
  const calls: FakeCalls = { permissionList: 0, formList: 0, active: 0, page: 0, messagePage: 0 }
  const client: FakeClient = {
    global: {
      async *events(signal?: AbortSignal) {
        for (const event of options.events ?? []) yield event
        if (signal?.aborted) return
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    },
    permission: {
      list: () => {
        calls.permissionList += 1
        return options.permissions ? options.permissions() : Promise.resolve([])
      },
    },
    form: {
      requestList: () => {
        calls.formList += 1
        return options.forms ? options.forms() : Promise.resolve([])
      },
    },
    session: {
      active: () => {
        calls.active += 1
        return options.active ? options.active() : Promise.resolve({})
      },
      page: (params, timeoutMs) => {
        calls.page += 1
        return options.page ? options.page(params, timeoutMs) : Promise.resolve({ data: [], cursor: {} })
      },
      list: async () => [],
      messagePage: (sessionID, params) => {
        calls.messagePage += 1
        return options.messagePage ? options.messagePage(sessionID, params) : Promise.resolve({ data: [], cursor: {} })
      },
    },
  }
  return { client, calls }
}

const session = (id: string, directory = "/work/active"): Session => ({
  id,
  slug: id,
  projectID: "p",
  directory,
  title: id,
  version: "2",
  time: { created: 1, updated: 1 },
})

const idleMarker = (sessionID: string): MessageWithParts => ({
  info: {
    id: "idle-marker",
    sessionID,
    role: "assistant",
    presentation: "system",
    systemKind: "idle",
    time: { created: 2 },
  },
  parts: [],
})

const permission = (id: string, sessionID: string): PendingPermissionInput => ({
  id,
  sessionID,
  permission: "bash",
  patterns: [],
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await tick()
  }
}

function reset(client: FakeClient | null = null) {
  useEvents.getState().disconnect()
  useConnections.setState({
    activeConnection: { id: "conn", name: "test", type: "local", url: "http://server.test", directory: "/work/active" },
    client: client as never,
    clientBase: { baseUrl: "http://server.test" },
  })
  useSessions.setState({
    sessions: [],
    childrenByParent: {},
    childCounts: {},
    currentSession: null,
    messages: [],
    parts: {},
    isSessionsLoading: false,
    isSessionLoading: false,
    sending: {},
    error: null,
  })
}

test("reconnect resync keeps pending requests from other directories and still clears this one", async () => {
  const active = session("active")
  const stale = session("stale")
  const stalePermission = permission("perm_stale", "stale")
  const otherPermission = permission("perm_other", "other-session")
  const pageDeferred = deferred<{ data: Session[]; cursor: Record<string, never> }>()
  const permissionsDeferred = deferred<PendingPermissionInput[]>()
  const { client, calls } = makeClient({
    // A single harmless frame marks the stream live and triggers the resync.
    events: [{ type: "session.unknown", properties: {} }],
    page: () => pageDeferred.promise,
    permissions: () => permissionsDeferred.promise,
  })
  reset(client)
  useSessions.setState({ sessions: [active, stale], currentSession: active })
  // The other session belongs to a directory this client never fetched.
  useEvents.setState({
    permissions: { stale: [stalePermission], "other-session": [otherPermission] },
    questions: {},
  })

  useEvents.getState().connect()
  await waitFor(() => calls.permissionList > 0 && calls.active > 0)
  permissionsDeferred.resolve([])
  await tick()

  // The active-directory snapshot lists nothing pending: the stale bucket is
  // recovered/cleared, and the other project's prompt survives.
  assert.deepEqual(useEvents.getState().permissions.stale, undefined)
  assert.deepEqual(useEvents.getState().permissions["other-session"], [otherPermission])

  pageDeferred.resolve({ data: [], cursor: {} })
  await waitFor(() => calls.page > 0 && !useSessions.getState().isSessionsLoading)
  await tick()
  assert.deepEqual(useEvents.getState().permissions["other-session"], [otherPermission])
})

test("the active probe does not clobber a status a fresher event replaced", async () => {
  const active = session("s1")
  const activeDeferred = deferred<Record<string, unknown>>()
  const { client, calls } = makeClient({
    events: [{ type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } }],
    active: () => activeDeferred.promise,
  })
  reset(client)
  useSessions.setState({ sessions: [active], currentSession: active, sending: { s1: true } })
  useEvents.setState({ sessionStatus: { s1: { type: "busy" } }, statusText: {} })

  useEvents.getState().connect()
  // The probe was fired first; the idle transition lands while it is in
  // flight. The probe's older snapshot still reports s1 as running.
  await waitFor(() => calls.active > 0 && useEvents.getState().sessionStatus.s1?.type === "idle")
  activeDeferred.resolve({ s1: {} })
  await tick()
  await tick()

  assert.equal(useEvents.getState().sessionStatus.s1?.type, "idle")
  assert.equal(useSessions.getState().sending.s1, false)
})

test("a failed active probe still clears a stale busy flag from the idle settle marker", async () => {
  const active = session("s1")
  const { client } = makeClient({
    events: [{ type: "session.unknown", properties: {} }],
    active: async () => { throw new Error("active probe unavailable") },
    // Newest-first: the released v2 server appends an idle bookkeeping row
    // when the run settles. It is the newest row, so the tail check must
    // recognize it (the old check read it as "not an assistant reply").
    messagePage: async () => ({ data: [idleMarker("s1")], cursor: {} }),
  })
  reset(client)
  useSessions.setState({ sessions: [active], currentSession: active, sending: { s1: true } })
  useEvents.setState({ sessionStatus: { s1: { type: "busy" } }, statusText: {} })

  useEvents.getState().connect()
  await waitFor(() => useEvents.getState().sessionStatus.s1?.type === "idle")

  assert.equal(useEvents.getState().sessionStatus.s1?.type, "idle")
  assert.equal(useSessions.getState().sending.s1, false)
})

test("busy and retry statuses keep the stop control available and idle clears it", async () => {
  const { client } = makeClient({
    events: [
      { type: "session.status", properties: { sessionID: "s2", status: { type: "busy" } } },
      { type: "session.retry.scheduled", properties: { sessionID: "s3", attempt: 2, error: { message: "rate limited" } } },
      { type: "session.status", properties: { sessionID: "s2", status: { type: "idle" } } },
    ],
  })
  reset(client)

  useEvents.getState().connect()
  await waitFor(() => useSessions.getState().sending.s3 === true && useSessions.getState().sending.s2 === false)

  assert.equal(useEvents.getState().sessionStatus.s2?.type, "idle")
  assert.equal(useEvents.getState().sessionStatus.s3?.type, "retry")
  assert.equal(useSessions.getState().sending.s3, true)
  assert.equal(useSessions.getState().sending.s2, false)
})
