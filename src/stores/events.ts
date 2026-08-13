import { create } from "zustand"
import { useConnections } from "./connections"
import { useSessions, abortedSessions } from "./sessions"
import { send as notify } from "../lib/notifications"
import { sanitizeBody } from "../lib/notify-format"
import { statusFromPart } from "../lib/status-labels"
import { addBreadcrumb } from "../lib/sentry"
import { AnalyticsEvent, track } from "../lib/analytics"
import { recordSuccessfulSession } from "../lib/store-review"
import { isAuthError } from "../lib/api-error"
import { isSessionActuallyIdle } from "../lib/session-status-reconcile"
import { eventSessionID, mergeSendingState, reconnectDelay, resyncPlan, shouldRefreshCanonicalMessages } from "../lib/event-reconcile"
import type { Client, Event, Part, Session, Message } from "../lib/sdk"

// Session status from the server
type SessionStatus = { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string }
type PendingPermission = Awaited<ReturnType<Client["permission"]["list"]>>[number]
type PendingQuestion = Awaited<ReturnType<Client["question"]["list"]>>[number]

interface EventsState {
  connected: boolean
  // Set when the last connection attempt failed with 401/403 — the server
  // rejected our credentials, not a transient network issue. The reconnect
  // loop stops retrying in this case (see connect()) since hammering a
  // fixed-credential auth failure forever just spams Sentry/battery with no
  // path to recovery (issue #76). Cleared on the next connect() attempt,
  // e.g. after the user fixes their credentials on the connection edit screen.
  authError: boolean
  reconnectAttempts: number
  lastDisconnectAt: number | null
  sessionStatus: Record<string, SessionStatus>
  statusText: Record<string, string>
  // Permissions & questions (pending per session)
  permissions: Record<string, PendingPermission[]>
  questions: Record<string, PendingQuestion[]>

  connect: () => void
  disconnect: () => void
}

let controller: AbortController | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const messageRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
let sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null
const resolvedPermissions = new Set<string>()
const resolvedQuestions = new Set<string>()

export function markPendingResolved(kind: "permission" | "question", requestID: string, resolved: boolean) {
  const requests = kind === "permission" ? resolvedPermissions : resolvedQuestions
  if (resolved) requests.add(requestID)
  else requests.delete(requestID)
}

// Sessions that emitted session.error since they last went busy. SessionStatus
// has no error variant — an errored session still ends with a busy -> idle
// transition — so without this mark an errored run would count as a success
// toward the once-ever store review prompt.
const erroredSessions = new Set<string>()

const STABLE_CONNECTION_MS = 10_000
const PROLONGED_DISCONNECT_MS = 30_000

// Re-fetch pending permissions and questions from the server for a session.
// Called when entering a session to recover from missed SSE events or failed
// optimistic removals.
export async function refreshPending(client: Client, sessionID: string) {
  try {
    const [perms, questions] = await Promise.all([client.permission.list(), client.question.list()])
    const permissionIDs = new Set(perms.map((request) => request.id))
    const questionIDs = new Set(questions.map((request) => request.id))
    for (const id of resolvedPermissions) if (!permissionIDs.has(id)) resolvedPermissions.delete(id)
    for (const id of resolvedQuestions) if (!questionIDs.has(id)) resolvedQuestions.delete(id)
    const sessionPerms = perms.filter((request) => request.sessionID === sessionID && !resolvedPermissions.has(request.id))
    const sessionQuestions = questions.filter((request) => request.sessionID === sessionID && !resolvedQuestions.has(request.id))
    useEvents.setState((state) => ({
      permissions: { ...state.permissions, [sessionID]: sessionPerms },
      questions: { ...state.questions, [sessionID]: sessionQuestions },
    }))
  } catch (err) {
    console.warn("[Events] Failed to refresh pending:", err)
  }
}

function groupPending<T extends { id: string; sessionID: string }>(items: T[], resolved: Set<string>): Record<string, T[]> {
  const grouped: Record<string, T[]> = {}
  for (const item of items) {
    if (resolved.has(item.id)) continue
    grouped[item.sessionID] = [...(grouped[item.sessionID] ?? []), item]
  }
  return grouped
}

