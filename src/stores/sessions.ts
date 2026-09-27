import { create } from "zustand"
import {
  ApiError,
  isAuthError,
  type Session,
  type Message,
  type Part,
  type Event,
  type MessageWithParts,
  type Client,
  type CursorPage,
} from "../lib/sdk"
import { useConnections } from "./connections"
import { useSettings } from "./settings"
import { addBreadcrumb } from "../lib/sentry"
import { AnalyticsEvent, track } from "../lib/analytics"
import { extractPromptFromParts, type PromptFromParts } from "../lib/prompt-from-parts"
import { mergeIncomingMessage } from "../lib/message-merge"
import { isColdSessionLoad, isLiveEventForSession } from "../lib/session-load-reconcile"
import { appendCursorPage, dedupePage, mergeCursorRefresh, mergeCursorRefreshSnapshot, mergePartsRefreshSnapshot, prependCursorPage, truncateCommittedRevert } from "../lib/cursor-pagination"
import { attachmentUri } from "../lib/session-request"
import { sessionInListScope } from "../lib/session-list-scope"
import { childCountsFromSessions, decrementChildCount, findCachedSession, incrementChildCount, purgeSessionHierarchy, upsertSessionHierarchy } from "../lib/session-hierarchy"
import { RevertResponseGuard, revertPatchFromEvent, sessionInfoPatchFromEvent } from "./session-events"

// Fast-fail bound for the sessions list on app start/open. A dead or
// unreachable saved server otherwise holds the sessions tab's spinner for the
// full 30s general request timeout before surfacing any error — reading as a
// stuck loader. The list itself is cheap on a live server (well under a
// second), so a short bound only affects the offline case we want to fail fast.
const SESSION_LIST_TIMEOUT_MS = 10_000

function parseMessages(response: MessageWithParts[]): { messages: Message[]; parts: Record<string, Part[]> } {
  const messages: Message[] = []
  const parts: Record<string, Part[]> = {}

  for (const item of response || []) {
    messages.push(item.info)
    parts[item.info.id] = item.parts || []
  }

  return { messages, parts }
}

function pageSize(): number {
  return useSettings.getState().pageSize
}

// Which universe of sessions the list shows: only the active connection's
// workspace (server default), or every session on the server ("all").
function listScope() {
  return useSettings.getState().sessionListScope ?? "workspace"
}

interface SessionsState {
  sessions: Session[]
  childrenByParent: Record<string, Session[]>
  childrenLoading: Record<string, boolean>
  childrenLoaded: Record<string, boolean>
  childrenHasMore: Record<string, boolean>
  childrenCursor: Record<string, CursorPage<Session>["cursor"]>
  childrenGeneration: Record<string, number>
  // Directory-wide prefetched child counts (parentID -> known children). A
  // fallback chevron hint until a parent's children are actually loaded.
  childCounts: Record<string, number>
  currentSession: Session | null
  messages: Message[]
  parts: Record<string, Part[]>
  isSessionsLoading: boolean
  isSessionLoading: boolean
  // Per-session optimistic sending flag — bridging gap between user tap and SSE busy
  sending: Record<string, boolean>
  loadingMore: boolean
  hasMore: boolean
  loadingMoreSessions: boolean
  hasMoreSessions: boolean
  sessionCursor: CursorPage<Session>["cursor"]
  messageCursor: CursorPage<MessageWithParts>["cursor"]
  error: string | null

  // Actions
  loadSessions: () => Promise<void>
  loadMoreSessions: () => Promise<void>
  loadChildren: (parentID: string) => Promise<void>
  loadMoreChildren: (parentID: string) => Promise<void>
  selectSession: (sessionID: string, directory?: string) => Promise<void>
  loadOlderMessages: () => Promise<void>
  createSession: (title?: string) => Promise<Session | null>
  deleteSession: (sessionID: string) => Promise<void>
  sendMessage: (
    text: string,
    model?: { providerID: string; modelID: string },
    agent?: string,
    files?: Array<{ uri: string; mime: string; filename?: string; base64?: string }>,
    variant?: string,
  ) => Promise<void>
  abortSession: () => Promise<void>
  refreshMessages: () => Promise<void>

  // Revert (edit sent message) / unrevert (undo the pending revert)
  revertToMessage: (messageID: string) => Promise<RevertResult>
  // Resolves true when the server restore succeeded; false when it failed, so
  // callers only clear the prefilled undo draft on a real success.
  unrevertSession: () => Promise<boolean>
  // Commit a staged revert before sending. No-op when there is nothing
  // staged; rejects when the server commit fails so callers can abort the
  // send instead of running with a revert still pending server-side.
  commitPendingRevert: () => Promise<void>

  // Event handling
  handleEvent: (event: Event) => void
}

export type RevertResult = ({ ok: true } & PromptFromParts) | { ok: false; reason: "unsupported" | "auth" | "error" }

// Sessions the user aborted since they last went busy. Mirrors events.ts's
// erroredSessions: SessionStatus has no "aborted" variant — an aborted run
// still ends with a busy -> idle transition — so without this mark a
// user-cancelled run would count as response_received in analytics and as a
// success toward the store review prompt. events.ts (which already imports
// this module) clears entries on busy and checks them on busy -> idle.
export const abortedSessions = new Set<string>()

