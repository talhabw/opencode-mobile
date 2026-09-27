import type {
  AgentInfo,
  CommandInfo,
  EventSubscribeOutput,
  ModelInfo,
  Project as V2Project,
  ProjectCurrent,
  ProviderInfo,
  SessionInfo,
  SessionMessageInfo,
} from "@opencode-ai/client"
import { inlineFileUri } from "./session-request.ts"

export interface Session {
  id: string
  slug: string
  projectID: string
  directory: string
  parentID?: string | null
  title: string
  version: string
  share?: { url: string }
  time: { created: number; updated: number; compacting?: number; archived?: number }
  summary?: { additions: number; deletions: number; files: number }
  revert?: { messageID: string; partID?: string }
  agent?: string
  model?: { providerID: string; modelID: string; variant?: string }
  location?: { directory: string; workspaceID?: string }
}

export interface Message {
  id: string
  sessionID: string
  role: "user" | "assistant"
  presentation: "user" | "assistant" | "shell" | "system" | "subagent"
  systemKind?: "agent" | "model" | "location" | "compaction" | "synthetic" | "skill" | "system"
  parentID?: string
  time: { created: number; completed?: number }
  agent?: string
  model?: { providerID: string; modelID: string }
  modelID?: string
  providerID?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning?: number; cache?: { read: number; write: number } }
  error?: { message: string }
  finish?: string
  shell?: ShellMessage
  subagent?: SubagentMessage
}

export interface ShellMessage {
  id: string
  shellID: string
  command: string
  status: "running" | "exited" | "timeout" | "killed" | "completed" | "error" | "cancelled"
  exit?: number | "Infinity" | "-Infinity" | "NaN"
  output?: { output: string; cursor: number; size: number; truncated: boolean }
  time: { created: number; completed?: number }
}

export interface SubagentMessage {
  id: string
  refID: string
  state: SyntheticTagState
  description?: string
  result?: string
  time: { created: number }
}

export interface Part {
  id: string
  sessionID?: string
  messageID: string
  type: string
  text?: string
  tool?: string
  callID?: string
  state?: {
    status: "pending" | "running" | "completed" | "error"
    input?: unknown
    output?: unknown
    title?: string
    error?: { message: string }
    metadata?: Record<string, unknown>
    time?: { start?: number; end?: number }
  }
  time?: { start?: number; end?: number }
  mime?: string
  url?: string
  filename?: string
}

export interface MessageWithParts {
  info: Message
  parts: Part[]
}

export interface Event {
  type: string
  properties: Record<string, unknown>
}

export interface Agent {
  // Canonical id used for wire selection (AgentInfo.id). Custom ids are
  // preserved exactly; built-ins keep their lowercase ids ("build").
  name: string
  // Human-readable label (AgentInfo.name, e.g. "Build") for display only.
  label?: string
  description?: string
  mode: "subagent" | "primary" | "all"
  hidden?: boolean
  color?: string
  model?: { modelID: string; providerID: string }
  options: Record<string, unknown>
  steps?: number
}

export interface Command {
  name: string
  description?: string
}

export interface Project {
  id: string
  name?: string
  path: { cwd: string; root: string; absolute: string }
}

export interface FileEntry {
  name: string
  path: string
  absolute: string
  type: "file" | "directory"
  ignored: boolean
}

export interface ProviderCatalog {
  all: Array<{
    id: string
    name: string
    models: Record<string, {
      id: string
      name: string
      attachment: boolean
      reasoning: boolean
      tool_call: boolean
      cost?: { input: number; output: number }
      limit: { context: number; output: number }
      status?: "alpha" | "beta" | "deprecated" | "active"
      variants?: Record<string, { reasoningEffort?: string }>
    }>
  }>
  default: Record<string, string>
  connected: string[]
}

export const V2_REQUIRED_ERROR = "OpenCode v2 server required"

export function isV2HealthResponse(value: unknown): value is { healthy: boolean; version: string } {
  if (!value || typeof value !== "object") return false
  const health = value as { healthy?: unknown; version?: unknown }
  return typeof health.healthy === "boolean" && typeof health.version === "string" && health.version.length > 0
}