async function authoritativeResync(client: Client) {
  const sessions = useSessions.getState()
  const plan = resyncPlan(Boolean(sessions.currentSession))
  const pending = plan.pending ? Promise.all([client.permission.list(), client.question.list()]) : null
  const active = plan.active ? client.session.active() : null
  await Promise.all([
    plan.sessions ? sessions.loadSessions() : undefined,
    plan.messages ? sessions.refreshMessages() : undefined,
    pending?.then(([permissions, questions]) => {
      const permissionIDs = new Set(permissions.map((request) => request.id))
      const questionIDs = new Set(questions.map((request) => request.id))
      for (const id of resolvedPermissions) if (!permissionIDs.has(id)) resolvedPermissions.delete(id)
      for (const id of resolvedQuestions) if (!questionIDs.has(id)) resolvedQuestions.delete(id)
      useEvents.setState({
        permissions: groupPending(permissions, resolvedPermissions),
        questions: groupPending(questions, resolvedQuestions),
      })
    }),
    active?.then((running) => {
      useEvents.setState((state) => {
        const sessionStatus = { ...state.sessionStatus }
        for (const sessionID of Object.keys(sessionStatus)) {
          if (!(sessionID in running) && sessionStatus[sessionID].type === "busy") sessionStatus[sessionID] = { type: "idle" }
        }
        for (const sessionID of Object.keys(running)) sessionStatus[sessionID] = { type: "busy" }
        return { sessionStatus }
      })
      useSessions.setState((state) => ({ sending: mergeSendingState(state.sending, running) }))
    }),
  ])
}

function scheduleCanonicalRefresh(event: Event) {
  if (!shouldRefreshCanonicalMessages(event)) return
  const sessionID = eventSessionID(event)
  if (!sessionID || useSessions.getState().currentSession?.id !== sessionID) return
  const previous = messageRefreshTimers.get(sessionID)
  if (previous) clearTimeout(previous)
  messageRefreshTimers.set(sessionID, setTimeout(() => {
    messageRefreshTimers.delete(sessionID)
    if (useSessions.getState().currentSession?.id === sessionID) void useSessions.getState().refreshMessages()
  }, 150))
}

function scheduleSessionRefresh(type: string) {
  if (!["session.created", "session.renamed", "session.moved", "session.deleted"].includes(type)) return
  if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer)
  sessionRefreshTimer = setTimeout(() => {
    sessionRefreshTimer = null
    void useSessions.getState().loadSessions()
  }, 150)
}

function value<T>(properties: Record<string, unknown>, key: string, guard: (input: unknown) => input is T): T | undefined {
  const input = properties[key]
  return guard(input) ? input : undefined
}

const isString = (input: unknown): input is string => typeof input === "string"
const isSessionStatus = (input: unknown): input is SessionStatus =>
  Boolean(input && typeof input === "object" && "type" in input && ["idle", "busy", "retry"].includes(String(input.type)))
const isMessage = (input: unknown): input is Message =>
  Boolean(input && typeof input === "object" && "id" in input && typeof input.id === "string" && "sessionID" in input && typeof input.sessionID === "string")
const isPart = (input: unknown): input is Part =>
  Boolean(input && typeof input === "object" && "id" in input && typeof input.id === "string" && "messageID" in input && typeof input.messageID === "string")
const isSession = (input: unknown): input is Session =>
  Boolean(input && typeof input === "object" && "id" in input && typeof input.id === "string" && "directory" in input && typeof input.directory === "string")
const isPermission = (input: unknown): input is PendingPermission =>
  Boolean(input && typeof input === "object" && "id" in input && typeof input.id === "string" && "sessionID" in input && typeof input.sessionID === "string" && "permission" in input && typeof input.permission === "string" && "patterns" in input && Array.isArray(input.patterns))
const isQuestion = (input: unknown): input is PendingQuestion =>
  Boolean(input && typeof input === "object" && "id" in input && typeof input.id === "string" && "sessionID" in input && typeof input.sessionID === "string" && "questions" in input && Array.isArray(input.questions))

