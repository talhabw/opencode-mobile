import assert from "node:assert/strict"
import test from "node:test"
import { mock } from "bun:test"

// connections.ts imports expo-native modules, the Sentry/PostHog wrappers, and
// the network SDK. This suite only exercises SecureStore-backed credential
// handling and the active-client metadata refresh, so replace all of those
// before the store module is evaluated.
const secure = new Map<string, string>()

mock.module("expo-secure-store", () => ({
  getItemAsync: async (key: string) => secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    secure.set(key, value)
  },
  deleteItemAsync: async (key: string) => {
    secure.delete(key)
  },
}))

mock.module("expo-crypto", () => ({
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}))

mock.module("../lib/sentry", () => ({
  addBreadcrumb: () => {},
}))

mock.module("../lib/analytics", () => ({
  AnalyticsEvent: {
    ConnectionAttempted: "connection_attempted",
    ConnectionSucceeded: "connection_succeeded",
    ConnectionFailed: "connection_failed",
  },
  classifyConnectionError: () => "unknown",
  track: () => {},
}))

type ClientConfig = {
  baseUrl: string
  directory?: string
  auth?: { username: string; password: string }
}

let clientConfigs: ClientConfig[] = []
let healthImpl: () => Promise<{ healthy: boolean; version: string }> = async () => ({ healthy: true, version: "2.0.18" })
let projectImpl: () => Promise<unknown> = async () => ({ id: "project", directory: "/work" })

mock.module("../lib/sdk", () => ({
  V2_REQUIRED_ERROR: "An OpenCode v2 server is required",
  createClient: (config: ClientConfig) => {
    clientConfigs.push(config)
    return {
      global: { health: () => healthImpl() },
      project: { current: () => projectImpl() },
    }
  },
}))

const { useConnections } = await import("./connections.ts")

const connection = (over: Partial<{ id: string; name: string; url: string; active: boolean }> = {}) => ({
  id: "conn1",
  name: "Home",
  type: "local" as const,
  url: "http://server.test:4096",
  ...over,
})

function reset() {
  secure.clear()
  clientConfigs = []
  healthImpl = async () => ({ healthy: true, version: "2.0.18" })
  projectImpl = async () => ({ id: "project", directory: "/work" })
  useConnections.setState({
    connections: [],
    activeConnection: null,
    client: null,
    clientBase: null,
    currentProject: null,
    recentDirectories: [],
    isLoading: false,
    error: null,
  })
}

test("getConnectionPassword reads the SecureStore password scoped by id", async () => {
  reset()
  secure.set("opencode_password_conn1", "saved-secret")

  assert.equal(await useConnections.getState().getConnectionPassword("conn1"), "saved-secret")
  assert.equal(await useConnections.getState().getConnectionPassword("missing"), null)
  // The add-connection flow passes an empty id before the connection exists.
  assert.equal(await useConnections.getState().getConnectionPassword(""), null)
})

test("testConnection uses the saved password when the edit field is blank", async () => {
  reset()
  secure.set("opencode_password_conn1", "saved-secret")

  const result = await useConnections.getState().testConnection(connection(), "edit_test")

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(clientConfigs.at(-1)?.auth, { username: "opencode", password: "saved-secret" })
})

test("testConnection prefers a typed password over the saved one", async () => {
  reset()
  secure.set("opencode_password_conn1", "saved-secret")

  await useConnections.getState().testConnection(connection(), "edit_test", "typed-secret")

  assert.deepEqual(clientConfigs.at(-1)?.auth, { username: "opencode", password: "typed-secret" })
})

test("testConnection without an id sends no auth (onboarding has no saved password)", async () => {
  reset()
  secure.set("opencode_password_conn1", "saved-secret")

  await useConnections.getState().testConnection(connection({ id: "" }), "onboarding")

  assert.equal(clientConfigs.at(-1)?.auth, undefined)
})

test("updateConnection clears stale metadata when the metadata refresh fails", async () => {
  reset()
  const active = connection({ active: true })
  useConnections.setState({
    connections: [active],
    activeConnection: active,
    currentProject: { id: "old-project" },
  })
  // The refresh blows up before project.current can report the new server's project.
  projectImpl = () => {
    throw new Error("network down")
  }

  await useConnections.getState().updateConnection("conn1", { url: "http://new.test:4096" })

  const state = useConnections.getState()
  assert.equal(state.currentProject, null)
  assert.equal(state.connections[0].url, "http://new.test:4096")
})

test("updateConnection applies the refreshed project metadata on success", async () => {
  reset()
  const active = connection({ active: true })
  useConnections.setState({
    connections: [active],
    activeConnection: active,
    currentProject: { id: "old-project" },
  })
  projectImpl = async () => ({ id: "new-project", directory: "/new" })

  await useConnections.getState().updateConnection("conn1", { url: "http://new.test:4096" })

  assert.equal(useConnections.getState().currentProject?.id, "new-project")
})