export function v2HealthError(value: unknown): Error {
  if (value && typeof value === "object" && "status" in value && (value as { status?: unknown }).status === 404) {
    return new Error(V2_REQUIRED_ERROR)
  }
  return new Error(V2_REQUIRED_ERROR)
}

export type SyntheticTagState = "completed" | "error" | "cancelled"

export type SyntheticTag =
  | { kind: "shell"; id: string; state: SyntheticTagState; command: string; content?: string }
  | { kind: "subagent"; id: string; state: SyntheticTagState; description?: string; content?: string }

const SYNTHETIC_TAG_STATES: readonly SyntheticTagState[] = ["completed", "error", "cancelled"]

// Only the two documented synthetic marker shapes are recognized; anything
// else (including other XML-ish text) falls back to the plain system row.
// The server emits `<shell ...>\n${output}\n</shell>` and
// `<subagent ...>\n${result}\n</subagent>`, so a matching closing tag with
// content between it and the opening tag is part of the documented shape.
export function parseSyntheticTag(text: string): SyntheticTag | undefined {
  if (typeof text !== "string") return undefined
  const match = /^<(shell|subagent)(\s[^<>]*)?\s*>(?:\n?([\s\S]*?)\n?<\/\1>)?$/u.exec(text.trim())
  if (!match) return undefined
  const kind = match[1] as "shell" | "subagent"
  const attrs = new Map<string, string>()
  for (const attr of (match[2] ?? "").matchAll(/([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
    attrs.set(attr[1], attr[2] ?? attr[3] ?? "")
  }
  const id = attrs.get("id")
  const state = attrs.get("state")
  if (!id || !state || !SYNTHETIC_TAG_STATES.includes(state as SyntheticTagState)) return undefined
  const content = match[3]?.trim()
  const withContent = content ? { content } : {}
  if (kind === "shell") return { kind, id, state: state as SyntheticTagState, command: attrs.get("command") ?? "", ...withContent }
  const description = attrs.get("description")
  return { kind, id, state: state as SyntheticTagState, ...(description ? { description } : {}), ...withContent }
}

export function normalizeSession(value: SessionInfo): Session {
  return {
    id: value.id,
    slug: value.id,
    projectID: value.projectID,
    directory: value.location.directory,
    parentID: value.parentID,
    title: value.title ?? "",
    version: "2",
    time: value.time,
    revert: value.revert && { messageID: value.revert.messageID, partID: value.revert.partID },
    agent: value.agent,
    model: value.model && { providerID: value.model.providerID, modelID: value.model.id, variant: value.model.variant },
    location: value.location,
  }
}

function baseMessage(value: SessionMessageInfo, sessionID: string): Message {
  const time = "time" in value ? value.time : { created: 0 }
  if (value.type === "user") return { id: value.id, sessionID, role: "user", presentation: "user", time }
  if (value.type === "assistant") {
    return {
      id: value.id,
      sessionID,
      role: "assistant",
      presentation: "assistant",
      time: value.time,
      agent: value.agent,
      modelID: value.model.id,
      providerID: value.model.providerID,
      cost: value.cost,
      tokens: value.tokens,
      error: value.error && { message: value.error.message },
      finish: value.finish,
    }
  }
  if (value.type === "shell") {
    return {
      id: value.id,
      sessionID,
      role: "assistant",
      presentation: "shell",
      time: value.time,
      shell: {
        id: value.id,
        shellID: value.shellID,
        command: value.command,
        status: value.status,
        ...(value.exit !== undefined ? { exit: value.exit } : {}),
        ...(value.output !== undefined ? { output: value.output } : {}),
        time: value.time,
      },
    }
  }
  if (value.type === "synthetic") {
    const tag = parseSyntheticTag(value.text)
    if (tag?.kind === "shell") {
      // Shell-tool completion marker: the tag id is the tool-call id, and the
      // tag state is preserved verbatim so the visible label stays truthful.
      return {
        id: value.id,
        sessionID,
        role: "assistant",
        presentation: "shell",
        time: value.time,
        shell: {
          id: value.id,
          shellID: tag.id,
          command: tag.command,
          status: tag.state,
          ...(tag.content ? { output: { output: tag.content, cursor: tag.content.length, size: tag.content.length, truncated: false } } : {}),
          time: value.time,
        },
      }
    }
    if (tag?.kind === "subagent") {
      const description = tag.description ?? value.description
      return {
        id: value.id,
        sessionID,
        role: "assistant",
        presentation: "subagent",
        time: value.time,
        subagent: {
          id: value.id,
          refID: tag.id,
          state: tag.state,
          ...(description ? { description } : {}),
          ...(tag.content ? { result: tag.content } : {}),
          time: value.time,
        },
      }
    }
  }
  const systemKind = value.type === "agent-switched"
    ? "agent"
    : value.type === "model-switched"
      ? "model"
      : value.type === "location-switched"
        ? "location"
        : value.type === "compaction"
          ? "compaction"
          : value.type
  return { id: value.id, sessionID, role: "assistant", presentation: "system", systemKind, time }
}

function isTextContent(item: unknown): item is { type: "text"; text: string } {
  return Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string")
}

function isFileContent(item: unknown): item is { type: "file"; uri: string; mime?: string; name?: string } {
  return Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "file")
}

function fileMarker(file: { uri: string; mime?: string; name?: string }): string {
  const label = file.name || file.uri
  return `[file: ${label}${file.mime ? ` (${file.mime})` : ""}]`
}

function contentOutput(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  const lines: string[] = []
  for (const item of content) {
    if (isTextContent(item)) {
      lines.push(item.text.replace(/\s+$/u, ""))
    } else if (isFileContent(item)) {
      lines.push(fileMarker(item))
    } else {
      lines.push(typeof item === "string" ? item : JSON.stringify(item))
    }
  }
  return lines.join("\n").replace(/\s+$/u, "")
}

export function normalizeMessage(value: SessionMessageInfo, sessionID: string): MessageWithParts {
  if (!value || typeof value !== "object") {
    return { info: { id: "unknown", sessionID, role: "assistant", presentation: "system", systemKind: "system", time: { created: 0 } }, parts: [] }
  }
  const info = baseMessage(value, sessionID)
  const parts: Part[] = []
  if (value.type === "user") {
    if (value.text) parts.push({ id: `${value.id}:text`, sessionID, messageID: value.id, type: "text", text: value.text })
    for (const [index, file] of (value.files ?? []).entries()) {
      parts.push({
        id: `${value.id}:file:${index}`,
        sessionID,
        messageID: value.id,
        type: "file",
        mime: file.mime,
        url: file.source.type === "uri" ? file.source.uri : inlineFileUri(file),
        filename: file.name,
      })
    }
  } else if (value.type === "assistant") {
    value.content.forEach((content, index) => {
      const id = `${value.id}:${content.type}:${"id" in content ? content.id : index}`
      if (content.type === "text" || content.type === "reasoning") {
        parts.push({ id, sessionID, messageID: value.id, type: content.type, text: content.text })
        return
      }
      const state = content.state
      const status = state.status === "streaming" ? "pending" : state.status
      parts.push({
        id,
        sessionID,
        messageID: value.id,
        type: "tool",
        tool: content.name,
        callID: content.id,
        state: {
          status,
          input: state.input,
          output: state.status === "completed" || state.status === "error" ? contentOutput(state.content) : undefined,
          error: state.status === "error" ? { message: state.error.message } : undefined,
          metadata: "metadata" in state ? state.metadata : undefined,
          time: { start: content.time.ran ?? content.time.created, end: content.time.completed },
        },
      })
    })
  } else if (value.type === "shell") {
    // Shell messages are protocol records, not assistant prose or tool calls.
    // Their structured fields are retained on info.shell for a dedicated row.
  } else if (info.presentation === "shell" || info.presentation === "subagent") {
    // Structured synthetic markers render from their payload, never raw tag text.
  } else {
    const text = "text" in value && typeof value.text === "string"
      ? value.text
      : value.type === "agent-switched"
        ? `Agent switched to ${value.agent}`
        : value.type === "model-switched"
          ? `Model switched to ${value.model.providerID}/${value.model.id}`
          : value.type === "location-switched"
            ? `Location switched to ${value.location.directory}`
            : value.type === "compaction"
              ? `Compaction ${value.status}${"summary" in value ? `: ${value.summary}` : ""}`
              : undefined
    if (text) parts.push({ id: `${value.id}:${value.type}`, sessionID, messageID: value.id, type: "text", text })
  }
  return { info, parts }
}

export function normalizeAgent(value: AgentInfo): Agent {
  return {
    // The server selects agents by id — never the display name. Built-ins
    // like { id: "build", name: "Build" } and custom agents whose id differs
    // from their label both round-trip exactly.
    name: value.id,
    label: value.name,
    description: value.description,
    mode: value.mode,
    hidden: value.hidden,
    color: value.color,
    model: value.model && { modelID: value.model.id, providerID: value.model.providerID },
    options: {},
    steps: value.steps,
  }
}

export function normalizeCommand(value: CommandInfo): Command {
  return {
    name: value.name,
    description: value.description,
  }
}

export function normalizeProject(value: V2Project | ProjectCurrent): Project {
  const directory = "directory" in value ? value.directory : value.canonical
  return { id: value.id, name: "name" in value ? value.name : undefined, path: { cwd: directory, root: directory, absolute: directory } }
}

export function normalizeProviderCatalog(providers: ProviderInfo[], models: ModelInfo[], defaultModel: ModelInfo | null): ProviderCatalog {
  const byProvider = new Map<string, ModelInfo[]>()
  for (const model of models) byProvider.set(model.providerID, [...(byProvider.get(model.providerID) ?? []), model])
  return {
    all: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: Object.fromEntries((byProvider.get(provider.id) ?? []).map((model) => [model.id, {
        id: model.id,
        name: model.name,
        attachment: model.capabilities.input.some((type) => type !== "text"),
        reasoning: model.capabilities.output.includes("reasoning"),
        tool_call: model.capabilities.tools,
        cost: model.cost[0] && { input: model.cost[0].input, output: model.cost[0].output },
        limit: model.limit,
        status: model.status,
        variants: Object.fromEntries(model.variants.map((variant) => [variant.id, {}])),
      }])),
    })),
    default: defaultModel ? { [defaultModel.providerID]: defaultModel.id } : {},
    connected: providers.filter((provider) => provider.activation !== "disabled").map((provider) => provider.id),
  }
}

