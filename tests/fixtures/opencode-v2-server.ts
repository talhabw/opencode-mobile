/* Deterministic, in-memory OpenCode v2 server for emulator and contract tests.
 *
 * Speaks the released v2.0.x contract that @opencode/client 2.0.x is generated
 * from (https://opencode.ai/v2/openapi.json, linked from
 * https://opencode.ai/v2/docs/api/, verified 2026-09-27). GET /api/info answers
 * with ServerInfo and the removed beta surfaces are absent:
 *     server identity   GET /api/info -> ServerInfo        (/api/health is 404)
 *     current project   GET /api/location.project          (/api/project/current is 404)
 *     session rename    PATCH /api/session/:id {title}
 *     revert clear      DELETE /api/session/:id/revert
 *     form discovery    GET /api/form?location[directory]
 *     form cancel       DELETE /api/session/:id/form/:formID
 *     slash command     {name, text, files?}
 *     permission reply  {decision}
 *     saved grants      GET /api/permission/saved?projectID
 *     saved removal     DELETE /api/permission/saved/:id (204, idempotent)
 *     interrupt         ?resume=true|false
 *     prompt echo       Session.Inbox.User with time: {created}
 *     file browser      GET /api/fs/{list,find,read} over a synthetic tree
 *
 * - IDs follow the official @opencode/schema brands (ses_, msg_, evt_, frm_,
 *   per_, shl_) so payloads decode against the official schemas.
 * - SSE event durability (which events carry a durable envelope and which
 *   version) is read from @opencode/schema/event-manifest, so the fixture
 *   cannot drift from the released event contract. Events carry the required
 *   data fields, including the official session.status/session.idle lifecycle
 *   next to the session.execution.* events the app's V2EventAdapter consumes.
 * - Saved permissions mirror the released server: grants are unique per
 *   (projectID, action, resource), an "always" reply persists exactly the
 *   request's `save` patterns (requests without `save` persist nothing), and
 *   remove is an idempotent 204.
 * - HTTP errors are the released tagged payloads declared by the OpenAPI
 *   document and @opencode/protocol/errors: InvalidRequestError (400, with the
 *   released `kind`), InvalidCursorError, SessionNotFoundError,
 *   MessageNotFoundError, PermissionNotFoundError, FormNotFoundError,
 *   CommandNotFoundError, FileNotFoundError, and UnauthorizedError (401 with
 *   the Basic challenge header). Routes without a declared body (interrupt,
 *   deletes) never parse one; routes that declare a body reject a missing body
 *   with "Expected object" and malformed JSON with "Expected a valid JSON
 *   body". An undeclared route is the released empty 404.
 * - A settled run appends the canonical `idle` bookkeeping message the released
 *   server records (type "idle", outcome succeeded/interrupted, time.created),
 *   so newest-message consumers (reconnect resync, transcript paging) see the
 *   real released shape.
 *
 * Unsupported on purpose (single synthetic project, no real tool execution):
 * /api/experimental/fs/write, integration, mcp, pty, shell, worktree,
 * workspace, stats, session import/export/fork/move/context/inbox/instructions/
 * generate/log, skill, synthetic, shell, compact, wait, background,
 * environment, view, and message get/update. None of them are exercised by the
 * mobile app.
 */

import { posix as posixPath } from "node:path"
import type {
  AgentInfo,
  CommandInfo,
  FormInfo,
  ModelInfo,
  PermissionRequest,
  PermissionSavedInfo,
  ProviderInfo,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageIdle,
  SessionMessageShell,
  SessionMessageSystem,
  SessionMessageUser,
} from "@opencode/client"
import { Latest } from "@opencode/schema/event-manifest"

declare const Bun: { serve(options: { port: number; hostname: string; idleTimeout: number; fetch: (request: Request) => Promise<Response> }): unknown }

type Json = Record<string, unknown>
type Client = { controller: ReadableStreamDefaultController<Uint8Array>; encoder: TextEncoder }
type Stop = () => void

const args = process.argv.slice(2)
const port = Number(args[args.indexOf("--port") + 1] || process.env.PORT || 4100)
const hostname = process.env.OPENCODE_FIXTURE_HOST || "127.0.0.1"

const root = "/fixture/workspace"
const now = 1_700_000_000_000
const project = { id: "fixture-project", directory: root, canonical: root }
const agents = [
  { id: "build", name: "Build", description: "Fixture build agent", mode: "primary", hidden: false, steps: 12, model: { id: "fixture-model", providerID: "fixture" }, request: { settings: {}, headers: {}, body: {} }, permissions: [] },
  { id: "plan", name: "Plan", description: "Fixture planning agent", mode: "primary", hidden: false, request: { settings: {}, headers: {}, body: {} }, permissions: [] },
  { id: "explore", name: "Explore", description: "Fixture subagent", mode: "subagent", hidden: false, request: { settings: {}, headers: {}, body: {} }, permissions: [] },
] satisfies AgentInfo[]
const commands = [
  { name: "review", description: "Review fixture changes" },
  { name: "test", description: "Run fixture checks" },
] satisfies CommandInfo[]
const model = (modelID: string, name: string, variants: string[] = []) => ({
  id: modelID, modelID, providerID: "fixture", name, capabilities: { input: ["text"], output: ["text", "reasoning"], tools: true },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }], limit: { context: 32768, output: 4096 }, variants: variants.map((id) => ({ id })), status: "active", enabled: true, time: { released: now }, package: "fixture",
}) satisfies ModelInfo
const models = [model("fixture-model", "Fixture Model", ["fast", "deep"]), model("fixture-small", "Fixture Small")]
const provider = { id: "fixture", name: "Fixture Provider", package: "fixture", activation: "enabled" } satisfies ProviderInfo
const clients = new Set<Client>()
let sessions: SessionInfo[] = []
let messages = new Map<string, Json[]>()
let permissions: PermissionRequest[] = []
let savedPermissions: PermissionSavedInfo[] = []
let forms: FormInfo[] = []
// One stop handle per session with an in-flight simulated run. Used by
// /interrupt and to keep a superseded or cancelled run from streaming on.
let runs = new Map<string, Stop>()
const durableSeqs = new Map<string, number>()
let eventSequence = 0
let messageSequence = 1
let idleSequence = 0
let messageClock = now + 5_000
let formSequence = 0
let permissionSequence = 1
let savedPermissionSequence = 0
let sessionSequence = 0
// One-shot test hook flag: when armed, the next /api/event subscription stays
// open without the usual immediate server.connected handshake (healthy-but-idle
// SSE reconnect). Consumed by exactly one subscription, then normal behavior
// resumes. See /fixture/reconnect-silent.
let silentNextConnect = false

