import { OpenCode, type OpenCodeClient } from "@opencode-ai/client"
import { fetch as expoFetch } from "expo/fetch"
import { buildRequestHeaders } from "./headers"
import { normalizeFetchInput } from "./fetch-input.ts"
import { resolveServerPath } from "./path-utils"
import { ApiAuthError, apiStatusFor, isAuthError } from "./api-error"
import {
  normalizeAgent,
  normalizeCommand,
  normalizeMessage,
  normalizeProject,
  normalizeProviderCatalog,
  normalizeSession,
  V2EventAdapter,
  type Agent,
  type Command,
  type Event,
  type FileEntry,
  type Message,
  type MessageWithParts,
  type Part,
  type Project,
  type ProviderCatalog,
  type Session,
  isV2HealthResponse,
  v2HealthError,
} from "./protocol-v2"
import type { FileRoot } from "./file-roots"
import { promptRequest, selectedModel, type PromptPartInput } from "./session-request.ts"

export { ApiAuthError, isAuthError }
export { V2_REQUIRED_ERROR } from "./protocol-v2"
export type { Agent, Command, Event, FileEntry, Message, MessageWithParts, Part, Project, ProviderCatalog, Session }

export interface ClientConfig {
  baseUrl: string
  directory?: string
  workspace?: string
  auth?: { username: string; password: string }
}

export interface HealthResponse {
  healthy: boolean
  version: string
}

export interface CursorPage<T> {
  data: T[]
  cursor: { previous?: string | null; next?: string | null }
}

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

const DEFAULT_TIMEOUT_MS = 30_000

function location(config: ClientConfig) {
  if (!config.directory && !config.workspace) return undefined
  return { directory: config.directory, workspace: config.workspace }
}

async function checked<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise
  } catch (error) {
    const status = apiStatusFor(error)
    if (status === 401 || status === 403) throw new ApiAuthError(status, "Authentication failed")
    if (status !== undefined) throw new ApiError(status, `API Error: ${status}`)
    throw error
  }
}

function requestOptions(timeoutMs?: number): { options: { signal: AbortSignal }; dispose: () => void } {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS)
  return { options: { signal: controller.signal }, dispose: () => clearTimeout(timeout) }
}

async function timed<T>(operation: (options: { signal: AbortSignal }) => Promise<T>, timeoutMs?: number): Promise<T> {
  const request = requestOptions(timeoutMs)
  try {
    return await checked(operation(request.options))
  } finally {
    request.dispose()
  }
}