export function normalizeEvent(value: EventSubscribeOutput | unknown): Event {
  if (!value || typeof value !== "object") return { type: "unknown", properties: { value } }
  const raw = value as { type?: unknown; data?: unknown }
  const type = typeof raw.type === "string" ? raw.type : "unknown"
  const data = raw.data && typeof raw.data === "object" ? raw.data as Record<string, unknown> : {}
  if (type === "session.execution.started") return { type: "session.status", properties: { sessionID: data.sessionID, status: { type: "busy" } } }
  if (type === "session.execution.succeeded" || type === "session.execution.interrupted" || type === "session.idle") {
    return { type: "session.status", properties: { sessionID: data.sessionID, status: { type: "idle" }, canonicalRefresh: true } }
  }
  if (type === "session.execution.failed") return { type: "session.error", properties: data }
  // Live shell lifecycle events are NOT mapped to message.updated: they carry
  // the shell id while the persisted row is keyed by a separate message id
  // (see src/lib/protocol-v2.ts baseMessage), so a live row could never be
  // reconciled with the canonical session page and would linger after a
  // refresh as a duplicate. Rendering comes from the canonical page refresh,
  // which remains authoritative; only the terminal ended event requests that
  // refresh (see docs/REQUESTS-IMPLEMENTATION-STATUS.md).
  if (type === "session.shell.ended") {
    return { type, properties: { ...data, canonicalRefresh: true } }
  }
  if (type === "permission.asked") {
    return { type, properties: { ...data, permission: data.action, patterns: data.resources, tool: normalizeTool(data.source) } }
  }
  if (type === "session.created") {
    const location = data.location as { directory?: string; workspaceID?: string } | undefined
    const model = data.model as { providerID?: unknown; id?: unknown; variant?: unknown } | undefined
    const created = eventTime(value)
    return {
      type,
      properties: {
        info: {
          id: String(data.sessionID ?? ""), slug: String(data.slug ?? data.sessionID ?? ""),
          projectID: String(data.projectID ?? ""), directory: location?.directory ?? "", location, title: String(data.title ?? ""),
          parentID: typeof data.parentID === "string" || data.parentID === null ? data.parentID : undefined,
          agent: typeof data.agent === "string" ? data.agent : undefined,
          model: model && typeof model.providerID === "string" && typeof model.id === "string"
            ? { providerID: model.providerID, modelID: model.id, ...(typeof model.variant === "string" ? { variant: model.variant } : {}) }
            : undefined,
          version: String(data.version ?? "2"), time: { created, updated: created },
        },
      },
    }
  }
  return { type, properties: data }
}