// Orders revert stage/clear/commit responses against later requests and
// against SSE revert events for the same session — see RevertResponseGuard.
const revertGuard = new RevertResponseGuard()

// Monotonic token guarding selectSession against out-of-order resolution: a
// slow fetch for a session the user has already navigated away from must not
// overwrite the messages/currentSession of a newer selection. Each call takes
// the next value and only commits its result if still the latest.
let selectSeq = 0
let canonicalPageSeq = 0
let rootListSeq = 0
let hierarchyScope = ""
let hierarchyConnection: ReturnType<typeof useConnections.getState>["clientBase"] = null

function connectionScope(): string {
  const state = useConnections.getState()
  // The list scope is part of the cache identity: switching between
  // workspace/all invalidates hierarchy caches and seq guards so a response
  // fetched for one scope never commits into the other.
  return `${state.activeConnection?.id ?? ""}\u0000${state.activeConnection?.directory ?? ""}\u0000${state.clientBase?.baseUrl ?? ""}\u0000${listScope()}`
}

// Client for listing sessions, matching the selected scope. "workspace" uses
// the active connection's client, whose directory query param makes the
// server return only that directory's sessions (exact location.directory
// match). "all" queries unscoped, like the pre-scope behavior.
function listClient(): Client | null {
  const connState = useConnections.getState()
  if (listScope() === "workspace") return connState.client
  return connState.clientForDirectory(undefined) || connState.client
}

function upsertHierarchy(state: SessionsState, session: Session): Partial<SessionsState> {
  const result = upsertSessionHierarchy(state.sessions, state.childrenByParent, session)
  return { sessions: result.roots, childrenByParent: result.childrenByParent }
}

function purgeHierarchy(state: SessionsState, sessionID: string): Partial<SessionsState> {
  const removedSessions = [
    ...state.sessions,
    ...Object.values(state.childrenByParent).flat(),
  ]
  const hierarchy = purgeSessionHierarchy(state.sessions, state.childrenByParent, sessionID)
  const ids = hierarchy.removed
  const invalidatedParents = new Set(
    removedSessions
      .filter((session) => ids.has(session.id) && session.parentID && !ids.has(session.parentID))
      .map((session) => session.parentID!),
  )
  const generations = { ...state.childrenGeneration }
  for (const id of [...ids, ...invalidatedParents]) generations[id] = (generations[id] ?? 0) + 1
  return {
    sessions: hierarchy.roots,
    childrenByParent: hierarchy.childrenByParent,
    childrenLoading: Object.fromEntries(Object.entries(state.childrenLoading).filter(([id]) => !ids.has(id) && !invalidatedParents.has(id))),
    childrenLoaded: Object.fromEntries(Object.entries(state.childrenLoaded).filter(([id]) => !ids.has(id))),
    childrenHasMore: Object.fromEntries(Object.entries(state.childrenHasMore).filter(([id]) => !ids.has(id))),
    childrenCursor: Object.fromEntries(Object.entries(state.childrenCursor).filter(([id]) => !ids.has(id))),
    childrenGeneration: generations,
    childCounts: Object.fromEntries(Object.entries(state.childCounts).filter(([id]) => !ids.has(id))),
    currentSession: state.currentSession && ids.has(state.currentSession.id) ? null : state.currentSession,
    messages: state.currentSession && ids.has(state.currentSession.id) ? [] : state.messages,
    parts: state.currentSession && ids.has(state.currentSession.id) ? {} : state.parts,
  }
}

// Get the right client for a session's directory
function clientFor(directory?: string): Client | null {
  const connState = useConnections.getState()
  if (!directory) return connState.client
  const connDir = connState.activeConnection?.directory
  if (directory !== connDir) return connState.clientForDirectory(directory)
  return connState.client
}

