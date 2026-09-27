import assert from "node:assert/strict"
import test, { after } from "node:test"
import { mock } from "bun:test"
import type { CursorPage, Message, MessageWithParts, Session } from "../lib/sdk"

// Module mocks in this suite replace real modules process-wide, and
// connections.test.ts imports the connection store for real. Reset the mock
// registry when this file is done so later test files see the real modules.
after(() => mock.restore())

// sessions.ts imports the network SDK, the connection/settings stores (which
// pull in expo-native modules), and the Sentry/analytics wrappers. This suite
// exercises selectSession/abortSession state handling only, so all of those
// are replaced before the store module is evaluated. The module under test is
// imported dynamically at the bottom so the mocks are registered first.
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

mock.module("./settings", () => ({
  useSettings: { getState: () => ({ pageSize: 20, sessionListScope: "workspace" }) },
}))

const { useConnections } = await import("./connections.ts")
const { useSessions, abortedSessions } = await import("./sessions.ts")

const session = (id: string, directory = "/work"): Session => ({
  id,
  slug: id,
  projectID: "p",
  directory,
  title: id,
  version: "2",
  time: { created: 1, updated: 1 },
})

const message = (id: string, sessionID: string): Message => ({
  id,
  sessionID,
  role: "user",
  presentation: "user",
  time: { created: 1 },
})

const page = (data: MessageWithParts[] = []): CursorPage<MessageWithParts> => ({ data, cursor: {} })

interface FakeClient {
  session: {
    get: (sessionID: string) => Promise<Session>
    messagePage: (sessionID: string, params?: unknown) => Promise<CursorPage<MessageWithParts>>
    page: (params?: unknown) => Promise<CursorPage<Session>>
    prompt: (sessionID: string, params: unknown) => Promise<void>
    interrupt: (sessionID: string) => Promise<{ interrupted: boolean }>
  }
}

function makeClient(overrides: Partial<FakeClient["session"]> = {}): FakeClient {
  return {
    session: {
      get: async (sessionID) => session(sessionID),
      messagePage: async () => page(),
      page: async () => ({ data: [], cursor: {} }),
      prompt: async () => {},
      interrupt: async () => ({ interrupted: true }),
      ...overrides,
    },
  }
}

function setClient(client: unknown, directory = "/work") {
  useConnections.setState({
    activeConnection: { id: "conn", name: "test", type: "local", url: "http://server.test", directory },
    client: client as never,
    clientBase: { baseUrl: "http://server.test" },
  })
}

function reset(client: FakeClient | null = null) {
  setClient(client)
  abortedSessions.clear()
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
    loadingMore: false,
    hasMore: false,
    sessionCursor: {},
    messageCursor: {},
    error: null,
  })
}

test("a cold load drops the previous session before the fetch resolves", async () => {
  const a = session("a")
  const b = session("b")
  let resolveGet!: (value: Session) => void
  let resolvePage!: (value: CursorPage<MessageWithParts>) => void
  const promptCalls: string[] = []
  const client = makeClient({
    get: () => new Promise((resolve) => { resolveGet = resolve }),
    messagePage: () => new Promise((resolve) => { resolvePage = resolve }),
    prompt: async (sessionID) => { promptCalls.push(sessionID) },
  })
  reset(client)
  useSessions.setState({
    currentSession: a,
    messages: [message("ma", "a")],
    parts: { ma: [] },
    // b is running (SSE state mirrored into sending); opening it must not lose
    // its stop control.
    sending: { a: false, b: true },
  })

  const load = useSessions.getState().selectSession("b")

  const during = useSessions.getState()
  // The old session is not left bound: a send racing the navigation cannot
  // reach it.
  assert.equal(during.currentSession, null)
  assert.deepEqual(during.messages, [])
  assert.equal(during.isSessionLoading, true)
  assert.equal(during.sending.b, true)

  await useSessions.getState().sendMessage("hi")
  assert.deepEqual(promptCalls, [])
  assert.equal(useSessions.getState().error, "No active session")

  resolveGet(b)
  resolvePage(page([{ info: message("mb", "b"), parts: [] }]))
  await load

  const after = useSessions.getState()
  assert.equal(after.currentSession?.id, "b")
  assert.deepEqual(after.messages.map((item) => item.id), ["mb"])
  assert.equal(after.sending.b, true)
  assert.equal(after.isSessionLoading, false)
})

test("re-selecting the open session keeps its running stop flag", async () => {
  const a = session("a")
  reset(makeClient({ get: async () => a, messagePage: async () => page() }))
  useSessions.setState({ currentSession: a, sending: { a: true } })

  await useSessions.getState().selectSession("a")

  const state = useSessions.getState()
  assert.equal(state.currentSession?.id, "a")
  // Regression: the refresh used to set sending[a] = false unconditionally,
  // hiding the stop control for the still-running run.
  assert.equal(state.sending.a, true)
  assert.equal(state.isSessionLoading, false)
})

test("a cold load failure leaves no stale session bound", async () => {
  const a = session("a")
  const client = makeClient({
    get: async () => { throw new Error("offline") },
    messagePage: async () => { throw new Error("offline") },
  })
  reset(client)
  useSessions.setState({ currentSession: a, messages: [message("ma", "a")] })

  await useSessions.getState().selectSession("b")

  const state = useSessions.getState()
  assert.equal(state.currentSession, null)
  assert.deepEqual(state.messages, [])
  assert.equal(state.isSessionLoading, false)
  assert.equal(state.error, "Failed to load session")
})

test("abort marks the run before the interrupt response resolves", async () => {
  const a = session("a")
  let resolveInterrupt!: (value: { interrupted: boolean }) => void
  reset(makeClient({
    interrupt: () => new Promise((resolve) => { resolveInterrupt = resolve }),
    messagePage: async () => page(),
  }))
  useSessions.setState({ currentSession: a, sending: { a: true } })

  const abort = useSessions.getState().abortSession()
  // The server can emit busy -> idle while the interrupt is still in flight:
  // the completion handler must already see the abort mark.
  assert.equal(abortedSessions.has("a"), true)

  resolveInterrupt({ interrupted: true })
  await abort
  assert.equal(abortedSessions.has("a"), true)
  assert.equal(useSessions.getState().sending.a, false)
})

test("a not-honored interrupt removes the optimistic abort mark", async () => {
  const a = session("a")
  let refreshCalls = 0
  reset(makeClient({
    interrupt: async () => ({ interrupted: false }),
    messagePage: async () => { refreshCalls += 1; return page() },
  }))
  useSessions.setState({ currentSession: a, sending: { a: true } })

  await useSessions.getState().abortSession()

  // The run finished on its own: it is not a user abort, so a genuine
  // completion must still notify.
  assert.equal(abortedSessions.has("a"), false)
  assert.equal(useSessions.getState().sending.a, false)
  assert.equal(refreshCalls, 1)
})

test("a failed interrupt does not leave a fresh abort mark behind", async () => {
  const a = session("a")
  reset(makeClient({ interrupt: async () => { throw new Error("network down") } }))
  useSessions.setState({ currentSession: a, sending: { a: true } })

  await useSessions.getState().abortSession()

  assert.equal(abortedSessions.has("a"), false)
  assert.equal(useSessions.getState().error, "Failed to abort session")
})