interface ToolState {
  tool?: string
  rawInput: string
  input?: unknown
  metadata?: Record<string, unknown>
}

function toolKey(sessionID: string, messageID: string, callID: string): string {
  return `${sessionID}\u0000${messageID}\u0000${callID}`
}

export class V2EventAdapter {
  private readonly text = new Map<string, string>()
  private readonly tools = new Map<string, ToolState>()

  push(value: EventSubscribeOutput | unknown): Event[] {
    const event = normalizeEvent(value)
    if (!value || typeof value !== "object") return [event]
    const raw = value as { type?: unknown; data?: unknown; created?: unknown }
    if (typeof raw.type !== "string" || !raw.data || typeof raw.data !== "object") return [event]
    const data = raw.data as Record<string, unknown>
    const sessionID = stringValue(data.sessionID)
    const messageID = stringValue(data.assistantMessageID)

    if (raw.type === "session.execution.failed" && sessionID) {
      return [event, {
        type: "session.status",
        properties: { sessionID, status: { type: "idle" }, canonicalRefresh: true },
      }]
    }

    if (raw.type === "session.step.started" && sessionID && messageID) {
      const model = data.model as { id?: unknown; providerID?: unknown } | undefined
      return [{
        type: "message.updated",
        properties: {
          info: {
            id: messageID,
            sessionID,
            role: "assistant",
            presentation: "assistant",
            time: { created: numberValue(raw.created) },
            agent: stringValue(data.agent),
            modelID: stringValue(model?.id),
            providerID: stringValue(model?.providerID),
          } satisfies Message,
        },
      }]
    }

    const kind = raw.type.startsWith("session.text.") ? "text" : raw.type.startsWith("session.reasoning.") ? "reasoning" : undefined
    if (kind && sessionID && messageID) {
      const ordinal = numberValue(data.ordinal)
      const key = `${messageID}:${kind}:${ordinal}`
      if (raw.type.endsWith(".started")) this.text.set(key, "")
      if (raw.type.endsWith(".delta")) this.text.set(key, (this.text.get(key) ?? "") + stringValue(data.delta))
      if (raw.type.endsWith(".ended")) this.text.set(key, stringValue(data.text))
      return [{
        type: "message.part.updated",
        properties: {
          canonicalRefresh: raw.type.endsWith(".ended"),
          part: {
            id: key,
            sessionID,
            messageID,
            type: kind,
            text: this.text.get(key) ?? "",
          } satisfies Part,
        },
      }]
    }

    if (raw.type === "session.tool.input.started" && sessionID && messageID) {
      const callID = stringValue(data.id)
      const state: ToolState = { tool: stringValue(data.name), rawInput: "", input: "", metadata: recordValue(data.metadata) }
      this.tools.set(toolKey(sessionID, messageID, callID), state)
      return [toolEvent(sessionID, messageID, callID, state.tool, "pending", state.input, undefined, undefined, state.metadata, true)]
    }
    if (raw.type === "session.tool.input.delta" && sessionID && messageID) {
      const callID = stringValue(data.id)
      const key = toolKey(sessionID, messageID, callID)
      const previous = this.tools.get(key) ?? { rawInput: "" }
      // Deltas only accumulate the raw JSON text. Parsing the whole buffer on
      // every delta is quadratic for large write/edit inputs, and the parsed
      // value is delivered anyway by session.tool.called — the streamed text
      // stays visible as-is in the meantime (same as partial-JSON chunks).
      const rawInput = `${previous.rawInput}${stringValue(data.delta)}`
      const metadata = mergeMetadata(previous.metadata, data.metadata)
      this.tools.set(key, { ...previous, rawInput, input: rawInput, metadata })
      return [toolEvent(sessionID, messageID, callID, previous.tool, "pending", rawInput, undefined, undefined, metadata, false)]
    }
    if (raw.type === "session.tool.called" && sessionID && messageID) {
      const callID = stringValue(data.id)
      const key = toolKey(sessionID, messageID, callID)
      const previous = this.tools.get(key) ?? { rawInput: "" }
      const state: ToolState = {
        tool: previous.tool ?? stringValue(data.name),
        rawInput: previous.rawInput,
        // The server normally sends the parsed input here; fall back to
        // parsing the accumulated raw stream only when it does not.
        input: data.input ?? parsedToolInput(previous.rawInput) ?? previous.input,
        metadata: mergeMetadata(previous.metadata, data.metadata),
      }
      this.tools.set(key, state)
      return [toolEvent(sessionID, messageID, callID, state.tool, "running", state.input, undefined, undefined, state.metadata, true)]
    }
    if (raw.type === "session.tool.progress" && sessionID && messageID) {
      const callID = stringValue(data.id)
      const key = toolKey(sessionID, messageID, callID)
      const state = this.tools.get(key) ?? { rawInput: "" }
      const metadata = mergeMetadata(state.metadata, data.metadata)
      this.tools.set(key, { ...state, metadata })
      return [toolEvent(sessionID, messageID, callID, state.tool, "running", state.input, undefined, undefined, metadata, false)]
    }
    if ((raw.type === "session.tool.success" || raw.type === "session.tool.failed") && sessionID && messageID) {
      const failed = raw.type.endsWith("failed")
      const error = data.error as { message?: unknown } | undefined
      const callID = stringValue(data.id)
      const key = toolKey(sessionID, messageID, callID)
      const state = this.tools.get(key)
      const events = [toolEvent(
        sessionID,
        messageID,
        callID,
        state?.tool,
        failed ? "error" : "completed",
        // Terminal fallback only: one parse per call when the server skipped
        // session.tool.called — never per delta.
        state === undefined ? undefined : parsedToolInput(state.rawInput) ?? state.input,
        contentOutput(data.content),
        failed ? stringValue(error?.message) : undefined,
        mergeMetadata(state?.metadata, data.metadata),
        true,
      )]
      this.tools.delete(key)
      return events
    }
    return [event]
  }
}

