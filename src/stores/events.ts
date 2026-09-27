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
import { canAutoResume, streamLiveTransition } from "../lib/transport-lifecycle"
import type { TransportPhase } from "../lib/transport-lifecycle"
import type { Client, Event, Part, Session, Message } from "../lib/sdk"
import {
  fromQuestionForm,
  isQuestionForm,
  type PendingInput,
} from "../lib/question-inputs"
import { reconcilePendingSource, replacePendingSessions } from "../lib/pending-merge"
import { descendantIDs, findCachedSession } from "../lib/session-hierarchy"
import { LatestValueBuffer } from "../lib/latest-value-buffer"

// Session status from the server
type SessionStatus = { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string }
type PendingPermission = Awaited<ReturnType<Client["permission"]["list"]>>[number]

interface EventsState {
  connected: boolean
  phase: TransportPhase
  // Set when the last connection attempt failed with 401/403 — the server
  // rejected our credentials, not a transient network issue. The reconnect
  // loop stops retrying in this case (see connect()) since hammering a
  // fixed-credential auth failure forever just spams Sentry/battery with no
  // path to recovery (issue #76). Cleared on the next connect() attempt,
  // e.g. after the user fixes their credentials on the connection edit screen.
  authError: boolean
  reconnectAttempts: number
  reconnectVisible: boolean
  recoveryVisible: boolean
  lastDisconnectAt: number | null
  sessionStatus: Record<string, SessionStatus>
  statusText: Record<string, string>
  // Permissions & questions (pending per session)
  permissions: Record<string, PendingPermission[]>
  questions: Record<string, PendingInput[]>

  connect: () => void
  pause: () => void
  resume: () => void
  disconnect: () => void
}

let controller: AbortController | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const messageRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
let sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null
let generation = 0
const resolvedPermissions = new Set<string>()
const resolvedQuestions = new Set<string>()
// Rendering every token reparses and relays out the whole accumulated response.
// Ten visual updates per second keeps streaming fluid without starving input.
const streamedParts = new LatestValueBuffer<Part>(100, (parts) => {
  const sessions = useSessions.getState()
  for (const part of parts) sessions.handleEvent({ type: "message.part.updated", properties: { part } })
})
// Tool parts stream through the same coalescing so a busy run's
// session.tool.input.delta / session.tool.progress storms commit at most ten
// times per second instead of once per SSE event (each commit is a full
// zustand set that re-renders the row). Lifecycle events (input.started,
// called, success, failed) flush the buffer immediately via canonicalRefresh.
const streamedToolParts = new LatestValueBuffer<Part>(100, (parts) => {
  const sessions = useSessions.getState()
  for (const part of parts) sessions.handleEvent({ type: "message.part.updated", properties: { part } })
})

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

// Re-fetch pending permissions and question forms from the server for a
// session. Called when entering a session to recover from missed SSE events or
// failed optimistic removals. Permissions and forms are fetched independently:
// a failure in one source never blocks the other (the beta has no question
// API — question-kind forms are the only question source, and this is what a
// refresh recovers), and a successful source still reconciles its own bucket.
// Snapshot application is race-safe: a request that arrived over SSE while the
// fetch was in flight is preserved, never clobbered by the older snapshot.
export async function refreshPending(client: Client, sessionID: string) {
  const beforePermissions = useEvents.getState().permissions
  const beforeQuestions = useEvents.getState().questions
  const sessionIDs = descendantIDs(sessionID, useSessions.getState().childrenByParent)
  const [perms, forms] = await Promise.all([listPendingPermissions(client), pendingFormInputs(client)])

  const permissionBuckets = reconcilePendingSource({
    fetched: perms,
    before: beforePermissions,
    current: useEvents.getState().permissions,
    resolved: resolvedPermissions,
  })
  if (permissionBuckets !== null) {
    useEvents.setState((state) => ({
      permissions: replacePendingSessions(state.permissions, permissionBuckets, sessionIDs),
    }))
  }

  const questionBuckets = reconcilePendingSource({
    fetched: forms,
    before: beforeQuestions,
    current: useEvents.getState().questions,
    resolved: resolvedQuestions,
  })
  if (questionBuckets !== null) {
    useEvents.setState((state) => ({
      questions: replacePendingSessions(state.questions, questionBuckets, sessionIDs),
    }))
  }
}

async function listPendingPermissions(client: Client): Promise<PendingPermission[] | null> {
  try {
    return await client.permission.list()
  } catch (err) {
    console.warn("[Events] Failed to list pending permissions:", err)
    return null
  }
}

