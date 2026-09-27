import { create } from "zustand"
import * as SecureStore from "expo-secure-store"
import * as Crypto from "expo-crypto"
import type { ServerConnection, ConnectionType } from "../lib/types"
import { createClient, type Client, type Project, V2_REQUIRED_ERROR } from "../lib/sdk"
import { addBreadcrumb } from "../lib/sentry"
import { AnalyticsEvent, classifyConnectionError, track, type ConnectionTestSource } from "../lib/analytics"
import { buildAuth } from "../lib/auth"
import { stripTrailingSlash } from "../lib/path-utils"

const CONNECTIONS_KEY = "opencode_connections"
const PASSWORDS_PREFIX = "opencode_password_"
const RECENT_DIRS_KEY = "opencode_recent_dirs"
const MAX_RECENT_DIRS = 10
// A bad IP (unreachable host, wrong port) otherwise hangs for the full 30s
// general request timeout before the user sees a "connection failed" error —
// a first-run bounce driver. The interactive connect flow can afford to fail
// faster since a real v2 server responds to /api/info in well under a
// second; this does NOT affect the timeout used for real session traffic.
const CONNECTION_TEST_TIMEOUT_MS = 12_000
// Startup metadata probe (project.current). A dead/unreachable
// saved server otherwise stalls the root spinner for the full 30s general
// request timeout on every cold start — the app looks permanently stuck
// loading. This probe only feeds the directory-switcher header; it doesn't
// carry real session traffic, so it can afford to give up fast while the UI
// renders and surfaces its own "server unreachable" retry state.
const CONNECTION_PROBE_TIMEOUT_MS = 8_000

// Cached auth so we can create directory-scoped clients without async SecureStore lookups
interface ClientBase {
  baseUrl: string
  auth?: { username: string; password: string }
}

interface ConnectionsState {
  connections: ServerConnection[]
  activeConnection: ServerConnection | null
  client: Client | null
  clientBase: ClientBase | null
  currentProject: Project | null
  recentDirectories: string[]
  isLoading: boolean
  error: string | null

  // Actions
  loadConnections: () => Promise<void>
  addConnection: (connection: Omit<ServerConnection, "id">, password?: string) => Promise<void>
  removeConnection: (id: string) => Promise<void>
  setActiveConnection: (id: string) => Promise<void>
  // `source` distinguishes the activation funnel (onboarding) from the edit
  // screen's Test button (edit_test) in analytics.
  testConnection: (
    connection: ServerConnection,
    source: ConnectionTestSource,
    password?: string,
  ) => Promise<{ ok: boolean; error?: string }>
  updateConnection: (id: string, updates: Partial<ServerConnection>, password?: string) => Promise<void>
  // Read the password saved for an existing connection. The edit screen's Test
  // Connection / diagnostics path uses this so a blank password field (which
  // means "keep the saved password" on save) does not probe unauthenticated.
  getConnectionPassword: (id: string) => Promise<string | null>
  refreshProject: () => Promise<void>
  // Create a one-off client pointing at a specific directory (for cross-project operations).
  // Pass undefined to get a directory-less client that queries the server without project scope.
  clientForDirectory: (directory?: string) => Client | null
  // Switch the active connection's directory and reload
  switchDirectory: (directory?: string) => Promise<void>
  // Record a directory as recently used
  addRecentDirectory: (directory: string) => Promise<void>
}

function generateId(): string {
  return Crypto.randomUUID().replace(/-/g, "").slice(0, 16)
}

// Saved passwords live in SecureStore under an id-scoped key. An empty/absent
// id (the add-connection flow builds a throwaway connection before it has an
// id) must never read an unrelated key.
async function readSavedPassword(id: string): Promise<string | null> {
  if (!id) return null
  return (await SecureStore.getItemAsync(`${PASSWORDS_PREFIX}${id}`)) || null
}