// Re-sync any session currently marked "busy" against the server after an
// SSE reconnect. sessionStatus/sending are SSE-driven and there is normally
// no other path to idle — if the server's busy -> idle `session.status`
// event fired while the network was down, SSE reconnect resumes the stream
// from "now" (it does not replay missed events), so without this the busy
// flag would never clear and the UI would show a stuck 'processing' spinner
// forever (issue #123).
//
// Only ever CLEARS a busy flag the server confirms is stale via
// isSessionActuallyIdle — it never marks a session busy, so it can't
// clobber a genuinely still-busy session. Also re-checks sessionStatus right
// before writing, so a real session.status event that lands while the fetch
// is in flight (e.g. the session went busy again) wins over this resync.
async function resyncBusySessions() {
  const busySessionIDs = Object.entries(useEvents.getState().sessionStatus)
    .filter(([, status]) => status.type === "busy")
    .map(([sessionID]) => sessionID)
  if (busySessionIDs.length === 0) return

  await Promise.all(
    busySessionIDs.map(async (sessionID) => {
      try {
        const sessionsState = useSessions.getState()
        const session =
          sessionsState.sessions.find((s) => s.id === sessionID) ??
          (sessionsState.currentSession?.id === sessionID ? sessionsState.currentSession : undefined)
        const connState = useConnections.getState()
        const client = session?.directory
          ? connState.clientForDirectory(session.directory) ?? connState.client
          : connState.client
        if (!client) return

        const response = await client.session.messages(sessionID)
        const messages = (response || []).map((m) => m.info)
        if (!isSessionActuallyIdle(messages)) return // server says still busy - leave it alone

        // A fresh session.status event may have landed on the SSE stream
        // while this fetch was in flight — that's authoritative, don't
        // stomp on it.
        if (useEvents.getState().sessionStatus[sessionID]?.type !== "busy") return

        useEvents.setState((state) => ({
          sessionStatus: { ...state.sessionStatus, [sessionID]: { type: "idle" } },
          statusText: { ...state.statusText, [sessionID]: "" },
        }))
        useSessions.setState((state) => ({ sending: { ...state.sending, [sessionID]: false } }))
        if (useSessions.getState().currentSession?.id === sessionID) {
          useSessions.getState().refreshMessages()
        }
      } catch (err) {
        console.warn("[Events] Failed to resync session status for", sessionID, err)
      }
    }),
  )
}