// Official durable event versions come from the released event manifest
// (@opencode/schema). Ephemeral types (session.text.delta, session.tool.progress,
// session.status, form.*, permission.*, server.connected) must not carry a
// durable envelope.
function durableVersion(type: string): number | undefined {
  const definition = Latest.get(type)
  if (!definition || definition.durability !== "durable") return undefined
  return definition.durable.version
}
const TOKENS = { input: 3, output: 7, reasoning: 0, cache: { read: 0, write: 0 } }

const session = (id: string, title: string, options: { parentID?: string; directory?: string; created?: number; updated?: number; agent?: string; model?: SessionInfo["model"] } = {}): SessionInfo => {
  const created = options.created ?? now
  return {
    id,
    ...(options.parentID ? { parentID: options.parentID } : {}),
    projectID: project.id,
    agent: options.agent ?? "build",
    model: options.model ?? { id: "fixture-model", providerID: "fixture", variant: "fast" },
    location: { directory: options.directory ?? root },
    title,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, updated: options.updated ?? created + 5 },
  }
}
const user = (id: string, _sessionID: string, text: string, created: number): SessionMessageUser => ({ type: "user", id, text, time: { created } })
const assistant = (id: string, text: string, created: number): SessionMessageAssistant => ({ type: "assistant", id, agent: "build", model: { id: "fixture-model", providerID: "fixture" }, cost: 0, tokens: { input: 3, output: 7, reasoning: 0, cache: { read: 0, write: 0 } }, content: [{ type: "text", text }], finish: "stop", time: { created, completed: created + 1 } })
// Monotonic clock for rows created while the fixture runs: insertion order and
// time.created agree for canonical pages and newest-first resync reads.
function nextMessageTime(): number { messageClock += 2; return messageClock }
// Released Sessions append an `idle` bookkeeping row whenever a run settles
// (Session.Message.Idle): outcome succeeded / failed / interrupted. It is the
// newest message of the turn and carries no content parts.
function idleMessage(outcome: SessionMessageIdle["outcome"]): SessionMessageIdle {
  idleSequence += 1
  return { type: "idle", id: `msg_fixture_idle_${idleSequence}`, outcome, time: { created: nextMessageTime() } }
}
const savedPermission = (id: string, projectID: string, action: string, resource: string, created: number): PermissionSavedInfo => ({ id, projectID, action, resource, time: { created, updated: created } })

// Released parity: an "always" reply stores exactly the request's `save`
// patterns (never `resources`) as project-scoped grants. Requests without a
// `save` list persist nothing; grants are unique per project/action/resource.
function persistSavedPermissions(projectID: string, request: PermissionRequest) {
  for (const resource of request.save ?? []) {
    const exists = savedPermissions.some((item) => item.projectID === projectID && item.action === request.action && item.resource === resource)
    if (exists) continue
    savedPermissions.push(savedPermission(`psv_fixture_${++savedPermissionSequence}`, projectID, request.action, resource, Date.now()))
  }
}

function reset() {
  const rootSession = session("ses_fixture_root", "Fixture root session", { created: now, updated: now + 300 })
  const child = session("ses_fixture_child", "Fixture child task", { parentID: rootSession.id, created: now + 1, updated: now + 200 })
  // A session in a second directory so workspace-scoped list queries have
  // something to exclude (the server filters by exact location.directory).
  const other = session("ses_fixture_other", "Other workspace session", { directory: "/fixture/other", created: now + 2, updated: now + 100 })
  sessions = [rootSession, child, other]
  messages = new Map([
    [rootSession.id, [
      user("msg_fixture_user_1", rootSession.id, "Show me the fixture transcript", now),
      assistant("msg_fixture_assistant_1", "This is a deterministic v2 fixture response.", now + 1),
      { type: "system", id: "msg_fixture_instructions", text: `Instruction context updated\n${"Do not render this instruction body. ".repeat(40)}`, time: { created: now + 2 } } satisfies SessionMessageSystem,
      {
        type: "assistant",
        id: "msg_fixture_task",
        agent: "build",
        model: { id: "fixture-model", providerID: "fixture" },
        content: [{ type: "tool", id: "call-task", name: "task", time: { created: now + 3, completed: now + 4 }, state: { status: "completed", input: { description: "Inspect workspace", subagent_type: "explore" }, content: [{ type: "text", text: "Delegated to fixture-child" }], metadata: { sessionId: child.id, parentSessionId: rootSession.id } } }],
        time: { created: now + 3, completed: now + 4 },
      } satisfies SessionMessageAssistant,
      { type: "shell", id: "msg_fixture_shell", shellID: "sh_fixture_1", command: "printf fixture", status: "exited", exit: 0, output: { output: "fixture\n", cursor: 8, size: 8, truncated: false }, time: { created: now + 5, completed: now + 6 } } satisfies SessionMessageShell,
    ]],
    [child.id, [user("msg_fixture_child_user", child.id, "Inspect the workspace", now + 10), { ...assistant("msg_fixture_child_assistant", "Workspace inspection complete.", now + 11), content: [{ type: "tool", id: "call-child", name: "shell", time: { created: now + 11, completed: now + 12 }, state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "fixture.txt" }] } }] } satisfies SessionMessageAssistant]],
  ])
  permissions = [{ id: "per_fixture_1", sessionID: child.id, action: "shell", resources: ["git status"], save: ["git status"], message: "Inspect the child workspace", source: { type: "tool", messageID: "msg_fixture_child_assistant", id: "call-child" } }]
  // Seeded project-scoped approvals. psv_fixture_3 belongs to a different
  // project: the app must never show (or delete) it through the
  // fixture-project list, so project filtering is observable end to end.
  savedPermissions = [
    savedPermission("psv_fixture_1", project.id, "webfetch", "https://example.com", now + 40),
    savedPermission("psv_fixture_2", project.id, "shell", "git log", now + 41),
    savedPermission("psv_fixture_3", "fixture-other-project", "edit", "/fixture/other/notes.md", now + 42),
  ]
  formSequence = 0
  forms = [questionForm(child.id, "msg_fixture_child_assistant")]
  runs = new Map()
  durableSeqs.clear()
  eventSequence = 0
  messageSequence = 1
  idleSequence = 0
  messageClock = now + 5_000
  permissionSequence = 1
  savedPermissionSequence = 3
  sessionSequence = 0
  silentNextConnect = false
}
reset()

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } })
const empty = (status = 204) => new Response(null, { status })
// Released HTTP errors are tagged Effect payloads (OpenAPI error responses and
// @opencode/protocol/errors). An undeclared route is the released empty 404.
const unauthorized = () => json({ _tag: "UnauthorizedError", message: "Authentication required" }, 401, { "www-authenticate": 'Basic realm="Secure Area"' })
const routeNotFound = () => new Response(null, { status: 404 })
const invalidRequest = (message: string, kind?: "Payload" | "Query" | "Params") =>
  json({ _tag: "InvalidRequestError", message, ...(kind ? { kind } : {}) }, 400)