function toolEvent(
  sessionID: string,
  messageID: string,
  callID: string,
  tool: string | undefined,
  status: "pending" | "running" | "completed" | "error",
  input?: unknown,
  output?: unknown,
  error?: string,
  metadata?: Record<string, unknown>,
  canonicalRefresh = false,
): Event {
  return {
    type: "message.part.updated",
    properties: {
      canonicalRefresh,
      part: {
        id: `${messageID}:tool:${callID}`,
        sessionID,
        messageID,
        type: "tool",
        tool,
        callID,
        state: { status, input, output, error: error ? { message: error } : undefined, metadata },
      } satisfies Part,
    },
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function parsedToolInput(rawInput: string): unknown {
  try {
    return JSON.parse(rawInput)
  } catch {
    return undefined
  }
}

function mergeMetadata(previous: Record<string, unknown> | undefined, incoming: unknown): Record<string, unknown> | undefined {
  const next = recordValue(incoming)
  if (!previous) return next
  if (!next) return previous
  return { ...previous, ...next }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Date.now()
}

function eventTime(value: object): number {
  return "created" in value && typeof value.created === "number" ? value.created : Date.now()
}

function normalizeTool(value: unknown): { messageID: string; callID: string } | undefined {
  if (!value || typeof value !== "object") return undefined
  const tool = value as { messageID?: unknown; id?: unknown }
  if (typeof tool.messageID !== "string" || typeof tool.id !== "string") return undefined
  return { messageID: tool.messageID, callID: tool.id }
}