export function createClient(input: ClientConfig) {
  const config = { ...input, baseUrl: input.baseUrl.replace(/\/+$/, "") }
  const headers = buildRequestHeaders({ auth: config.auth })
  const raw = OpenCode.make({
    baseUrl: config.baseUrl,
    fetch: ((request, init) =>
      expoFetch(normalizeFetchInput(request), init as Parameters<typeof expoFetch>[1])) as typeof globalThis.fetch,
    headers,
  })
  const scopedLocation = location(config)
  const permissionSessions = new Map<string, string>()
  const questionSessions = new Map<string, string>()

  const permissionSession = async (requestID: string): Promise<string> => {
    const cached = permissionSessions.get(requestID)
    if (cached) return cached
    const response = await checked(raw.permission.request.list({ location: scopedLocation }))
    const request = response.data.find((item) => item.id === requestID)
    if (!request) throw new Error(`Unknown permission request: ${requestID}`)
    permissionSessions.set(requestID, request.sessionID)
    return request.sessionID
  }

  const questionSession = async (requestID: string): Promise<string> => {
    const cached = questionSessions.get(requestID)
    if (cached) return cached
    const response = await checked(raw.question.request.list({ location: scopedLocation }))
    const request = response.data.find((item) => item.id === requestID)
    if (!request) throw new Error(`Unknown question request: ${requestID}`)
    questionSessions.set(requestID, request.sessionID)
    return request.sessionID
  }

  const messagePage = async (
    sessionID: string,
    params?: { limit?: number; cursor?: string; order?: "asc" | "desc" },
  ): Promise<CursorPage<MessageWithParts>> => {
    const response = await checked(raw.message.list({
      sessionID,
      limit: params?.limit,
      cursor: params?.cursor,
      order: params?.cursor ? undefined : params?.order,
    }))
    return { data: response.data.map((message) => normalizeMessage(message, sessionID)), cursor: response.cursor }
  }

  return {
    /** Official v2 Promise client for protocol surfaces not normalized by the app. */
    protocol: raw,
    global: {
       health: async (timeoutMs?: number): Promise<HealthResponse> => {
         try {
           const result = await timed((options) => raw.health.get(options), timeoutMs)
           if (!isV2HealthResponse(result)) throw v2HealthError(result)
           return result
         } catch (error) {
           if (error instanceof ApiError && error.status === 404) throw v2HealthError(error)
           throw error
         }
       },
      async *events(signal?: AbortSignal): AsyncGenerator<Event> {
        const adapter = new V2EventAdapter()
        try {
          for await (const event of raw.event.subscribe({ signal })) {
            for (const normalized of adapter.push(event)) yield normalized
          }
        } catch (error) {
          const status = apiStatusFor(error)
          if (status === 401 || status === 403) throw new ApiAuthError(status, "Authentication failed")
          throw error
        }
      },
    },
    project: {
      list: async (timeoutMs?: number): Promise<Project[]> =>
         (await timed((options) => raw.project.list(options), timeoutMs)).map(normalizeProject),
      current: async (timeoutMs?: number): Promise<Project> =>
        normalizeProject(await timed((options) => raw.project.current({ location: scopedLocation }, options), timeoutMs)),
      directories: (projectID: string) => checked(raw.project.directories({ projectID, location: scopedLocation })),
    },
    file: {
      list: async (params: { path?: string } = {}): Promise<FileEntry[]> => {
        const response = await checked(raw.file.list({ location: scopedLocation, path: params.path ?? "." }))
        return response.data.map((entry) => ({
          name: entry.path.split("/").filter(Boolean).at(-1) ?? entry.path,
          path: entry.path,
          absolute: resolveServerPath(config.directory, entry.path),
          type: entry.type,
          ignored: false,
        }))
      },
      find: async (query: string, type?: "file" | "directory") =>
        (await checked(raw.file.find({ location: scopedLocation, query, type }))).data,
      read: (path: string) => checked(raw.file.read({ location: scopedLocation, path })),
      roots: async (): Promise<FileRoot[] | null> => null,
    },
    path: {
      get: async (timeoutMs?: number) => {
        const result = await timed((options) => raw.location.get({ location: scopedLocation }, options), timeoutMs)
        return { home: result.directory, state: "", config: "", worktree: result.project.directory, directory: result.directory }
      },
    },
    session: {
      page: async (
        params?: { limit?: number; search?: string; cursor?: string; order?: "asc" | "desc"; parentID?: string | null },
        timeoutMs?: number,
      ): Promise<CursorPage<Session>> => {
        const response = await timed((options) => raw.session.list({
            limit: params?.limit,
            search: params?.search,
            cursor: params?.cursor,
             order: params?.cursor ? undefined : params?.order ?? "desc",
             parentID: params?.parentID,
            directory: config.directory,
            workspace: config.workspace,
          }, options), timeoutMs)
        return { data: response.data.map(normalizeSession), cursor: response.cursor }
      },
      list: async (params?: { roots?: boolean; limit?: number; search?: string; cursor?: string; parentID?: string | null }, timeoutMs?: number): Promise<Session[]> => {
        const response = await timed((options) => raw.session.list({
          limit: params?.limit,
          search: params?.search,
          cursor: params?.cursor,
          order: params?.cursor ? undefined : "desc",
          parentID: params?.parentID,
          directory: config.directory,
          workspace: config.workspace,
        }, options), timeoutMs)
        return response.data.map(normalizeSession)
      },
      get: async (sessionID: string): Promise<Session> => normalizeSession(await checked(raw.session.get({ sessionID }))),
      create: async (params?: { title?: string }): Promise<Session> => normalizeSession(await checked(raw.session.create({
        title: params?.title,
        location: config.directory ? { directory: config.directory, workspaceID: config.workspace } : undefined,
      }))),
      delete: (sessionID: string) => checked(raw.session.remove({ sessionID })),
      rename: async (sessionID: string, title: string): Promise<Session> => {
        await checked(raw.session.rename({ sessionID, title }))
        return normalizeSession(await checked(raw.session.get({ sessionID })))
      },
      messagePage,
      messages: async (sessionID: string, params?: { limit?: number; cursor?: string }): Promise<MessageWithParts[]> =>
        (await messagePage(sessionID, { ...params, order: "asc" })).data,
      active: () => checked(raw.session.active()),
      prompt: async (sessionID: string, params: {
        parts: PromptPartInput[]
        model?: { providerID: string; modelID: string }
        agent?: string
        variant?: string
      }): Promise<void> => {
        if (params.agent) await checked(raw.session.switchAgent({ sessionID, agent: params.agent }))
        if (params.model) await checked(raw.session.switchModel({
          sessionID,
          model: selectedModel(params.model, params.variant)!,
        }))
        await checked(raw.session.prompt({ sessionID, ...promptRequest(params.parts) }))
      },
      command: async (sessionID: string, params: {
        command: string
        arguments: string
        agent?: string
        model?: { providerID: string; modelID: string }
        variant?: string
        parts?: Array<{ type: "file"; mime: string; url: string; filename?: string }>
      }): Promise<void> => {
        await checked(raw.session.command({
          sessionID,
          command: params.command,
          arguments: params.arguments,
          agent: params.agent,
          model: selectedModel(params.model, params.variant),
          files: params.parts?.map((part) => ({ uri: part.url, name: part.filename })),
        }))
      },
      switchModel: (sessionID: string, model: { providerID: string; modelID: string; variant?: string }) =>
        checked(raw.session.switchModel({ sessionID, model: { providerID: model.providerID, id: model.modelID, variant: model.variant } })),
      switchAgent: (sessionID: string, agent: string) => checked(raw.session.switchAgent({ sessionID, agent })),
      interrupt: (sessionID: string, continueSession?: boolean) => checked(raw.session.interrupt({ sessionID, continue: continueSession })),
      revert: async (sessionID: string, messageID: string): Promise<Session> => {
        await checked(raw.session.revert.stage({ sessionID, messageID }))
        return normalizeSession(await checked(raw.session.get({ sessionID })))
      },
      clearRevert: async (sessionID: string): Promise<Session> => {
        await checked(raw.session.revert.clear({ sessionID }))
        return normalizeSession(await checked(raw.session.get({ sessionID })))
      },
      commitRevert: (sessionID: string) => checked(raw.session.revert.commit({ sessionID })),
    },
    permission: {
      list: async () => {
        const response = await checked(raw.permission.request.list({ location: scopedLocation }))
        for (const request of response.data) permissionSessions.set(request.id, request.sessionID)
        return response.data.map((request) => ({
          ...request,
          tool: request.source && { messageID: request.source.messageID, callID: request.source.id },
          permission: request.action,
          patterns: request.resources,
        }))
      },
      reply: async (requestID: string, reply: "once" | "always" | "reject", explicitSessionID?: string) => {
        const sessionID = explicitSessionID ?? await permissionSession(requestID)
        await checked(raw.permission.reply({ sessionID, requestID, reply }))
        permissionSessions.delete(requestID)
        return true
      },
    },
    question: {
      list: async () => {
        const response = await checked(raw.question.request.list({ location: scopedLocation }))
        for (const request of response.data) questionSessions.set(request.id, request.sessionID)
        return response.data.map((request) => ({ ...request, tool: request.tool && { messageID: request.tool.messageID, callID: request.tool.id } }))
      },
      reply: async (requestID: string, answers: string[][], explicitSessionID?: string) => {
        const sessionID = explicitSessionID ?? await questionSession(requestID)
        await checked(raw.question.reply({ sessionID, requestID, answers }))
        questionSessions.delete(requestID)
        return true
      },
      reject: async (requestID: string, explicitSessionID?: string) => {
        const sessionID = explicitSessionID ?? await questionSession(requestID)
        await checked(raw.question.reject({ sessionID, requestID }))
        questionSessions.delete(requestID)
        return true
      },
    },
    agent: { list: async (): Promise<Agent[]> => (await checked(raw.agent.list({ location: scopedLocation }))).data.map(normalizeAgent) },
    command: { list: async (): Promise<Command[]> => (await checked(raw.command.list({ location: scopedLocation }))).data.map(normalizeCommand) },
    model: {
      list: async () => (await checked(raw.model.list({ location: scopedLocation }))).data,
      default: async () => (await checked(raw.model.default({ location: scopedLocation }))).data,
    },
    provider: {
      list: async (): Promise<ProviderCatalog> => {
        const [providers, models, defaultModel] = await Promise.all([
          checked(raw.provider.list({ location: scopedLocation })),
          checked(raw.model.list({ location: scopedLocation })),
          checked(raw.model.default({ location: scopedLocation })),
        ])
        return normalizeProviderCatalog(providers.data, models.data, defaultModel.data)
      },
    },
    config: { get: () => checked(raw.config.get({ location: scopedLocation })) },
    vcs: {
      get: async () => (await checked(raw.vcs.get({ location: scopedLocation }))).data,
      status: async () => (await checked(raw.vcs.status({ location: scopedLocation }))).data,
      diff: async (mode: "working" | "branch" = "working", context?: number) =>
        (await checked(raw.vcs.diff({ location: scopedLocation, mode, context }))).data,
    },
  }
}

export type Client = ReturnType<typeof createClient>
export type RawClient = OpenCodeClient