const invalidCursor = () => json({ _tag: "InvalidCursorError", message: "Invalid cursor" }, 400)
const sessionNotFound = (sessionID: string) => json({ _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` }, 404)
const messageNotFound = (sessionID: string, messageID: string) => json({ _tag: "MessageNotFoundError", sessionID, messageID, message: `Message not found: ${messageID}` }, 404)
const permissionNotFound = (requestID: string) => json({ _tag: "PermissionNotFoundError", requestID, message: `Permission request not found: ${requestID}` }, 404)
const formNotFound = (id: string) => json({ _tag: "FormNotFoundError", id, message: `Form not found: ${id}` }, 404)
const commandNotFound = (command: string) => json({ _tag: "CommandNotFoundError", command, message: `Command not found: ${command}` }, 404)
const fileNotFound = (path: string) => json({ _tag: "FileNotFoundError", path, message: `File not found: ${path}` }, 404)

// Released body decoding: routes that declare a body reject a missing body with
// "Expected object" and malformed JSON with "Expected a valid JSON body".
class InvalidBodyError extends Error {
  constructor(readonly reason: "missing" | "malformed") { super(reason) }
}
async function body(request: Request): Promise<Json> {
  const text = await request.text()
  if (text.trim() === "") throw new InvalidBodyError("missing")
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new InvalidBodyError("malformed") }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InvalidBodyError("missing")
  return parsed as Json
}
async function serve(request: Request): Promise<Response> {
  try {
    return await handle(request)
  } catch (error) {
    if (error instanceof InvalidBodyError) {
      return invalidRequest(error.reason === "malformed" ? "Expected a valid JSON body" : "Expected object", "Payload")
    }
    throw error
  }
}
function requireString(input: Json, key: string): Response | undefined {
  if (input[key] === undefined) return invalidRequest(`Missing key\n  at ["${key}"]`, "Payload")
  if (typeof input[key] !== "string") return invalidRequest(`Expected string\n  at ["${key}"]`, "Payload")
  return undefined
}
// Released query validation: order enums and integer limits are rejected with
// InvalidRequestError; undecodable cursors are InvalidCursorError.
function invalidQueryEnum(value: string | null, key: string, values: string[]): Response | undefined {
  if (value === null || values.includes(value)) return undefined
  return invalidRequest(`Expected ${values.map((item) => `"${item}"`).join(" | ")}\n  at ["${key}"]`, "Query")
}
function invalidQueryLimit(value: string | null, minimumMessage = "Expected a value greater than 0"): Response | undefined {
  if (value === null) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return invalidRequest('Expected an integer\n  at ["limit"]', "Query")
  if (parsed <= 0) return invalidRequest(`${minimumMessage}\n  at ["limit"]`, "Query")
  return undefined
}
function location() { return { directory: root } }
function publicLocation() { return { directory: root, project } }
function sessionIDFromPath(path: string) { return decodeURIComponent(path.slice("/api/session/".length).split("/")[0]) }

// ---------------------------------------------------------------------------
// Synthetic filesystem (GET /api/fs/list, /api/fs/find, /api/fs/read)
// ---------------------------------------------------------------------------
// The fixture never touches the host filesystem. Only the paths below resolve,
// and entry paths are rendered relative to the requested location with a
// trailing "/" on directories, matching the released
// Location.response(FileSystem.Entry) contract. The write route
// (/api/experimental/fs/write) is not used by the app and stays unsupported.

interface SyntheticFile { type: "file"; content: string; mime: string }
interface SyntheticDirectory { type: "directory"; children: Record<string, SyntheticNode> }
type SyntheticNode = SyntheticFile | SyntheticDirectory

const syntheticFile = (content: string, mime = "text/plain"): SyntheticFile => ({ type: "file", content, mime })
const syntheticDirectory = (children: Record<string, SyntheticNode>): SyntheticDirectory => ({ type: "directory", children })

const syntheticTree: SyntheticDirectory = syntheticDirectory({
  fixture: syntheticDirectory({
    workspace: syntheticDirectory({
      src: syntheticDirectory({
        lib: syntheticDirectory({
          deep: syntheticDirectory({}),
          "format.ts": syntheticFile("export const formatFixtureValue = (value: string) => value.trim()\n"),
          "utils.ts": syntheticFile("export const fixtureValue = 42\n"),
        }),
        "index.ts": syntheticFile('export * from "./lib/format"\n'),
      }),
      docs: syntheticDirectory({
        "guide.md": syntheticFile("# Fixture guide\n\nSynthetic documentation for the directory browser.\n", "text/markdown"),
      }),
      empty: syntheticDirectory({}),
      "README.md": syntheticFile("# Fixture workspace\n\nSynthetic files served by the released-contract v2 fixture.\n", "text/markdown"),
      "opencode.json": syntheticFile('{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "fixture/fixture-model",\n  "default_agent": "build"\n}\n', "application/json"),
    }),
    other: syntheticDirectory({
      "notes.md": syntheticFile("# Other workspace\n\nSecond fixture location.\n", "text/markdown"),
    }),
  }),
})

function normalizeSyntheticPath(value: string): string | undefined {
  if (!value.startsWith("/")) return undefined
  const normalized = posixPath.normalize(value)
  return normalized === "/" ? "/" : normalized.replace(/\/+$/, "")
}

// Absolute paths are taken as-is; relative ones resolve against the requested
// location. ".." clamps at "/", so it can only reach synthetic nodes.
function resolveSyntheticPath(locationDirectory: string, input: string | null | undefined): string | undefined {
  const raw = input && input !== "." ? input : "."
  return normalizeSyntheticPath(raw.startsWith("/") ? raw : posixPath.join(locationDirectory, raw))
}

function syntheticNodeAt(absolute: string): SyntheticNode | undefined {
  let node: SyntheticNode = syntheticTree
  for (const segment of absolute.split("/").filter(Boolean)) {
    if (node.type !== "directory") return undefined
    const child: SyntheticNode | undefined = node.children[segment]
    if (!child) return undefined
    node = child
  }
  return node
}

function syntheticChildPath(directory: string, name: string): string {
  return directory === "/" ? `/${name}` : `${directory}/${name}`
}

// Entries are relative to the requested location (the app re-roots them) and
// sort directories first, exactly like the released fs.list.
function syntheticDirectoryEntries(locationDirectory: string, directory: string): Array<{ path: string; type: "file" | "directory" }> {
  const node = syntheticNodeAt(directory)
  if (!node || node.type !== "directory") return []
  return Object.entries(node.children)
    .map(([name, child]) => {
      const relative = posixPath.relative(locationDirectory, syntheticChildPath(directory, name)) || name
      return { path: relative + (child.type === "directory" ? "/" : ""), type: child.type }
    })
    .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1))
}

function syntheticEntriesUnder(locationDirectory: string, directory: string, items: Array<{ path: string; type: "file" | "directory" }> = []): Array<{ path: string; type: "file" | "directory" }> {
  const node = syntheticNodeAt(directory)
  if (!node || node.type !== "directory") return items
  for (const [name, child] of Object.entries(node.children)) {
    const childPath = syntheticChildPath(directory, name)
    const relative = posixPath.relative(locationDirectory, childPath) || name
    items.push({ path: relative + (child.type === "directory" ? "/" : ""), type: child.type })
    if (child.type === "directory") syntheticEntriesUnder(locationDirectory, childPath, items)
  }
  return items
}

// Rank matches deterministically: exact basename, basename prefix, basename
// substring, then path substring; ties break on length and lexical order.
function syntheticFindScore(path: string, needle: string): number {
  const trimmed = path.replace(/\/+$/, "")
  const basename = trimmed.slice(trimmed.lastIndexOf("/") + 1).toLowerCase()
  if (basename === needle) return 0
  if (basename.startsWith(needle)) return 1
  if (basename.includes(needle)) return 2
  return trimmed.toLowerCase().includes(needle) ? 3 : -1
}

function decodePathSuffix(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

// Tagged error encoding required by the released fs OpenAPI
// (InvalidRequestError / FileNotFoundError); fs parameters are query values.
const fsInvalidRequest = (message: string) => invalidRequest(message, "Query")
const fsFileNotFound = fileNotFound

function questionForm(sessionID: string, messageID: string): FormInfo {
  formSequence += 1
  return {
    id: `frm_fixture_${formSequence}`,
    sessionID,
    title: "Questions",
    metadata: { kind: "question", tool: { messageID, id: `call-form-${formSequence}` } },
    fields: [
      { key: "q0", title: "Deploy target", description: "Which environment should receive the deploy?", type: "string", options: [{ value: "Staging", label: "Staging", description: "Deploy to staging first" }, { value: "Production", label: "Production", description: "Ship to production" }], custom: true },
      { key: "q1", title: "Regions", description: "Which regions should be notified?", type: "multiselect", options: [{ value: "EU", label: "EU", description: "Europe" }, { value: "US", label: "US", description: "United States" }], custom: true },
    ],
  }
}

function eventPayload(type: string, data: Json, sessionID?: string): Json {
  const event: Json = { id: `evt_fixture_${++eventSequence}`, created: Date.now(), type, data }
  if (!sessionID) return event
  const owner = sessions.find((item) => item.id === sessionID)
  event.location = (owner?.location as Json | undefined) ?? { directory: root }
  const version = durableVersion(type)
  if (version !== undefined) {
    const seq = (durableSeqs.get(sessionID) ?? 0) + 1
    durableSeqs.set(sessionID, seq)
    event.durable = { aggregateID: sessionID, seq, version }
  }
  return event
}

function broadcast(payload: string) {
  for (const client of clients) client.controller.enqueue(client.encoder.encode(`data: ${payload}\n\n`))
}
// Ephemeral, unscoped events (server.connected, form.*, permission.*).
function emit(type: string, data: Json) { broadcast(JSON.stringify(eventPayload(type, data))) }
// Durable/located events that belong to one session.
function emitSession(type: string, sessionID: string, data: Json) { broadcast(JSON.stringify(eventPayload(type, data, sessionID))) }

function supersede(sessionID: string) {
  const stop = runs.get(sessionID)
  if (!stop) return
  runs.delete(sessionID)
  stop()
}

function sessionMessages(sessionID: string): Json[] {
  const list = messages.get(sessionID)
  if (list) return list
  messages.set(sessionID, [])
  return messages.get(sessionID)!
}

function requireSession(sessionID: string): SessionInfo | undefined {
  return sessions.find((item) => item.id === sessionID)
}

function finishRun(sessionID: string, assistantMessageID: string, reply: string, stop: Stop) {
  if (runs.get(sessionID) !== stop) return
  runs.delete(sessionID)
  sessionMessages(sessionID).push(idleMessage("succeeded"))
  emitSession("session.text.ended", sessionID, { sessionID, assistantMessageID, ordinal: 0, text: reply })
  emitSession("session.step.ended", sessionID, { sessionID, assistantMessageID, finish: "stop", cost: 0, tokens: TOKENS })
  emitSession("session.execution.succeeded", sessionID, { sessionID })
  emitSession("session.status", sessionID, { sessionID, status: { type: "idle" } })
  emitSession("session.idle", sessionID, { sessionID })
}

function streamText(sessionID: string, assistantMessageID: string, reply: string, chunks: string[], intervalMs: number) {
  emitSession("session.text.started", sessionID, { sessionID, assistantMessageID, ordinal: 0 })
  let index = 0
  let timer: ReturnType<typeof setInterval> | undefined
  const stop: Stop = () => { if (timer) clearInterval(timer) }
  runs.set(sessionID, stop)
  timer = setInterval(() => {
    if (runs.get(sessionID) !== stop) { stop(); return }
    emitSession("session.text.delta", sessionID, { sessionID, assistantMessageID, ordinal: 0, delta: chunks[index++] })
    if (index < chunks.length) return
    stop()
    finishRun(sessionID, assistantMessageID, reply, stop)
  }, intervalMs)
}

// A several-KB write input streamed as ~2,000 deltas plus a progress burst —
// the "busy run" shape that used to stall the UI with per-delta store writes
// and mid-run canonical refreshes.
const toolStressPayload = JSON.stringify({
  filePath: "/fixture/workspace/stress.txt",
  content: Array.from({ length: 64 }, (_, index) => `tool stress line ${index + 1}: ${"y".repeat(96)}`).join("\n"),
})
const toolStressChunks = Array.from({ length: 2_000 }, (_, index) => toolStressPayload.slice(index * 4, index * 4 + 4))

function streamToolStress(sessionID: string, assistantMessageID: string) {
  emitSession("session.tool.input.started", sessionID, { sessionID, assistantMessageID, id: "call-tool-stress", name: "write" })
  let deltaIndex = 0
  let timer: ReturnType<typeof setInterval> | undefined
  const stop: Stop = () => { if (timer) clearInterval(timer) }
  runs.set(sessionID, stop)
  timer = setInterval(() => {
    if (runs.get(sessionID) !== stop) { stop(); return }
    for (let burst = 0; burst < 10 && deltaIndex < toolStressChunks.length; burst++) {
      emitSession("session.tool.input.delta", sessionID, { sessionID, assistantMessageID, id: "call-tool-stress", delta: toolStressChunks[deltaIndex++] })
    }
    if (deltaIndex < toolStressChunks.length) return
    stop()
    if (runs.get(sessionID) !== stop) return
    runs.delete(sessionID)
    sessionMessages(sessionID).push(idleMessage("succeeded"))
    emitSession("session.tool.called", sessionID, { sessionID, assistantMessageID, id: "call-tool-stress", input: JSON.parse(toolStressPayload), executed: true })
    for (let index = 0; index < 50; index++) emitSession("session.tool.progress", sessionID, { sessionID, assistantMessageID, id: "call-tool-stress", metadata: { stage: index } })
    emitSession("session.tool.success", sessionID, { sessionID, assistantMessageID, id: "call-tool-stress", content: [{ type: "text", text: `wrote ${toolStressPayload.length} bytes` }], executed: true })
    emitSession("session.step.ended", sessionID, { sessionID, assistantMessageID, finish: "stop", cost: 0, tokens: TOKENS })
    emitSession("session.execution.succeeded", sessionID, { sessionID })
    emitSession("session.status", sessionID, { sessionID, status: { type: "idle" } })
    emitSession("session.idle", sessionID, { sessionID })
  }, 2)
}

function beginRun(sessionID: string, assistantMessageID: string, text: string, isCommand: boolean) {
  // The real server queues prompts while a session is busy; the simulation
  // keeps one run per session and supersedes any in-flight stream instead.
  supersede(sessionID)
  const streamingStressTest = text.toLowerCase() === "fixture:stream-stress"
  const formQuestion = text.toLowerCase() === "fixture:form-question"
  const toolStressTest = text.toLowerCase() === "fixture:tool-stress"
  const permissionRequest = text.toLowerCase() === "fixture:permission"
  const permissionSaveRequest = text.toLowerCase() === "fixture:permission-save"
  const chunks = streamingStressTest
    ? Array.from({ length: 1_200 }, (_, index) => `${index % 12 === 0 ? `\n\n### Stream block ${index / 12 + 1}\n\n` : ""}Responsive streaming fixture text ${index}. \`inline code\` remains readable.\n`)
    : ["Fixture reply"]
  const reply = toolStressTest
    ? `wrote ${toolStressPayload.length} bytes`
    : permissionRequest || permissionSaveRequest
      ? "Waiting for permission approval."
      : streamingStressTest
        ? chunks.join("")
        : isCommand
          ? `Fixture command reply: ${text}`
          : `Fixture reply to: ${text}`

  if (toolStressTest) {
    // The persisted projection of a tool run: the completed write call is the
    // assistant content, exactly like the canonical session page.
    const created = nextMessageTime()
    sessionMessages(sessionID).push({
      type: "assistant",
      id: assistantMessageID,
      agent: "build",
      model: { providerID: "fixture", id: "fixture-model" },
      content: [{ type: "tool", id: "call-tool-stress", name: "write", time: { created, completed: created + 1 }, state: { status: "completed", input: JSON.parse(toolStressPayload), content: [{ type: "text", text: `wrote ${toolStressPayload.length} bytes` }] } }],
      time: { created, completed: created + 1 },
    })
    emitSession("session.execution.started", sessionID, { sessionID })
    emitSession("session.status", sessionID, { sessionID, status: { type: "busy" } })
    emitSession("session.step.started", sessionID, { sessionID, assistantMessageID, agent: "build", model: { providerID: "fixture", id: "fixture-model" }, started: Date.now() })
    streamToolStress(sessionID, assistantMessageID)
    return
  }

  sessionMessages(sessionID).push(assistant(assistantMessageID, reply, nextMessageTime()))

  if (formQuestion) {
    const form = questionForm(sessionID, assistantMessageID)
    forms.push(form)
    emit("form.created", { form })
  }
  if (permissionRequest || permissionSaveRequest) {
    permissionSequence += 1
    const request: PermissionRequest = {
      id: `per_fixture_${permissionSequence}`,
      sessionID,
      action: "shell",
      // fixture:permission-save proves "always" persists `save`, not
      // `resources`: neither command is remembered unless its pattern is
      // proposed for saving.
      resources: permissionSaveRequest ? ["git status", "git log"] : ["git status"],
      save: permissionSaveRequest ? ["git status", "git diff"] : ["git status"],
      message: "Fixture permission request",
      source: { type: "tool", messageID: assistantMessageID, id: `call-permission-${permissionSequence}` },
    }
    permissions.push(request)
    emit("permission.asked", request)
  }

  emitSession("session.execution.started", sessionID, { sessionID })
  emitSession("session.status", sessionID, { sessionID, status: { type: "busy" } })
  emitSession("session.step.started", sessionID, { sessionID, assistantMessageID, agent: "build", model: { providerID: "fixture", id: "fixture-model" }, started: Date.now() })
  streamText(sessionID, assistantMessageID, reply, chunks, streamingStressTest ? 10 : 25)
}