export const useEvents = create<EventsState>((set, get) => ({
  connected: false,
  authError: false,
  reconnectAttempts: 0,
  lastDisconnectAt: null,
  sessionStatus: {},
  statusText: {},
  permissions: {},
  questions: {},

  connect: () => {
    controller?.abort()
    controller = null
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    const client = useConnections.getState().client
    if (!client) return

    controller = new AbortController()
    const currentController = controller
    set({ connected: true, authError: false })
    console.log("[SSE] Connecting to event stream...")
    addBreadcrumb({ category: "sse", message: "connecting" })

    // Run in background
    ;(async () => {
      let reconnectScheduled = false
      let resynced = false
      const stableTimer = setTimeout(() => {
        if (!currentController.signal.aborted) {
          set({ reconnectAttempts: 0, lastDisconnectAt: null })
        }
      }, STABLE_CONNECTION_MS)

      const scheduleReconnect = (reason: unknown) => {
        if (reconnectScheduled || currentController.signal.aborted) return
        reconnectScheduled = true
        const state = get()
        const reconnectAttempts = state.reconnectAttempts + 1
        const lastDisconnectAt = state.lastDisconnectAt ?? Date.now()
        const disconnectedFor = Date.now() - lastDisconnectAt
        set({ connected: false, reconnectAttempts, lastDisconnectAt })

        if (disconnectedFor >= PROLONGED_DISCONNECT_MS) {
          notify({
            category: "connection",
            title: "Connection interrupted",
            body: sanitizeBody(undefined, "Trying to reconnect to your server"),
            sessionId: "",
            dedupeKey: "sse-prolonged-disconnect",
            dedupeCooldownMs: 60_000,
          })
        }

        const jitteredDelay = reconnectDelay(reconnectAttempts, Math.random())
        console.warn(`[SSE] Connection lost, reconnecting in ${jitteredDelay}ms:`, reason)
        addBreadcrumb({
          category: "sse",
          level: "warning",
          message: "reconnect scheduled",
          data: { attempt: reconnectAttempts, delayMs: jitteredDelay, reason: String(reason).slice(0, 200) },
        })
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          get().connect()
        }, jitteredDelay)
      }

      try {
        for await (const event of client.global.events(currentController.signal)) {
          if (currentController.signal.aborted) break

          // The stream is now live. Rebuild volatile state once per physical
          // subscription so cold starts and reconnects cannot retain gaps.
          if (!resynced) {
            resynced = true
            void authoritativeResync(client).then(resyncBusySessions).catch((error) => {
              console.warn("[Events] Failed authoritative resync:", error)
            })
          }

          const type = event.type
          const props = event.properties
          scheduleCanonicalRefresh(event)
          scheduleSessionRefresh(type)

          switch (type) {
            case "session.status": {
              const sessionID = value(props, "sessionID", isString)
              const status = value(props, "status", isSessionStatus)
              if (!sessionID || !status) break

              // Detect busy → idle transition for completion notification
              const previous = get().sessionStatus[sessionID]
              const completed = previous?.type === "busy" && status.type === "idle"

              // A new run starts — forget any error/abort from the previous one
              if (status.type === "busy") {
                erroredSessions.delete(sessionID)
                abortedSessions.delete(sessionID)
              }

              set((state) => ({
                sessionStatus: { ...state.sessionStatus, [sessionID]: status },
                // Clear status text when idle
                statusText: status.type === "idle" ? { ...state.statusText, [sessionID]: "" } : state.statusText,
              }))

              // SSE is the source of truth — update sending state unconditionally
              if (status.type === "idle") {
                useSessions.setState((state) => ({
                  sending: { ...state.sending, [sessionID]: false },
                }))
                // Refresh messages if this is the session the user is viewing
                const sessions = useSessions.getState()
                if (sessions.currentSession?.id === sessionID) {
                  sessions.refreshMessages()
                }
              }

              if (completed) {
                // A user-cancelled run still ends busy -> idle; don't count it
                // as a received response or a review-worthy success.
                const aborted = abortedSessions.has(sessionID)
                if (!aborted) track(AnalyticsEvent.ResponseReceived)
                // Only notify "Task completed" for a genuine completion — a
                // user-cancelled run didn't complete, and an errored run
                // already fired its own "Session error" notification (session.error
                // doesn't touch sessionStatus, so an errored session still lands
                // here via busy→idle). Without this guard the user gets a
                // misleading — or duplicate, contradictory — completion push.
                if (!aborted && !erroredSessions.has(sessionID)) {
                  const match = useSessions.getState().sessions.find((s) => s.id === sessionID)
                  notify({
                    category: "completed",
                    title: "Task completed",
                    body: sanitizeBody(match?.title, "Session finished processing"),
                    sessionId: sessionID,
                  })
                }
                // Genuinely positive moment — count it toward the one-time
                // store review prompt, but only if this run never errored
                // (session.error doesn't touch sessionStatus, so an errored
                // session still lands here via busy -> idle) and wasn't aborted.
                if (!aborted && !erroredSessions.has(sessionID)) void recordSuccessfulSession()
              }
              break
            }

            case "message.updated": {
              const info = value(props, "info", isMessage)
              if (!info) break
              useSessions.getState().handleEvent({ type, properties: { info } })
              break
            }

            case "message.part.updated": {
              const part = value(props, "part", isPart)
              if (!part) break

              // Update status text from the latest part
              const sessionID = part.sessionID
              if (sessionID) {
                set((state) => ({
                  statusText: { ...state.statusText, [sessionID]: statusFromPart(part) },
                }))
              }

              useSessions.getState().handleEvent({ type, properties: { part } })
              break
            }

            case "session.updated": {
              const info = value(props, "info", isSession)
              if (!info) break
              useSessions.getState().handleEvent({ type, properties: { info } })
              break
            }

            case "session.created": {
              const info = value(props, "info", isSession)
              if (!info) break
              // Add to sessions list
              useSessions.setState((state) => {
                const exists = state.sessions.some((s) => s.id === info.id)
                if (exists) return {}
                return { sessions: [info, ...state.sessions] }
              })
              break
            }

            case "session.error": {
              const errorValue = props.error
              const error = errorValue && typeof errorValue === "object" && "message" in errorValue && typeof errorValue.message === "string"
                ? { message: errorValue.message }
                : undefined
              const sessionID = value(props, "sessionID", isString)
              if (!sessionID) break
              // Mark so the eventual busy -> idle transition is not counted
              // as a success for the store review prompt
              erroredSessions.add(sessionID)
              // Clear sending state unconditionally — SSE is truth
              useSessions.setState((state) => ({
                sending: { ...state.sending, [sessionID]: false },
                // Surface error only if user is viewing this session
                ...(state.currentSession?.id === sessionID
                  ? { error: error?.message || "Session error occurred" }
                  : {}),
              }))
              if (useSessions.getState().currentSession?.id === sessionID) {
                useSessions.getState().refreshMessages()
              }
              notify({
                category: "errors",
                title: "Session error",
                body: sanitizeBody(error?.message, "Something went wrong"),
                sessionId: sessionID,
              })
              break
            }

            case "permission.asked": {
              if (!isPermission(props)) break
              const req = props
              if (resolvedPermissions.has(req.id)) break
              const existing = get().permissions[req.sessionID] || []
              if (existing.some((item) => item.id === req.id)) break
              set((state) => ({
                permissions: {
                  ...state.permissions,
                  [req.sessionID]: [...(state.permissions[req.sessionID] || []), req],
                },
              }))
              notify({
                category: "permissions",
                title: "Agent needs approval",
                body: sanitizeBody(
                  req.permission
                    ? req.patterns?.length
                      ? `${req.permission}: ${req.patterns.join(", ")}`
                      : req.permission
                    : req.patterns?.join(", "),
                  "A tool needs your approval",
                ),
                sessionId: req.sessionID,
                dedupeKey: `perm-${req.id}`,
                dedupeCooldownMs: 60_000,
              })
              break
            }

            case "permission.replied": {
              const sessionID = value(props, "sessionID", isString)
              const requestID = value(props, "requestID", isString)
              if (!sessionID || !requestID) break
              resolvedPermissions.add(requestID)
              set((state) => ({
                permissions: {
                  ...state.permissions,
                  [sessionID]: (state.permissions[sessionID] || []).filter((p) => p.id !== requestID),
                },
              }))
              break
            }

            case "question.asked": {
              if (!isQuestion(props)) break
              const req = props
              if (resolvedQuestions.has(req.id)) break
              const existing = get().questions[req.sessionID] || []
              if (existing.some((item) => item.id === req.id)) break
              set((state) => ({
                questions: {
                  ...state.questions,
                  [req.sessionID]: [...(state.questions[req.sessionID] || []), req],
                },
              }))
              notify({
                category: "questions",
                title: req.questions?.[0]?.header || "Input needed",
                body: sanitizeBody(req.questions?.[0]?.question, "The assistant has a question"),
                sessionId: req.sessionID,
                dedupeKey: `question-${req.id}`,
                dedupeCooldownMs: 60_000,
              })
              break
            }

            case "question.replied":
            case "question.rejected": {
              const sessionID = value(props, "sessionID", isString)
              const requestID = value(props, "requestID", isString)
              if (!sessionID || !requestID) break
              resolvedQuestions.add(requestID)
              set((state) => ({
                questions: {
                  ...state.questions,
                  [sessionID]: (state.questions[sessionID] || []).filter((q) => q.id !== requestID),
                },
              }))
              break
            }
          }
        }

        scheduleReconnect(new Error("Event stream closed"))
      } catch (err) {
        if (isAuthError(err) && !currentController.signal.aborted) {
          // Bad credentials, not a transient failure — retrying forever just
          // spams Sentry and drains the battery with zero path to recovery
          // (issue #76: 309 events / 65 users). Stop and surface a distinct
          // state instead; the sessions screen offers a link to fix
          // credentials, which reconnects via connect() once saved.
          console.warn("[SSE] Authentication failed — stopping reconnect loop:", err)
          addBreadcrumb({
            category: "sse",
            level: "error",
            message: "auth error - stopped retrying",
            data: { status: err.status },
          })
          track(AnalyticsEvent.ConnectionFailed, { source: "sse", error_class: "unauthorized" })
          set({ connected: false, authError: true })
        } else {
          scheduleReconnect(err)
        }
      } finally {
        clearTimeout(stableTimer)
        if (currentController.signal.aborted) {
          console.log("[SSE] Disconnected (aborted)")
        }
      }
    })()
  },

  disconnect: () => {
    console.log("[SSE] Disconnecting")
    addBreadcrumb({ category: "sse", message: "disconnected" })
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    controller?.abort()
    controller = null
    for (const timer of messageRefreshTimers.values()) clearTimeout(timer)
    messageRefreshTimers.clear()
    if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer)
    sessionRefreshTimer = null
    resolvedPermissions.clear()
    resolvedQuestions.clear()
    erroredSessions.clear()
    abortedSessions.clear()
    set({
      connected: false,
      authError: false,
      reconnectAttempts: 0,
      lastDisconnectAt: null,
      sessionStatus: {},
      statusText: {},
      permissions: {},
      questions: {},
    })
  },
}))