// Pending question forms from the global, location-scoped form request list so
// child-session-owned forms are recovered too. A failure here is isolated: the
// null result leaves the existing (SSE-driven) bucket untouched instead of
// wiping it with an empty snapshot.
async function pendingFormInputs(client: Client): Promise<PendingInput[] | null> {
  try {
    const forms = await client.form.requestList()
    return forms.filter(isQuestionForm).map(fromQuestionForm).filter((input) => input.questions.length > 0)
  } catch (err) {
    console.warn("[Events] Failed to refresh pending forms:", err)
    return null
  }
}

function cachedSession(sessionID: string): Session | undefined {
  const state = useSessions.getState()
  return findCachedSession(sessionID, state.sessions, state.childrenByParent, state.currentSession)
}

async function authoritativeResync(client: Client, isCurrent: () => boolean) {
  if (!isCurrent()) return
  const sessions = useSessions.getState()
  const beforePermissions = useEvents.getState().permissions
  const beforeQuestions = useEvents.getState().questions
  const plan = resyncPlan(Boolean(sessions.currentSession))
  const pending = plan.pending
    ? Promise.all([listPendingPermissions(client), pendingFormInputs(client)])
    : null
  const active = plan.active ? client.session.active() : null
  await Promise.all([
    plan.sessions ? sessions.loadSessions() : undefined,
    plan.messages ? sessions.refreshMessages() : undefined,
    pending?.then(([permissions, forms]) => {
      if (!isCurrent()) return
      const patch: Partial<Pick<EventsState, "permissions" | "questions">> = {}
      const permissionBuckets = reconcilePendingSource({
        fetched: permissions,
        before: beforePermissions,
        current: useEvents.getState().permissions,
        resolved: resolvedPermissions,
      })
      if (permissionBuckets !== null) patch.permissions = permissionBuckets
      const questionBuckets = reconcilePendingSource({
        fetched: forms,
        before: beforeQuestions,
        current: useEvents.getState().questions,
        resolved: resolvedQuestions,
      })
      if (questionBuckets !== null) patch.questions = questionBuckets
      if (patch.permissions || patch.questions) useEvents.setState(patch)
    }),
    active?.then((running) => {
      if (!isCurrent()) return
      useEvents.setState((state) => {
        const sessionStatus = { ...state.sessionStatus }
        for (const sessionID of Object.keys(sessionStatus)) {
          if (!(sessionID in running) && isRunningEquivalent(sessionStatus[sessionID])) sessionStatus[sessionID] = { type: "idle" }
        }
        for (const sessionID of Object.keys(running)) sessionStatus[sessionID] = { type: "busy" }
        return { sessionStatus }
      })
      useSessions.setState((state) => ({ sending: mergeSendingState(state.sending, running) }))
    }),
  ])
}

function scheduleCanonicalRefresh(event: Event, isCurrent: () => boolean) {
  const sessionID = eventSessionID(event)
  // A run mid-flight counts as busy even while its live parts stream in.
  // Terminal events (execution succeeded/failed/interrupted, session.error)
  // are exempt from the gate — the busy -> idle transition is the
  // authoritative end-of-run refresh, so nothing is lost by skipping the
  // redundant mid-run refreshes.
  const busy = sessionID !== undefined &&
    (useEvents.getState().sessionStatus[sessionID]?.type === "busy" || Boolean(useSessions.getState().sending[sessionID]))
  if (!shouldRefreshCanonicalMessages(event, busy)) return
  if (!sessionID || useSessions.getState().currentSession?.id !== sessionID) return
  const previous = messageRefreshTimers.get(sessionID)
  if (previous) clearTimeout(previous)
  messageRefreshTimers.set(sessionID, setTimeout(() => {
    messageRefreshTimers.delete(sessionID)
    if (!isCurrent()) return
    if (useSessions.getState().currentSession?.id === sessionID) void useSessions.getState().refreshMessages()
  }, 150))
}