function inboxUser(id: string, sessionID: string, text: string): Json {
  // Session.Inbox.User carries `time: { created }` (Finite millis). The app
  // ignores the echo; the fixture mirrors the documented body.
  return { type: "user", payload: { text }, delivery: "steer", id, sessionID, time: { created: Date.now() } }
}

interface CursorScope { directory?: string; parentID?: string; search?: string; project?: string }
interface PageCursor { o: "asc" | "desc"; i: number; s?: CursorScope }
function encodeCursor(value: PageCursor) { return Buffer.from(JSON.stringify(value)).toString("base64url") }
function decodeCursor(value: string | null): PageCursor | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString()) as PageCursor
    if ((parsed.o === "asc" || parsed.o === "desc") && Number.isInteger(parsed.i) && parsed.i >= 0) return parsed
  } catch {}
  return undefined
}
// Official page shape: items keep the requested order across pages, cursors
// point at the previous/next window, and the cursor carries the query scope so
// following it needs no repeated filters (mirrors the encoded server cursor).
function paginate<T>(items: T[], query: URLSearchParams, defaultLimit: number, scope?: CursorScope): { data: T[]; cursor: Json } {
  const cursor = decodeCursor(query.get("cursor"))
  const order = cursor?.o ?? (query.get("order") === "asc" ? "asc" : "desc")
  const requested = Number(query.get("limit"))
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 200) : defaultLimit
  const ordered = order === "asc" ? items : [...items].reverse()
  const start = cursor?.i ?? 0
  const data = ordered.slice(start, start + limit)
  const cursorOut: Json = {}
  if (start > 0) cursorOut.previous = encodeCursor({ o: order, i: Math.max(0, start - limit), ...(scope ? { s: scope } : {}) })
  if (start + limit < ordered.length) cursorOut.next = encodeCursor({ o: order, i: start + limit, ...(scope ? { s: scope } : {}) })
  return { data, cursor: cursorOut }
}