function buildClient(
  url: string,
  directory?: string,
  auth?: { username: string; password: string },
): { client: Client; base: ClientBase } {
  const base: ClientBase = { baseUrl: url, auth }
  const client = createClient({ baseUrl: url, directory, auth })
  return { client, base }
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  connections: [],
  activeConnection: null,
  client: null,
  clientBase: null,
  currentProject: null,
  recentDirectories: [],
  isLoading: true,
  error: null,

  loadConnections: async () => {
    try {
      set({ isLoading: true, error: null })
      const [stored, recentRaw] = await Promise.all([
        SecureStore.getItemAsync(CONNECTIONS_KEY),
        SecureStore.getItemAsync(RECENT_DIRS_KEY),
      ])
       const parsedConnections: unknown = stored ? JSON.parse(stored) : []
       const connections: ServerConnection[] = Array.isArray(parsedConnections)
         ? parsedConnections.filter((value): value is ServerConnection => isSavedConnection(value))
         : []
       const parsedRecent: unknown = recentRaw ? JSON.parse(recentRaw) : []
       const recentDirectories: string[] = Array.isArray(parsedRecent)
         ? parsedRecent.filter((value): value is string => typeof value === "string")
         : []

      // Find active connection
      const active = connections.find((c) => c.active) || null

      // Create client for active connection
      let client: Client | null = null
      let base: ClientBase | null = null
      let project: Project | null = null
      if (active) {
        const password = await SecureStore.getItemAsync(`${PASSWORDS_PREFIX}${active.id}`)
        const auth = buildAuth(active.username, password)
        const built = buildClient(active.url, active.directory, auth)
        client = built.client
        base = built.base
      }

      // Resolve the loading gate from local state (SecureStore) alone so the
      // app shell + tab bar render immediately, even when the saved server is
      // offline. The metadata probe below runs in the background with a short
      // timeout; a dead server can't hold the root spinner anymore.
      set({
        connections,
        activeConnection: active,
        client,
        clientBase: base,
        currentProject: project,
        recentDirectories,
        isLoading: false,
      })

      // Fetch current project info (best-effort, non-blocking)
      if (active && client) {
        try {
          project = await client.project.current(CONNECTION_PROBE_TIMEOUT_MS).catch(() => null)
          // Only apply if the active connection hasn't changed under us
          if (get().activeConnection?.id === active.id) {
            set({ currentProject: project })
          }
        } catch {
          // Server might be offline; the sessions screen shows a retry state
        }
      }
    } catch (error) {
      set({ error: "Failed to load connections", isLoading: false })
    }
  },

  addConnection: async (connection, password) => {
    const id = generateId()
    const newConnection: ServerConnection = {
      ...connection,
      id,
      active: get().connections.length === 0, // First connection is active
    }

    const connections = [...get().connections, newConnection]

    // Store password separately if provided
    if (password) {
      await SecureStore.setItemAsync(`${PASSWORDS_PREFIX}${id}`, password)
    }

    await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))

    // If this is the first/active connection, create client
    let client = get().client
    let base = get().clientBase
    let activeConnection = get().activeConnection

    let project = get().currentProject

    if (newConnection.active) {
      activeConnection = newConnection
      const auth = buildAuth(newConnection.username, password)
      const built = buildClient(newConnection.url, newConnection.directory, auth)
      client = built.client
      base = built.base

      // Fetch project metadata immediately after the connection is added
      // (same as setActiveConnection does).
      try {
        project = await client.project.current(CONNECTION_PROBE_TIMEOUT_MS).catch(() => null)
      } catch {
        // Server might be unreachable; proceed without metadata
      }
    }

    set({ connections, activeConnection, client, clientBase: base, currentProject: project })
  },

  removeConnection: async (id) => {
    const connections = get().connections.filter((c) => c.id !== id)

    // Remove stored password
    await SecureStore.deleteItemAsync(`${PASSWORDS_PREFIX}${id}`)
    await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))

    // If removing active connection, clear client
    const wasActive = get().activeConnection?.id === id
    if (wasActive) {
      const newActive = connections[0] || null
      if (newActive) {
        // Mark new connection as active
        newActive.active = true
        await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))
        const password = await SecureStore.getItemAsync(`${PASSWORDS_PREFIX}${newActive.id}`)
        const auth = buildAuth(newActive.username, password)
        const built = buildClient(newActive.url, newActive.directory, auth)
        set({ connections, activeConnection: newActive, client: built.client, clientBase: built.base })
      } else {
        set({ connections, activeConnection: null, client: null, clientBase: null })
      }
    } else {
      set({ connections })
    }
  },

  setActiveConnection: async (id) => {
    const connections = get().connections.map((c) => ({
      ...c,
      active: c.id === id,
    }))

    await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))

    const active = connections.find((c) => c.id === id) || null
    let client: Client | null = null
    let base: ClientBase | null = null
    let project: Project | null = null

    if (active) {
      const password = await SecureStore.getItemAsync(`${PASSWORDS_PREFIX}${active.id}`)
      const auth = buildAuth(active.username, password)
      const built = buildClient(active.url, active.directory, auth)
      client = built.client
      base = built.base

      try {
        project = await client.project.current(CONNECTION_PROBE_TIMEOUT_MS).catch(() => null)
      } catch {
        // Server might be offline
      }

      // Update last connected time
      active.lastConnected = Date.now()
      await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))
    }

    set({ connections, activeConnection: active, client, clientBase: base, currentProject: project })
    addBreadcrumb({
      category: "connection",
      message: active ? `active connection set: ${active.type}` : "active connection cleared",
      data: { id: active?.id, type: active?.type, hasProject: Boolean(project) },
    })
  },

  testConnection: async (connection, source, password) => {
    track(AnalyticsEvent.ConnectionAttempted, { source })
    try {
      // The edit form loads the password blank (saved passwords are never read
      // back into the field), so an empty value means "use the saved password",
      // not "no auth". Without the fallback, Test Connection sent no
      // Authorization header and reported 401 for a server that works.
      const effectivePassword = password || (await readSavedPassword(connection.id)) || undefined
      const client = createClient({
        baseUrl: connection.url,
        directory: connection.directory,
        auth: buildAuth(connection.username, effectivePassword),
      })

      await client.global.health(CONNECTION_TEST_TIMEOUT_MS)
      track(AnalyticsEvent.ConnectionSucceeded, { source })
      return { ok: true }
    } catch (error) {
       const message = error instanceof Error ? error.message : String(error)
      track(AnalyticsEvent.ConnectionFailed, { source, error_class: classifyConnectionError(message) })
       return { ok: false, error: message === "API Error: 404" ? V2_REQUIRED_ERROR : message }
    }
  },

  updateConnection: async (id, updates, password) => {
    const connections = get().connections.map((c) => (c.id === id ? { ...c, ...updates } : c))

    await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))

    // Persist a new password only when one was entered. The edit form loads the
    // password field blank (passwords aren't read back for security), so an
    // empty value means "keep the existing password", not "clear it". Written
    // before the active-client rebuild below so the rebuilt client picks it up.
    if (password) {
      await SecureStore.setItemAsync(`${PASSWORDS_PREFIX}${id}`, password)
    }

    // If updating active connection, recreate client
    if (get().activeConnection?.id === id) {
      const active = connections.find((c) => c.id === id)!
      const password = await readSavedPassword(id)
      const auth = buildAuth(active.username, password)
      const built = buildClient(active.url, active.directory, auth)
      try {
        const project = await built.client.project.current(CONNECTION_PROBE_TIMEOUT_MS)
        set({
          connections,
          activeConnection: active,
          client: built.client,
          clientBase: built.base,
          currentProject: project,
        })
      } catch {
        // Metadata probe failed (e.g. the edited URL is unreachable). Clear the
        // previous server's project too: keeping it would show stale metadata
        // for a server the active connection no longer points at.
        set({
          connections,
          activeConnection: active,
          client: built.client,
          clientBase: built.base,
          currentProject: null,
        })
      }
    } else {
      set({ connections })
    }
  },

  getConnectionPassword: (id) => readSavedPassword(id),

  refreshProject: async () => {
    const client = get().client
    if (!client) return

    try {
      const project = await client.project.current(CONNECTION_PROBE_TIMEOUT_MS)
      set({ currentProject: project })
    } catch {
      set({ currentProject: null })
    }
  },

  clientForDirectory: (directory) => {
    const base = get().clientBase
    if (!base) return null
    // Reuse current client if directory matches
    const active = get().activeConnection
    if (active?.directory === directory) return get().client
    return createClient({ baseUrl: base.baseUrl, directory, auth: base.auth })
  },

  switchDirectory: async (directory) => {
    const active = get().activeConnection
    if (!active) return
    // Update connection directory and recreate client. Normalize trailing
    // slashes so "/home/user" and "/home/user/" don't diverge (recent-dir
    // duplicates + a mismatched "current directory" highlight).
    const trimmed = directory?.trim()
    const dir = trimmed ? stripTrailingSlash(trimmed) : undefined
    await get().updateConnection(active.id, { directory: dir })
    // Record in recents if it's a real directory
    if (dir) await get().addRecentDirectory(dir)
  },

  addRecentDirectory: async (directory) => {
    const current = get().recentDirectories
    // Normalize trailing slashes so the same dir entered as ".../x" and
    // ".../x/" dedups to one recent-list entry instead of two.
    directory = stripTrailingSlash(directory.trim())
    // Move to front, dedup, cap at MAX
    const updated = [directory, ...current.filter((d) => d !== directory)].slice(0, MAX_RECENT_DIRS)
    set({ recentDirectories: updated })
    await SecureStore.setItemAsync(RECENT_DIRS_KEY, JSON.stringify(updated))
  },
}))

function isSavedConnection(value: unknown): value is ServerConnection {
  if (!value || typeof value !== "object") return false
  const connection = value as Partial<ServerConnection>
  return typeof connection.id === "string" && typeof connection.url === "string" && typeof connection.name === "string"
}