function scheduleSessionRefresh(type: string, isCurrent: () => boolean) {
  if (!["session.created", "session.renamed", "session.moved", "session.deleted"].includes(type)) return
  if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer)
  sessionRefreshTimer = setTimeout(() => {
    sessionRefreshTimer = null
    if (!isCurrent()) return
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

// Running-equivalent statuses worth resyncing. "retry" (the server is
// automatically retrying a failed step) is still in-flight exactly like
// "busy", and strands the same way when its terminal session.status lands
// during an outage — so both count as stale-running for the resync.
const isRunningEquivalent = (status: SessionStatus | undefined): boolean =>
  status !== undefined && (status.type === "busy" || status.type === "retry")

// Re-sync any session currently marked busy/retry against the server after an
// SSE reconnect. sessionStatus/sending are SSE-driven and there is normally
// no other path to idle — if the server's busy -> idle `session.status`
// event fired while the network was down, SSE reconnect resumes the stream
// from "now" (it does not replay missed events), so without this the busy
// flag would never clear and the UI would show a stuck 'processing' spinner
// forever (issue #123).
//
// Only ever CLEARS a running-equivalent flag the server confirms is stale via
// isSessionActuallyIdle — it never marks a session busy, so it can't
// clobber a genuinely still-busy session. Also re-checks sessionStatus right
// before writing, so a real session.status event that lands while the fetch
// is in flight (e.g. the session went busy again) wins over this resync.
async function resyncBusySessions(isCurrent: () => boolean) {
  if (!isCurrent()) return
  const runningEquivalentIDs = Object.entries(useEvents.getState().sessionStatus)
    .filter(([, status]) => isRunningEquivalent(status))
    .map(([sessionID]) => sessionID)
  if (runningEquivalentIDs.length === 0) return

  await Promise.all(
    runningEquivalentIDs.map(async (sessionID) => {
      if (!isCurrent()) return
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
        if (!isSessionActuallyIdle(messages)) return // server says still running - leave it alone

        // A fresh session.status event may have landed on the SSE stream
        // while this fetch was in flight — that's authoritative, don't
        // stomp on it.
        if (!isCurrent() || !isRunningEquivalent(useEvents.getState().sessionStatus[sessionID])) return

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
  phase: "stopped",
  authError: false,
  reconnectAttempts: 0,
  reconnectVisible: false,
  recoveryVisible: false,
  lastDisconnectAt: null,
  sessionStatus: {},
  statusText: {},
  permissions: {},
  questions: {},

  connect: () => {
    const streamGeneration = ++generation
    streamedParts.clear()
    streamedToolParts.clear()
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
    set({ connected: false, phase: "connecting", authError: false, recoveryVisible: false })
    console.log("[SSE] Connecting to event stream...")
    addBreadcrumb({ category: "sse", message: "connecting" })

    // Run in background
    ;(async () => {
      let reconnectScheduled = false
      let resynced = false
      // The stream is live as soon as it is open and error-free — a healthy
      // idle stream may never yield an event, so waiting for one left the
      // phase stuck in connecting/reconnecting and the retry banner up
      // forever. Applied on the first SSE event (fast path) and on the
      // stability timer (idle path). The ready transition is skipped once a
      // real event already applied it (streamLiveTransition returns null),
      // and the authoritative/busy resync runs at most once per physical
      // subscription via resynced, so an event-driven recovery is never
      // duplicated by the timer.
      const markStreamLive = () => {
        const transition = streamLiveTransition(get())
        if (transition) set(transition)
        if (!resynced) {
          resynced = true
          void authoritativeResync(client, () => generation === streamGeneration && !currentController.signal.aborted).then(() => {
            if (generation === streamGeneration) return resyncBusySessions(() => generation === streamGeneration && !currentController.signal.aborted)
          }).catch((error) => {
            console.warn("[Events] Failed authoritative resync:", error)
          })
        }
      }

      const stableTimer = setTimeout(() => {
        if (!currentController.signal.aborted && generation === streamGeneration) {
          set({ reconnectAttempts: 0, lastDisconnectAt: null })
          // No event arrived within the stability window — the stream is
          // open but idle. Mark it ready now (clearing the retry banner) and
          // resync once so missed events from the outage are still
          // reconciled, exactly as the first-event path would.
          markStreamLive()
        }
      }, STABLE_CONNECTION_MS)

      const scheduleReconnect = (reason: unknown) => {
        if (reconnectScheduled || currentController.signal.aborted || generation !== streamGeneration) return
        reconnectScheduled = true
        const state = get()
        const reconnectAttempts = state.reconnectAttempts + 1
        const lastDisconnectAt = state.lastDisconnectAt ?? Date.now()
        const disconnectedFor = Date.now() - lastDisconnectAt
        set({ connected: false, phase: "reconnecting", reconnectAttempts, reconnectVisible: true, lastDisconnectAt })

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
          data: {
            attempt: reconnectAttempts,
            delayMs: jitteredDelay,
            reasonClass: isAuthError(reason) ? "authorization" : reason instanceof Error ? "error" : "unknown",
          },
        })
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          if (generation === streamGeneration) get().connect()
        }, jitteredDelay)
      }

      try {
        for await (const event of client.global.events(currentController.signal)) {
          if (currentController.signal.aborted || generation !== streamGeneration) break

          // A parsed event is our first proof that authentication and the
          // subscription are usable. Do not wait for the stability timer.
          markStreamLive()

          const type = event.type
          const props = event.properties
          scheduleCanonicalRefresh(event, () => generation === streamGeneration && !currentController.signal.aborted)
          scheduleSessionRefresh(type, () => generation === streamGeneration && !currentController.signal.aborted)

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
                  const match = cachedSession(sessionID)
                  notify({
                    category: "completed",
                    title: "Task completed",
                    body: sanitizeBody(match?.title, "Session finished processing"),
                    sessionId: sessionID,
                    directory: match?.directory,
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
                const statusText = statusFromPart(part)
                if (get().statusText[sessionID] !== statusText) {
                  set((state) => ({
                    statusText: { ...state.statusText, [sessionID]: statusText },
                  }))
                }
              }

              if (part.type === "text" || part.type === "reasoning") {
                streamedParts.push(`${part.sessionID ?? ""}\u0000${part.messageID}\u0000${part.id}`, part, props.canonicalRefresh === true)
              } else {
                streamedToolParts.push(`${part.sessionID ?? ""}\u0000${part.messageID}\u0000${part.id}`, part, props.canonicalRefresh === true)
              }
              break
            }

            case "session.updated": {
              const info = value(props, "info", isSession)
              if (!info) break
              useSessions.getState().handleEvent({ type, properties: { info } })
              break
            }

            case "session.agent.selected":
            case "session.model.selected": {
              useSessions.getState().handleEvent({ type, properties: props })
              break
            }

            case "session.created": {
              const info = value(props, "info", isSession)
              if (!info) break
              useSessions.getState().handleEvent({ type, properties: { info } })
              break
            }

            case "session.deleted": {
              const sessionID = value(props, "sessionID", isString)
              if (!sessionID) break
              useSessions.getState().handleEvent({ type, properties: { sessionID } })
              break
            }

            case "session.renamed":
            case "session.moved": {
              const sessionID = value(props, "sessionID", isString)
              if (!sessionID) break
              useSessions.getState().handleEvent({ type, properties: props })
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
                directory: cachedSession(sessionID)?.directory,
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
                directory: cachedSession(req.sessionID)?.directory,
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

            case "form.created": {
              // The server surfaces the question tool through forms
              // (metadata.kind === "question") — there is no question.asked.
              const form = props.form
              if (!isQuestionForm(form)) break
              const req = fromQuestionForm(form)
              if (req.questions.length === 0) break
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
                title: req.questions[0]?.header || "Input needed",
                body: sanitizeBody(req.questions[0]?.question, "The assistant has a question"),
                sessionId: req.sessionID,
                dedupeKey: `question-${req.id}`,
                dedupeCooldownMs: 60_000,
              })
              break
            }

            case "form.replied":
            case "form.cancelled": {
              const sessionID = value(props, "sessionID", isString)
              const formID = value(props, "id", isString)
              if (!sessionID || !formID) break
              resolvedQuestions.add(formID)
              set((state) => ({
                questions: {
                  ...state.questions,
                  [sessionID]: (state.questions[sessionID] || []).filter((q) => q.id !== formID),
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
          if (generation === streamGeneration) set({ connected: false, phase: "auth-error", authError: true, reconnectVisible: false })
        } else {
          scheduleReconnect(err)
        }
      } finally {
        clearTimeout(stableTimer)
        if (currentController.signal.aborted || generation !== streamGeneration) {
          console.log("[SSE] Disconnected (aborted)")
        }
      }
    })()
  },

  pause: () => {
    generation += 1
    streamedParts.clear()
    streamedToolParts.clear()
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    controller?.abort()
    controller = null
    set({ connected: false, phase: "paused", reconnectAttempts: 0, reconnectVisible: false, recoveryVisible: false })
  },

  resume: () => {
    if (!useConnections.getState().client) return
    // Only auto-reconnect from phases where a retry is routine (app
    // backgrounded, transient drop). An auth-error phase means the server
    // rejected our credentials — resuming on app-activate would just replay
    // the failing auth with no path to recovery (issue #76). Retrying after
    // credentials change goes through a manual connect(), which has no such
    // guard.
    if (!canAutoResume(get().phase)) return
    get().connect()
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
    generation += 1
    for (const timer of messageRefreshTimers.values()) clearTimeout(timer)
    messageRefreshTimers.clear()
    if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer)
    sessionRefreshTimer = null
    streamedParts.clear()
    streamedToolParts.clear()
    resolvedPermissions.clear()
    resolvedQuestions.clear()
    erroredSessions.clear()
    abortedSessions.clear()
    set({
      connected: false,
      phase: "stopped",
      authError: false,
      reconnectAttempts: 0,
      reconnectVisible: false,
      recoveryVisible: false,
      lastDisconnectAt: null,
      sessionStatus: {},
      statusText: {},
      permissions: {},
      questions: {},
    })
  },
}))