function sessionOrderKey(item: SessionInfo): number {
  return item.time.updated ?? item.time.created
}

async function handle(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization")
  if (auth !== "Basic " + btoa("opencode:devpassword")) return unauthorized()
  const url = new URL(request.url)
  // Released routes tolerate a trailing slash: /api/session/ is the list and
  // /api/session/:id/ is the single session.
  const path = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname
  if (path === "/health") return json({ healthy: true, version: "2.0.0-fixture", pid: 1 })
  if (path === "/api/info" && request.method === "GET") {
    // server.info: ServerInfo { version, pid, urls, paths: { tmp } }. Replaces
    // the removed beta ServiceHealth probe at /api/health.
    return json({ version: "2.0.0-fixture", pid: process.pid, urls: [new URL(request.url).origin], paths: { tmp: "/tmp" } })
  }
  if (path === "/fixture/status") return json({ ready: true, sessions: sessions.length, permissions: permissions.length, savedPermissions: savedPermissions.length, forms: forms.length, running: [...runs.keys()] })
  if (path === "/fixture/reset" && request.method === "POST") { reset(); emit("server.connected", {}); return json({ reset: true }) }
  // Test hook: mutate server state without emitting SSE events, so clients
  // only learn about the new session through a list refresh. Used to verify
  // that pull-to-refresh picks up sessions created outside the app.
  if (path === "/fixture/silent-session" && request.method === "POST") {
    const input = await body(request)
    const directory = typeof input.directory === "string" ? input.directory : root
    const parentID = typeof input.parentID === "string" ? input.parentID : undefined
    const created = session(`ses_silent_${++sessionSequence}`, (input.title as string) || "Silent session", { parentID, directory, created: now + 400 + sessionSequence, updated: now + 400 + sessionSequence })
    sessions.unshift(created)
    messages.set(created.id, [])
    return json({ data: created })
  }
  if (path === "/fixture/reconnect-silent" && request.method === "POST") {
    // Test hook reproducing the healthy-but-idle SSE reconnect: close every
    // current /api/event stream and arm the one-shot flag so the *next*
    // subscription stays open without the immediate server.connected handshake.
    const closed = clients.size
    for (const client of clients) {
      try { client.controller.close() } catch {}
    }
    clients.clear()
    silentNextConnect = true
    return json({ closed, silentNextConnect: true })
  }
  if (path === "/api/event") {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      const client = { controller, encoder: new TextEncoder() }
      clients.add(client)
      if (!silentNextConnect) {
        controller.enqueue(client.encoder.encode(`data: ${JSON.stringify({ id: `evt_fixture_${++eventSequence}`, created: Date.now(), type: "server.connected", data: {} })}\n\n`))
      }
      silentNextConnect = false
      request.signal.addEventListener("abort", () => { clients.delete(client); try { controller.close() } catch {} })
    }, cancel() {} })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } })
  }
  if (path === "/api/location") return json(publicLocation())
  if (path === "/api/project") return json([{ id: project.id, canonical: root, name: "Fixture project", vcs: "git", time: { created: now, updated: now, active: now }, sandboxes: [] }])
  if (path === "/api/agent") return json({ location: location(), data: agents })
  if (path === "/api/command") return json({ location: location(), data: commands })
  if (path === "/api/model") return json({ location: location(), data: models })
  if (path === "/api/model/default") return json({ location: location(), data: models[0] })
  if (path === "/api/provider") return json({ location: location(), data: [{ ...provider, models: Object.fromEntries(models.map((item) => [item.id, item])) }] })
  if (path === "/api/config") return json([{ type: "document", path: `${root}/opencode.json`, info: { $schema: "https://opencode.ai/config.json", model: "fixture/fixture-model", default_agent: "build" } }])
  if (path === "/api/vcs") return json({ location: location(), data: { branch: { current: "fixture", default: "fixture" } } })
  if (path === "/api/vcs/base") return json({ location: location(), data: null })
  if (path === "/api/vcs/status") return json({ location: location(), data: [] })
  if (path === "/api/vcs/branches") return json({ location: location(), data: ["fixture"] })
  if (path === "/api/vcs/diff") return json({ location: location(), data: [] })
  if (path === "/api/permission/request") return json({ location: location(), data: permissions })
  if (path === "/api/permission/saved" && request.method === "GET") {
    // permission.saved.list: {data} only (no location wrapper) filtered by the
    // optional projectID; without it the released server returns every project.
    const projectID = url.searchParams.get("projectID")
    const data = projectID === null ? savedPermissions : savedPermissions.filter((item) => item.projectID === projectID)
    return json({ data })
  }
  if (path.startsWith("/api/permission/saved/") && request.method === "DELETE") {
    // permission.saved.remove: 204 for any id, including unknown ones, exactly
    // like the released server (removal is idempotent).
    const id = decodeURIComponent(path.slice("/api/permission/saved/".length))
    savedPermissions = savedPermissions.filter((item) => item.id !== id)
    return empty()
  }
  if (path === "/api/form" && request.method === "GET") {
    // form.list: released discovery route with {location: PublicRef, data}.
    const directory = url.searchParams.get("location[directory]") ?? root
    const pending = forms.filter((form) => sessions.find((item) => item.id === form.sessionID)?.location.directory === directory)
    return json({ location: { directory }, data: pending })
  }
  if (path === "/api/session/active") return json({ data: Object.fromEntries([...runs.keys()].map((sessionID) => [sessionID, { type: "running" }])) })
  if (path === "/api/session" && request.method === "GET") {
    const cursorParam = url.searchParams.get("cursor")
    const cursor = decodeCursor(cursorParam)
    if (cursorParam !== null && cursor === undefined) return invalidCursor()
    const orderError = invalidQueryEnum(url.searchParams.get("order"), "order", ["asc", "desc"])
    if (orderError) return orderError
    const limitError = invalidQueryLimit(url.searchParams.get("limit"))
    if (limitError) return limitError
    const directory = cursor?.s?.directory ?? url.searchParams.get("directory")
    const parentID = cursor?.s?.parentID ?? url.searchParams.get("parentID")
    const search = cursor?.s?.search ?? url.searchParams.get("search")
    const projectID = cursor?.s?.project ?? url.searchParams.get("project")
    // Real server semantics: directory scopes the list by exact
    // location.directory match (a parent dir does not include child-dir sessions).
    let filtered = [...sessions]
    if (directory !== null) filtered = filtered.filter((item) => item.location.directory === directory)
    if (projectID !== null) filtered = filtered.filter((item) => item.projectID === projectID)
    if (search) filtered = filtered.filter((item) => (item.title ?? "").toLowerCase().includes(search.toLowerCase()))
    if (parentID !== null) {
      filtered = parentID === "" || parentID === "null"
        ? filtered.filter((item) => !item.parentID)
        : filtered.filter((item) => item.parentID === parentID)
    }
    filtered.sort((a, b) => sessionOrderKey(a) - sessionOrderKey(b) || a.id.localeCompare(b.id))
    const scope: CursorScope = {}
    if (directory !== null) scope.directory = directory
    if (parentID !== null) scope.parentID = parentID
    if (search) scope.search = search
    if (projectID !== null) scope.project = projectID
    const page = paginate(filtered, url.searchParams, 50, scope)
    return json({ data: page.data, cursor: page.cursor })
  }
  if (path === "/api/session" && request.method === "POST") {
    const input = await body(request)
    if (input.title !== undefined && input.title !== null && typeof input.title !== "string") return invalidRequest('Expected string | null\n  at ["title"]', "Payload")
    const inputLocation = input.location as Json | undefined
    const directory = typeof inputLocation?.directory === "string" ? inputLocation.directory : root
    const created = session(typeof input.id === "string" ? input.id : `ses_created_${++sessionSequence}`, (input.title as string) || "Fixture session", {
      directory,
      created: now + 1_000 + ++sessionSequence,
      agent: typeof input.agent === "string" ? input.agent : undefined,
      model: input.model as SessionInfo["model"],
    })
    sessions.unshift(created)
    messages.set(created.id, [])
    emitSession("session.created", created.id, { sessionID: created.id, projectID: project.id, location: created.location, slug: created.id, title: created.title, agent: created.agent, model: created.model, version: "2" })
    return json({ data: created })
  }
  if (path === "/api/fs/list" && request.method === "GET") {
    const locationDirectory = normalizeSyntheticPath(url.searchParams.get("location[directory]") ?? root) ?? root
    const locationNode = syntheticNodeAt(locationDirectory)
    if (!locationNode || locationNode.type !== "directory") return fsInvalidRequest(`Unknown location directory: ${locationDirectory}`)
    const target = resolveSyntheticPath(locationDirectory, url.searchParams.get("path"))
    const node = target ? syntheticNodeAt(target) : undefined
    if (!target || !node) return fsInvalidRequest(`Unknown directory: ${url.searchParams.get("path") ?? "."}`)
    if (node.type !== "directory") return fsInvalidRequest(`Not a directory: ${target}`)
    return json({ location: { directory: locationDirectory }, data: syntheticDirectoryEntries(locationDirectory, target) })
  }
  if (path === "/api/fs/find" && request.method === "GET") {
    const locationDirectory = normalizeSyntheticPath(url.searchParams.get("location[directory]") ?? root) ?? root
    const locationNode = syntheticNodeAt(locationDirectory)
    if (!locationNode || locationNode.type !== "directory") return fsInvalidRequest(`Unknown location directory: ${locationDirectory}`)
    const query = url.searchParams.get("query")
    if (query === null) return fsInvalidRequest('Missing key\n  at ["query"]')
    const type = url.searchParams.get("type")
    if (type !== null && type !== "file" && type !== "directory") return fsInvalidRequest('Expected "file" | "directory"\n  at ["type"]')
    const limitParam = url.searchParams.get("limit")
    let limit = 50
    if (limitParam !== null) {
      const parsed = Number(limitParam)
      if (!Number.isInteger(parsed)) return fsInvalidRequest('Expected an integer\n  at ["limit"]')
      if (parsed <= 0) return fsInvalidRequest('Expected a value greater than 0\n  at ["limit"]')
      limit = parsed
    }
    const needle = query.trim().toLowerCase()
    const matches = syntheticEntriesUnder(locationDirectory, locationDirectory)
      .map((entry) => ({ entry, score: syntheticFindScore(entry.path, needle) }))
      .filter((item) => item.score >= 0 && (type === null || item.entry.type === type))
      .sort((a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path))
      .slice(0, limit)
      .map((item) => item.entry)
    return json({ location: { directory: locationDirectory }, data: matches })
  }
  if (path.startsWith("/api/fs/read/")) {
    const locationDirectory = normalizeSyntheticPath(url.searchParams.get("location[directory]") ?? root) ?? root
    const rawPath = decodePathSuffix(path.slice("/api/fs/read/".length))
    const target = resolveSyntheticPath(locationDirectory, rawPath)
    const node = target ? syntheticNodeAt(target) : undefined
    // Reads stay inside the requested location, like the released server.
    const contained = target !== undefined && (locationDirectory === "/" || target === locationDirectory || target.startsWith(`${locationDirectory}/`))
    if (!node || node.type !== "file" || !contained) return fsFileNotFound(rawPath)
    return new Response(node.content, { headers: { "content-type": node.mime, "cache-control": "no-store" } })
  }
  if (path.startsWith("/api/session/")) return sessionRoute(request, path, url)
  return routeNotFound()
}