export const useSessions = create<SessionsState>((set, get) => ({
  sessions: [],
  childrenByParent: {},
  childrenLoading: {},
  childrenLoaded: {},
  childrenHasMore: {},
  childrenCursor: {},
  childrenGeneration: {},
  childCounts: {},
  currentSession: null,
  messages: [],
  parts: {},
  isSessionsLoading: false,
  isSessionLoading: false,
  sending: {},
  loadingMore: false,
  hasMore: false,
  loadingMoreSessions: false,
  hasMoreSessions: false,
  sessionCursor: {},
  messageCursor: {},
  error: null,

  loadSessions: async () => {
    // Session rows carry their location, which scopes all subsequent calls.
    const client = listClient()
    if (!client) {
      set({ error: "No active connection" })
      return
    }

    const seq = ++rootListSeq
    const scope = connectionScope()
    const connection = useConnections.getState().clientBase
    if (hierarchyScope && (hierarchyScope !== scope || hierarchyConnection !== connection)) {
      set((state) => ({
        childrenByParent: {},
        childrenLoading: {},
        childrenLoaded: {},
        childrenHasMore: {},
        childrenCursor: {},
        childCounts: {},
        childrenGeneration: Object.fromEntries(Object.entries(state.childrenGeneration).map(([id, generation]) => [id, generation + 1])),
      }))
    }
    hierarchyScope = scope
    hierarchyConnection = connection
    try {
      set({ isSessionsLoading: true, error: null })
      const page = await client.session.page({ limit: 50, order: "desc", parentID: null }, SESSION_LIST_TIMEOUT_MS)
      if (seq !== rootListSeq || scope !== connectionScope() || connection !== useConnections.getState().clientBase) return
      // A successful root-list load starts a new children epoch: previously
      // expanded parents keep their cached rows on screen (no flicker), but
      // the loaded/cursor flags reset and each is refetched below. Without
      // this, new subagent sessions never appear on pull-to-refresh — the
      // sticky childrenLoaded guard made the first expand's data permanent
      // until an app restart.
      const refetchParents = Object.keys(get().childrenLoaded)
      set((state) => ({
        sessions: dedupePage(page).filter((session) => !session.parentID),
        sessionCursor: page.cursor,
        hasMoreSessions: Boolean(page.cursor.next),
        isSessionsLoading: false,
        childrenLoading: {},
        childrenLoaded: {},
        childrenHasMore: {},
        childrenCursor: {},
        childrenGeneration: Object.fromEntries(Object.entries(state.childrenGeneration).map(([id, generation]) => [id, generation + 1])),
      }))
      for (const parentID of refetchParents) void get().loadChildren(parentID)
      // Prefetch directory-wide child counts: an unfiltered list includes
      // child sessions, so rows can show (or omit) the expand chevron without
      // per-parent fetches. Fire-and-forget — the same seq/scope/connection
      // guards as the root page keep a stale response from writing counts for
      // another connection or directory. On failure counts stay unknown and
      // chevrons simply don't show until the next successful load.
      void client.session.list({ limit: 300 }, SESSION_LIST_TIMEOUT_MS)
        .then((allSessions) => {
          if (seq !== rootListSeq || scope !== connectionScope() || connection !== useConnections.getState().clientBase) return
          set({ childCounts: childCountsFromSessions(allSessions) })
        })
        .catch(() => {})
    } catch (error) {
      if (seq === rootListSeq && scope === connectionScope() && connection === useConnections.getState().clientBase) set({ error: "Failed to load sessions", isSessionsLoading: false })
    }
  },

  loadMoreSessions: async () => {
    const client = listClient()
    const cursor = get().sessionCursor.next
    if (!client || !cursor || get().loadingMoreSessions) return

    const seq = rootListSeq
    const scope = connectionScope()
    const connection = useConnections.getState().clientBase
    try {
      set({ loadingMoreSessions: true })
      const page = await client.session.page({ limit: 50, cursor, parentID: null }, SESSION_LIST_TIMEOUT_MS)
      if (seq !== rootListSeq || scope !== connectionScope() || connection !== useConnections.getState().clientBase) return
      set((state) => ({
        sessions: appendCursorPage(state.sessions, { ...page, data: page.data.filter((session) => !session.parentID) }),
        sessionCursor: page.cursor,
        hasMoreSessions: Boolean(page.cursor.next),
        loadingMoreSessions: false,
      }))
    } catch {
      if (seq === rootListSeq && scope === connectionScope() && connection === useConnections.getState().clientBase) set({ loadingMoreSessions: false })
    }
  },

  loadChildren: async (parentID) => {
    const state = get()
    if (state.childrenLoading[parentID] || state.childrenLoaded[parentID]) return
    const parent = findCachedSession(parentID, state.sessions, state.childrenByParent, state.currentSession)
    if (!parent) return
    const client = clientFor(parent.directory)
    if (!client) return
    const generation = (state.childrenGeneration[parentID] ?? 0) + 1
    const scope = connectionScope()
    const connection = useConnections.getState().clientBase
    set((current) => ({
      childrenLoading: { ...current.childrenLoading, [parentID]: true },
      childrenGeneration: { ...current.childrenGeneration, [parentID]: generation },
    }))
    try {
      const page = await client.session.page({ limit: 50, order: "desc", parentID }, SESSION_LIST_TIMEOUT_MS)
      if (get().childrenGeneration[parentID] !== generation || connectionScope() !== scope || connection !== useConnections.getState().clientBase) return
      set((current) => ({
        childrenByParent: { ...current.childrenByParent, [parentID]: dedupePage(page).filter((session) => session.parentID === parentID) },
        childrenLoading: { ...current.childrenLoading, [parentID]: false },
        childrenLoaded: { ...current.childrenLoaded, [parentID]: true },
        childrenHasMore: { ...current.childrenHasMore, [parentID]: Boolean(page.cursor.next) },
        childrenCursor: { ...current.childrenCursor, [parentID]: page.cursor },
      }))
    } catch {
      if (get().childrenGeneration[parentID] === generation && connectionScope() === scope && connection === useConnections.getState().clientBase) {
        set((current) => ({ childrenLoading: { ...current.childrenLoading, [parentID]: false } }))
      }
    }
  },

  loadMoreChildren: async (parentID) => {
    const state = get()
    const cursor = state.childrenCursor[parentID]?.next
    if (!cursor || state.childrenLoading[parentID]) return
    const parent = findCachedSession(parentID, state.sessions, state.childrenByParent, state.currentSession)
    if (!parent) return
    const client = clientFor(parent.directory)
    if (!client) return
    const generation = state.childrenGeneration[parentID] ?? 0
    const scope = connectionScope()
    const connection = useConnections.getState().clientBase
    set((current) => ({ childrenLoading: { ...current.childrenLoading, [parentID]: true } }))
    try {
      const page = await client.session.page({ limit: 50, cursor, parentID }, SESSION_LIST_TIMEOUT_MS)
      if (get().childrenGeneration[parentID] !== generation || connectionScope() !== scope || connection !== useConnections.getState().clientBase) return
      set((current) => ({
        childrenByParent: {
          ...current.childrenByParent,
          [parentID]: appendCursorPage(current.childrenByParent[parentID] ?? [], { ...page, data: page.data.filter((session) => session.parentID === parentID) }),
        },
        childrenLoading: { ...current.childrenLoading, [parentID]: false },
        childrenHasMore: { ...current.childrenHasMore, [parentID]: Boolean(page.cursor.next) },
        childrenCursor: { ...current.childrenCursor, [parentID]: page.cursor },
      }))
    } catch {
      if (get().childrenGeneration[parentID] === generation && connectionScope() === scope && connection === useConnections.getState().clientBase) {
        set((current) => ({ childrenLoading: { ...current.childrenLoading, [parentID]: false } }))
      }
    }
  },

  selectSession: async (sessionID, directory) => {
    // Use directory-specific client if the session belongs to a different project
    const connState = useConnections.getState()
    const client = directory ? connState.clientForDirectory(directory) : connState.client
    if (!client) {
      set({ error: "No active connection" })
      return
    }

    const seq = ++selectSeq
    addBreadcrumb({ category: "session", message: "select", data: { sessionID, hasDirectory: Boolean(directory) } })
    // Re-selecting the session already shown on screen (e.g. #121's
    // useFocusEffect resync firing again on re-entry) is a background
    // refresh, not a cold load: the screen already has this session's
    // messages, and live SSE updates keep flowing to them the whole time.
    // Forcing isLoading back to true here would hide the entire
    // conversation — including anything streaming in live right now —
    // behind a spinner for as long as this redundant fetch takes, and if it
    // stalls (flaky network), the screen looks permanently stuck "loading"
    // until the user backs out and re-enters (issue #150). Only a
    // genuinely new/different session needs the blocking spinner.
    const isColdLoad = isColdSessionLoad(get().currentSession?.id, sessionID)
    try {
      // A cold load binds the store to the target session immediately. While
      // the target's fetch is in flight, leaving `currentSession` pointing at
      // the session the user just left let every consumer that acts on
      // "the current session" — a send racing the navigation, permission
      // replies — target the wrong session. Nothing can be shown for the
      // target yet, so its previous transcript is cleared with it; the
      // canonical page replaces it below on success.
      //
      // The optimistic `sending` flag is deliberately NOT reset here. SSE
      // owns it (busy/retry -> true, idle/error -> false, and the reconnect
      // resync reconciles it), so re-entering a still-running session must
      // keep the stop control alive instead of clearing it until the run's
      // next (possibly far-off) status event.
      set((state) => ({
        isSessionLoading: isColdLoad ? true : state.isSessionLoading,
        error: null,
        hasMore: false,
        messageCursor: {},
        loadingMore: false,
        ...(isColdLoad ? { currentSession: null, messages: [], parts: {} } : {}),
      }))

      // Snapshot what is on screen when the request begins. The canonical
      // page repairs/reorders messages that existed then, while anything
      // added live meanwhile (optimistic temp sends, real SSE arrivals) is
      // retained after it — a stale response must not drop or misorder those.
      const snapshot = get().messages
      const partsSnapshot = get().parts
      const pageSeq = ++canonicalPageSeq

      const [session, messagePage] = await Promise.all([
        client.session.get(sessionID),
        client.session.messagePage(sessionID, { limit: pageSize(), order: "desc" }),
      ])

      // A newer selectSession started while we were fetching — discard this
      // stale result so it can't clobber the newer selection.
      if (seq !== selectSeq) return

      const pageIsCurrent = pageSeq === canonicalPageSeq || get().currentSession?.id !== sessionID

      const firstPage = mergeCursorRefresh([], {
        data: messagePage.data.map((item) => item.info),
        cursor: messagePage.cursor,
      })
      const { parts } = parseMessages(messagePage.data)

      set((state) => {
        if (!pageIsCurrent && state.currentSession?.id === sessionID) {
          return { currentSession: session, isSessionLoading: false }
        }
        if (!isColdLoad && state.currentSession?.id === sessionID) {
          const merged = mergeCursorRefreshSnapshot(
            state.messages,
            snapshot,
            { data: messagePage.data.map((item) => item.info), cursor: messagePage.cursor },
          )
          return {
            currentSession: session,
            messages: merged,
            parts: mergePartsRefreshSnapshot(merged, state.parts, partsSnapshot, parts),
            isSessionLoading: false,
            hasMore: Boolean(messagePage.cursor.next),
            messageCursor: messagePage.cursor,
          }
        }
        return {
          currentSession: session,
          messages: firstPage,
          parts: pageIsCurrent ? parts : state.parts,
          isSessionLoading: false,
          hasMore: Boolean(messagePage.cursor.next),
          messageCursor: messagePage.cursor,
        }
      })
    } catch (err) {
      if (seq !== selectSeq) return
      console.error("Failed to load session:", err)
      set({ error: "Failed to load session", isSessionLoading: false })
    }
  },

  loadOlderMessages: async () => {
    const client = clientFor(get().currentSession?.directory)
    const session = get().currentSession
    if (!client || !session) return
    if (get().loadingMore || !get().hasMore) return

    try {
      set({ loadingMore: true })

      const cursor = get().messageCursor.next
      if (!cursor) {
        set({ loadingMore: false, hasMore: false })
        return
      }
      const page = await client.session.messagePage(session.id, { limit: pageSize(), cursor })
      const parsed = parseMessages(page.data)

      set((state) => ({
        ...(state.currentSession?.id !== session.id
          ? {}
          : {
              messages: prependCursorPage(state.messages, {
                data: page.data.map((item) => item.info),
                cursor: page.cursor,
              }),
              parts: { ...parsed.parts, ...state.parts },
              loadingMore: false,
              hasMore: Boolean(page.cursor.next),
              messageCursor: page.cursor,
            }),
      }))
    } catch (error) {
      console.error("Failed to load older messages:", error)
      set({ loadingMore: false })
    }
  },

  createSession: async (title) => {
    const connState = useConnections.getState()
    const client = connState.client
    if (!client) {
      set({ error: "No active connection" })
      return null
    }

    try {
      const created = await client.session.create({ title })
      // Don't optimistically add to sessions list — let loadSessions() handle it
      // to avoid duplicate key errors from race conditions
      set({
        currentSession: created,
        messages: [],
        parts: {},
        hasMore: false,
        messageCursor: {},
        loadingMore: false,
      })
      return created
    } catch (error) {
      set({ error: "Failed to create session" })
      return null
    }
  },

  deleteSession: async (sessionID) => {
    const state = get()
    const session = findCachedSession(sessionID, state.sessions, state.childrenByParent, state.currentSession)
    const client = clientFor(session?.directory)
    if (!client) {
      set({ error: "No active connection" })
      return
    }

    try {
      await client.session.delete(sessionID)
      set((current) => {
        // Decrement the parent's count only if the session is still cached —
        // a session.deleted SSE event that won the race already purged and
        // decremented, so doing it again here would double-count.
        const cached = findCachedSession(sessionID, current.sessions, current.childrenByParent, current.currentSession)
        return {
          ...purgeHierarchy(current, sessionID),
          childCounts: decrementChildCount(current.childCounts, cached?.parentID),
        }
      })
    } catch (error) {
      set({ error: "Failed to delete session" })
      throw error
    }
  },

  sendMessage: async (text, model, agent, files, variant) => {
    const client = clientFor(get().currentSession?.directory)
    const session = get().currentSession
    if (!client || !session) {
      set({ error: "No active session" })
      return
    }

    try {
      set((state) => ({ sending: { ...state.sending, [session.id]: true }, error: null }))
      track(AnalyticsEvent.MessageSent)

      // Add user message optimistically
      const ts = Date.now()
      const userMessage: Message = {
        id: `temp-${ts}`,
        sessionID: session.id,
        role: "user",
        presentation: "user",
        time: { created: ts },
        model,
        agent,
      }
      const optimisticParts: Part[] = []
      if (text) {
        optimisticParts.push({
          id: `temp-part-text-${ts}`,
          messageID: userMessage.id,
          type: "text",
          text,
        })
      }
      if (files) {
        for (let i = 0; i < files.length; i++) {
          const f = files[i]
          optimisticParts.push({
            id: `temp-part-file-${ts}-${i}`,
            messageID: userMessage.id,
            type: "file",
            mime: f.mime,
            url: f.uri,
            filename: f.filename,
          })
        }
      }

      set((state) => ({
        messages: [...state.messages, userMessage],
        parts: { ...state.parts, [userMessage.id]: optimisticParts },
      }))

      // Build prompt parts - images are already converted to JPEG with base64 by toJpeg()
      const promptParts: Array<
        { type: "text"; text: string } | { type: "file"; mime: string; url: string; filename?: string }
      > = []
      if (text) {
        promptParts.push({ type: "text", text })
      }
      if (files) {
        for (const f of files) {
          const url = attachmentUri(f)
          promptParts.push({ type: "file", mime: f.mime, url, filename: f.filename })
        }
      }

      // Await submission (the v2 prompt request resolves fast, well before the
      // streamed response) so a failure here can propagate to the caller — SSE
      // events still update messages/parts/status in real-time on success.
      if (session.revert) {
        await get().commitPendingRevert()
      }
      const selectedAgent = agent && agent !== session.agent ? agent : undefined
      const selectedModel = model && (
        session.model?.providerID !== model.providerID ||
        session.model.modelID !== model.modelID ||
        session.model.variant !== variant
      ) ? model : undefined
      await client.session.prompt(session.id, { parts: promptParts, model: selectedModel, agent: selectedAgent, variant })
    } catch (err) {
      console.error("[sendMessage] error:", err)
      const stillCurrent = get().currentSession?.id === session.id
      set((state) => ({
        ...(stillCurrent ? { error: String(err) } : {}),
        sending: { ...state.sending, [session.id]: false },
      }))
      if (stillCurrent) get().refreshMessages()
      throw err
    }
  },

  abortSession: async () => {
    const client = clientFor(get().currentSession?.directory)
    const session = get().currentSession
    if (!client || !session) return

    // Mark the abort BEFORE the request leaves. The server can emit the run's
    // busy -> idle transition while the interrupt HTTP response is still in
    // flight; by the time the response confirms the interrupt, the completion
    // handler has already run and would count a user-cancelled run as a
    // received response (notification, analytics, review credit). Marking the
    // run as aborted up front closes that race. If the server reports there
    // was no run to interrupt, the mark is removed again: that transition was
    // a genuine completion which the user's stop merely raced.
    const alreadyAborted = abortedSessions.has(session.id)
    abortedSessions.add(session.id)
    try {
      const result = await client.session.interrupt(session.id)
      // The server reports false when there was no run to interrupt — it
      // already finished on its own. That is NOT a user abort: marking it
      // would suppress the completion notification, review credit, and
      // analytics for a legitimate run. Clear the optimistic sending flag and
      // reconcile the transcript instead.
      if (!result.interrupted) {
        if (!alreadyAborted) abortedSessions.delete(session.id)
        set((state) => ({ sending: { ...state.sending, [session.id]: false } }))
        if (get().currentSession?.id === session.id) void get().refreshMessages()
        return
      }
      set((state) => ({ sending: { ...state.sending, [session.id]: false } }))
    } catch {
      if (!alreadyAborted) abortedSessions.delete(session.id)
      set({ error: "Failed to abort session" })
    }
  },

  refreshMessages: async () => {
    const client = clientFor(get().currentSession?.directory)
    const session = get().currentSession
    if (!client || !session) return

    // Snapshot the messages that existed when the request began so a stale
    // response repairs/reorders only those, and any optimistic or real SSE
    // messages added or replaced in flight survive after the canonical data.
    const snapshot = get().messages
    const partsSnapshot = get().parts
    const pageSeq = ++canonicalPageSeq

    try {
      const page = await client.session.messagePage(session.id, { limit: pageSize(), order: "desc" })
      const { parts } = parseMessages(page.data)
      set((state) => {
        if (state.currentSession?.id !== session.id || pageSeq !== canonicalPageSeq) return state
        const messages = mergeCursorRefreshSnapshot(
          state.messages,
          snapshot,
          { data: page.data.map((item) => item.info), cursor: page.cursor },
        )
        return {
          messages,
          parts: mergePartsRefreshSnapshot(messages, state.parts, partsSnapshot, parts),
          hasMore: Boolean(page.cursor.next),
          messageCursor: page.cursor,
        }
      })
    } catch (error) {
      if (get().currentSession?.id === session.id && pageSeq === canonicalPageSeq) {
        set({ error: "Failed to refresh messages" })
      }
    }
  },

  // Stage the revert and return the selected prompt so the composer can edit it.
  revertToMessage: async (messageID) => {
    const client = clientFor(get().currentSession?.directory)
    const session = get().currentSession
    if (!client || !session) return { ok: false, reason: "error" }

    try {
      const token = revertGuard.begin(session.id)
      const updated = await client.session.revert(session.id, messageID)
      // A newer stage/clear (this device or another client) superseded this
      // response while it was in flight — applying it would resurrect a
      // pending revert that was already changed. The prompt parts are local,
      // so the caller can still use the returned edit text.
      if (revertGuard.isCurrent(session.id, token)) {
        set((state) => ({
          currentSession: state.currentSession?.id === session.id ? updated : state.currentSession,
        }))
      }
      return { ok: true, ...extractPromptFromParts(get().parts[messageID]) }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return { ok: false, reason: "unsupported" }
      if (isAuthError(err)) {
        // Expired/invalid credentials — distinct from a generic failure so
        // the caller can point the user at reconnecting rather than "retry".
        if (err.status === 401 || err.status === 403) return { ok: false, reason: "auth" }
      }
      console.error("Failed to revert message:", err)
      set({ error: "Failed to revert message" })
      return { ok: false, reason: "error" }
    }
  },

  unrevertSession: async () => {
    const client = clientFor(get().currentSession?.directory)
    const session = get().currentSession
    if (!client || !session) return false

    try {
      const token = revertGuard.begin(session.id)
      const updated = await client.session.clearRevert(session.id)
      // See revertToMessage: a newer revert action/event wins over this
      // response, so a stale clear can't resurrect the staged revert.
      if (revertGuard.isCurrent(session.id, token)) {
        set((state) => ({
          currentSession: state.currentSession?.id === session.id ? updated : state.currentSession,
        }))
      }
      return true
    } catch (err) {
      console.error("Failed to unrevert session:", err)
      set({ error: "Failed to restore reverted messages" })
      return false
    }
  },

  commitPendingRevert: async () => {
    const session = get().currentSession
    const revert = session?.revert
    if (!session || !revert) return
    const client = clientFor(session.directory)
    if (!client) {
      set({ error: "No active connection" })
      return
    }

    const token = revertGuard.begin(session.id)
    await client.session.commitRevert(session.id)
    // A newer revert action (another stage) or a revert lifecycle event
    // landed while the commit was in flight — it owns the local state now.
    if (!revertGuard.isCurrent(session.id, token)) return
    const { messageID } = revert
    set((state) => {
      if (state.currentSession?.id !== session.id) return state
      const messages = truncateCommittedRevert(state.messages, messageID)
      const messageIDs = new Set(messages.map((message) => message.id))
      return {
        currentSession: { ...state.currentSession, revert: undefined },
        messages,
        parts: Object.fromEntries(Object.entries(state.parts).filter(([id]) => messageIDs.has(id))),
      }
    })
  },

  handleEvent: (event) => {
    const props = event.properties

    if (event.type === "session.agent.selected" || event.type === "session.model.selected") {
      const sessionID = typeof props.sessionID === "string" ? props.sessionID : undefined
      if (!sessionID) return
      const agent = event.type === "session.agent.selected"
        ? (typeof props.agent === "string" ? props.agent : typeof props.name === "string" ? props.name : undefined)
        : undefined
      const rawModel = props.model && typeof props.model === "object" ? props.model as Record<string, unknown> : props
      const model = event.type === "session.model.selected" && typeof rawModel.providerID === "string" && typeof (rawModel.modelID ?? rawModel.id) === "string"
        ? {
            providerID: rawModel.providerID,
            modelID: String(rawModel.modelID ?? rawModel.id),
            ...(typeof rawModel.variant === "string" ? { variant: rawModel.variant } : {}),
          }
        : undefined
      set((state) => {
        const cached = findCachedSession(sessionID, state.sessions, state.childrenByParent, state.currentSession)
        const updated = cached && { ...cached, ...(agent !== undefined ? { agent } : {}), ...(model !== undefined ? { model } : {}) }
        return {
          ...(updated ? upsertHierarchy(state, updated) : {}),
          currentSession: state.currentSession?.id !== sessionID ? state.currentSession : {
            ...state.currentSession,
            ...(agent !== undefined ? { agent } : {}),
            ...(model !== undefined ? { model } : {}),
          },
        }
      })
      return
    }

    if (event.type === "session.created" || event.type === "session.updated") {
      const session = (props.info || props) as Session | undefined
      if (!session?.id) return
      set((state) => {
        // The SSE stream carries events for every workspace on the server.
        // In workspace scope, only admit sessions belonging to the active
        // directory — same exact-match rule the scoped list query uses — so
        // a creation in another workspace can't pollute the list until the
        // next refresh. currentSession stays synced either way: an open
        // session screen needs its updates regardless of list membership.
        const admitted = sessionInListScope(listScope(), useConnections.getState().activeConnection?.directory, session.directory)
        return {
          ...(admitted ? upsertHierarchy(state, session) : {}),
          childCounts: event.type === "session.created" && admitted ? incrementChildCount(state.childCounts, session.parentID) : state.childCounts,
          currentSession: state.currentSession?.id === session.id ? session : state.currentSession,
          isSessionLoading: isLiveEventForSession(session.id, state.currentSession?.id) ? false : state.isSessionLoading,
        }
      })
      return
    }

    if (event.type === "session.deleted") {
      const sessionID = typeof props.sessionID === "string" ? props.sessionID : undefined
      if (!sessionID) return
      set((state) => {
        // Resolve the parent before the purge drops the session from cache so
        // its count can be decremented alongside the recursive removal.
        const cached = findCachedSession(sessionID, state.sessions, state.childrenByParent, state.currentSession)
        return {
          ...purgeHierarchy(state, sessionID),
          childCounts: decrementChildCount(state.childCounts, cached?.parentID),
        }
      })
      return
    }

    if (event.type === "session.renamed" || event.type === "session.moved") {
      const sessionID = typeof props.sessionID === "string" ? props.sessionID : undefined
      if (!sessionID) return
      set((state) => {
        const cached = findCachedSession(sessionID, state.sessions, state.childrenByParent, state.currentSession)
        if (!cached) return state
        const location = props.location && typeof props.location === "object" ? props.location as Record<string, unknown> : undefined
        const updated: Session = {
          ...cached,
          ...(event.type === "session.renamed" && typeof props.title === "string" ? { title: props.title } : {}),
          ...(event.type === "session.moved" && typeof location?.directory === "string"
            ? { directory: location.directory, location: { ...cached.location, directory: location.directory } }
            : {}),
          ...(event.type === "session.moved" && typeof props.projectID === "string" ? { projectID: props.projectID } : {}),
        }
        return {
          ...upsertHierarchy(state, updated),
          currentSession: state.currentSession?.id === sessionID ? updated : state.currentSession,
        }
      })
      return
    }

    if (event.type === "session.revert.staged" || event.type === "session.revert.cleared" || event.type === "session.revert.committed") {
      const patch = revertPatchFromEvent(event)
      if (!patch) return
      // Any revert lifecycle event makes in-flight stage/clear/commit
      // responses stale, even when this session isn't cached locally.
      revertGuard.noteEvent(patch.sessionID)
      set((state) => {
        const cached = findCachedSession(patch.sessionID, state.sessions, state.childrenByParent, state.currentSession)
        const revert = patch.revert ?? undefined
        const updated = cached && { ...cached, revert }
        const current = state.currentSession?.id === patch.sessionID ? state.currentSession : null
        // Nothing cached for this session (list not loaded, other clients'
        // session): leave state untouched rather than re-rendering subscribers.
        if (!updated && !current) return state
        // A committed revert is authoritative cleanup: the server removed the
        // boundary message and everything after it, so drop those local rows
        // (and their parts) rather than showing content the next canonical
        // page will no longer return. Optimistic temps stay — a send that
        // raced the commit is still in flight and must not vanish.
        if (patch.committedTo && current) {
          const messages = truncateCommittedRevert(state.messages, patch.committedTo)
          const messageIDs = new Set(messages.map((message) => message.id))
          return {
            ...(updated ? upsertHierarchy(state, updated) : {}),
            currentSession: { ...current, revert },
            messages,
            parts: Object.fromEntries(Object.entries(state.parts).filter(([messageID]) => messageIDs.has(messageID))),
          }
        }
        return {
          ...(updated ? upsertHierarchy(state, updated) : {}),
          ...(current ? { currentSession: { ...current, revert } } : {}),
        }
      })
      return
    }

    if (event.type === "session.metadata.updated" || event.type === "session.permissions") {
      const patch = sessionInfoPatchFromEvent(event)
      if (!patch) return
      set((state) => {
        const cached = findCachedSession(patch.sessionID, state.sessions, state.childrenByParent, state.currentSession)
        const current = state.currentSession?.id === patch.sessionID ? state.currentSession : null
        // Nothing cached for this session (list not loaded, another client's
        // session): leave state untouched rather than re-rendering subscribers.
        if (!cached && !current) return state
        // Session metadata and the permission ruleset are not part of the
        // shared Session type — the UI doesn't render them — but a cross-client
        // update is still the latest server state. Object.assign keeps them on
        // the cached object (typed writes are unnecessary; the next canonical
        // fetch simply replaces the object) without widening the public type.
        const info: Record<string, unknown> = {}
        if (patch.metadata) info.metadata = patch.metadata
        if (patch.permissions) info.permissions = patch.permissions
        const updated = cached ? Object.assign({}, cached, info) as Session : null
        return {
          ...(updated ? upsertHierarchy(state, updated) : {}),
          ...(current ? { currentSession: Object.assign({}, current, info) as Session } : {}),
        }
      })
      return
    }

    const { currentSession } = get()
    if (!currentSession) return

    switch (event.type) {
      case "message.updated": {
        const message = (props.info || props.message) as Message | undefined
        if (!message || !isLiveEventForSession(message.sessionID, currentSession.id)) return

        set((state) => ({
          messages: mergeIncomingMessage(state.messages, message),
          // A live update for the session on screen is proof it has content
          // to show — clear any stuck spinner even if the initial (or a
          // redundant re-focus) GET hasn't resolved yet, or never does
          // (issue #150). Only ever clears, never sets it back to true.
          isSessionLoading: false,
        }))
        break
      }

      case "message.part.updated": {
        const part = props.part as Part | undefined
        if (!part) return
        // Only handle parts for current session
        if (part.sessionID && part.sessionID !== currentSession.id) return

        set((state) => {
          const messageParts = state.parts[part.messageID] || []
          const exists = messageParts.some((p) => p.id === part.id)
          return {
            parts: {
              ...state.parts,
              [part.messageID]: exists
                ? messageParts.map((p) => p.id !== part.id ? p : {
                    ...p,
                    ...part,
                    state: part.state ? {
                      ...p.state,
                      ...part.state,
                      metadata: { ...(p.state?.metadata ?? {}), ...(part.state.metadata ?? {}) },
                    } : p.state,
                  })
                : [...messageParts, part],
            },
            // See message.updated above — a live part update is just as
            // much proof of life as a message update.
            isSessionLoading: false,
          }
        })
        break
      }

      case "message.removed": {
        const messageID = props.messageID as string
        if (!messageID) return
        set((state) => ({
          messages: state.messages.filter((m) => m.id !== messageID),
          parts: Object.fromEntries(Object.entries(state.parts).filter(([k]) => k !== messageID)),
        }))
        break
      }

    }
  },
}))