async function sessionRoute(request: Request, path: string, url: URL): Promise<Response> {
  const sid = sessionIDFromPath(path)
  // Released path params are branded: a non-ses id fails before any lookup.
  if (!sid.startsWith("ses")) return invalidRequest('Expected a string starting with "ses"\n  at ["sessionID"]', "Params")
  const current = requireSession(sid)
  if (!current) return sessionNotFound(sid)
  const rest = path.slice(`/api/session/${encodeURIComponent(sid)}`.length)
  if (rest === "" && request.method === "GET") return json({ data: current })
  if (rest === "" && request.method === "DELETE") {
    const descendants = sessions.filter((item) => item.parentID === sid).map((item) => item.id)
    for (const id of [sid, ...descendants]) {
      supersede(id)
      emitSession("session.deleted", id, { sessionID: id })
      sessions = sessions.filter((item) => item.id !== id)
      messages.delete(id)
      permissions = permissions.filter((item) => item.sessionID !== id)
      forms = forms.filter((item) => item.sessionID !== id)
    }
    return empty()
  }
  if (rest === "" && request.method === "PATCH") {
    // session.update: PATCH /api/session/:id {title} -> 204. Released fields
    // are optional; only a wrong type is an InvalidRequestError.
    const input = await body(request)
    if (input.title !== undefined && input.title !== null && typeof input.title !== "string") return invalidRequest('Expected string | null\n  at ["title"]', "Payload")
    if (typeof input.title === "string") {
      current.title = input.title
      emitSession("session.renamed", sid, { sessionID: sid, title: input.title })
    }
    return empty()
  }
  if (rest === "/message" && request.method === "GET") {
    const cursorParam = url.searchParams.get("cursor")
    if (cursorParam !== null && decodeCursor(cursorParam) === undefined) return invalidCursor()
    const orderError = invalidQueryEnum(url.searchParams.get("order"), "order", ["asc", "desc"])
    if (orderError) return orderError
    const limitError = invalidQueryLimit(url.searchParams.get("limit"), "Expected a value greater than or equal to 1")
    if (limitError) return limitError
    const page = paginate(sessionMessages(sid), url.searchParams, 50)
    return json({ data: page.data, cursor: page.cursor })
  }
  if (rest === "/agent") {
    const input = await body(request)
    const agentError = requireString(input, "agent")
    if (agentError) return agentError
    current.agent = input.agent as string
    emitSession("session.agent.selected", sid, { sessionID: sid, agent: current.agent })
    return empty()
  }
  if (rest === "/model") {
    const input = await body(request)
    const model = input.model
    if (model === undefined) return invalidRequest('Missing key\n  at ["model"]', "Payload")
    if (!model || typeof model !== "object" || Array.isArray(model)) return invalidRequest('Expected Model.Ref\n  at ["model"]', "Payload")
    current.model = model as SessionInfo["model"]
    emitSession("session.model.selected", sid, { sessionID: sid, model: current.model })
    return empty()
  }
  if (rest === "/interrupt") {
    // session.interrupt declares ?resume=; an invalid enum value is an
    // InvalidRequestError on the wire. The route has no body.
    const resumeError = invalidQueryEnum(url.searchParams.get("resume"), "resume", ["true", "false"])
    if (resumeError) return resumeError
    const stop = runs.get(sid)
    if (!stop) return json({ interrupted: false })
    runs.delete(sid)
    stop()
    // A cancelled run still settles: the released server finalizes the turn
    // with the canonical idle marker (outcome "interrupted").
    sessionMessages(sid).push(idleMessage("interrupted"))
    emitSession("session.execution.interrupted", sid, { sessionID: sid, reason: "user" })
    emitSession("session.status", sid, { sessionID: sid, status: { type: "idle" } })
    emitSession("session.idle", sid, { sessionID: sid })
    return json({ interrupted: true })
  }
  if (rest === "/prompt" || rest === "/command") {
    const isCommand = rest === "/command"
    const input = await body(request)
    if (isCommand) {
      // session.command requires {name, text} and a registered command name.
      const nameError = requireString(input, "name")
      if (nameError) return nameError
      const textError = requireString(input, "text")
      if (textError) return textError
      if (!commands.some((command) => command.name === input.name)) return commandNotFound(input.name as string)
    } else {
      const textError = requireString(input, "text")
      if (textError) return textError
    }
    const text = isCommand
      ? `/${input.name as string}${input.text ? ` ${input.text as string}` : ""}`.trim()
      : input.text as string
    const sequence = ++messageSequence
    const assistantID = `msg_fixture_assistant_${sequence}`
    const messageID = `msg_fixture_user_${sequence}`
    sessionMessages(sid).push(user(messageID, sid, text, nextMessageTime()))
    beginRun(sid, assistantID, text, isCommand)
    if (isCommand) return empty()
    return json({ data: inboxUser(messageID, sid, text) })
  }
  if (rest === "/revert/stage") {
    const input = await body(request)
    const messageIDError = requireString(input, "messageID")
    if (messageIDError) return messageIDError
    const messageID = input.messageID as string
    if (!sessionMessages(sid).some((item) => item.id === messageID)) return messageNotFound(sid, messageID)
    current.revert = { messageID }
    emitSession("session.revert.staged", sid, { sessionID: sid, revert: { messageID } })
    return json({ data: { messageID } })
  }
  if (rest === "/revert" && request.method === "DELETE") {
    // session.revert.clear: DELETE /api/session/:id/revert -> 204.
    delete current.revert
    emitSession("session.revert.cleared", sid, { sessionID: sid })
    return empty()
  }
  if (rest === "/revert/commit") {
    const revert = current.revert as { messageID?: string } | undefined
    if (revert?.messageID) {
      const list = sessionMessages(sid)
      const index = list.findIndex((item) => item.id === revert.messageID)
      if (index >= 0) messages.set(sid, list.slice(0, index))
      delete current.revert
      emitSession("session.revert.committed", sid, { sessionID: sid, to: revert.messageID })
    }
    return empty()
  }
  if (rest.startsWith("/permission/") && rest.endsWith("/reply")) {
    const requestID = rest.split("/")[2]
    // session.permission.reply sends {decision}; released decoding runs before
    // the request lookup, so a missing/invalid decision is a 400 even when the
    // request id is unknown.
    const input = await body(request)
    const decisionError = requireString(input, "decision")
    if (decisionError) return decisionError
    const decision = input.decision as string
    if (decision !== "once" && decision !== "always" && decision !== "reject") return invalidRequest('Expected Permission.Reply\n  at ["decision"]', "Payload")
    const permissionRequest = permissions.find((item) => item.id === requestID)
    if (!permissionRequest) return permissionNotFound(requestID)
    if (decision === "always") persistSavedPermissions(current.projectID, permissionRequest)
    permissions = permissions.filter((item) => item.id !== requestID)
    emitSession("permission.replied", sid, { sessionID: sid, requestID, reply: decision })
    return empty()
  }
  if (rest === "/form" && request.method === "GET") return json({ data: forms.filter((item) => item.sessionID === sid) })
  if (rest.startsWith("/form/") && rest.endsWith("/reply")) {
    const [, , formID] = rest.split("/")
    const input = await body(request)
    if (input.answer === undefined) return invalidRequest('Missing key\n  at ["answer"]', "Payload")
    if (!input.answer || typeof input.answer !== "object" || Array.isArray(input.answer)) return invalidRequest('Expected Form.Answer\n  at ["answer"]', "Payload")
    if (!forms.some((item) => item.id === formID)) return formNotFound(formID)
    forms = forms.filter((item) => item.id !== formID)
    emitSession("form.replied", sid, { id: formID, sessionID: sid, answer: input.answer })
    return empty()
  }
  if (request.method === "DELETE" && rest.startsWith("/form/")) {
    // session.form.cancel: DELETE /api/session/:id/form/:formID -> 204.
    const formID = decodeURIComponent(rest.slice("/form/".length))
    if (formID.includes("/") || !forms.some((item) => item.id === formID)) return formNotFound(formID)
    forms = forms.filter((item) => item.id !== formID)
    emitSession("form.cancelled", sid, { id: formID, sessionID: sid })
    return empty()
  }
  return routeNotFound()
}

// Idle SSE subscriptions must remain open between events. Bun's default
// 10-second idle timeout otherwise disconnects every emulator client and can
// drop fixture events during the reconnect window.
Bun.serve({ port, hostname, idleTimeout: 0, fetch: serve })
console.log(`OpenCode v2 fixture ready at http://${hostname}:${port} (released contract, opencode/devpassword)`)
