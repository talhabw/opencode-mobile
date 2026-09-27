import { create } from "zustand"
import { useConnections } from "./connections"
import type { Agent, Command } from "../lib/sdk"
import {
  beginCatalogLoad,
  failCatalogLoad,
  UNRESOLVED_DEFAULTS,
  type CatalogScope,
  type DefaultResolution,
  type Provider,
} from "../lib/catalog-load"
import { chooseModelSelection } from "../lib/model-selection"
import { stripTrailingSlash } from "../lib/path-utils"

export type { CatalogScope, DefaultResolution, Provider, ProviderModel } from "../lib/catalog-load"

interface ModelSelection {
  providerID: string
  modelID: string
}

function sameModel(left: ModelSelection | null, right: ModelSelection | null) {
  return left?.providerID === right?.providerID && left?.modelID === right?.modelID
}

let requestSequence = 0

function isCurrentRequest(request: number, scope: CatalogScope) {
  const connections = useConnections.getState()
  return request === requestSequence && connections.activeConnection?.id === scope.connectionId
}

interface CatalogState {
  agents: Agent[]
  commands: Command[]
  providers: Provider[]
  defaults: Record<string, string>
  // Current selections
  agent: string // agent name, e.g. "build"
  model: ModelSelection | null
  variant: string | null // model variant for reasoning effort (e.g. "low", "medium", "high")
  loaded: boolean
  scope: CatalogScope | null
  loading: boolean
  error: string | null
  defaultModel: ModelSelection | null
  defaultAgent: string | null
  defaultResolution: DefaultResolution

  // Actions
  load: (directory?: string) => Promise<void>
  setAgent: (name: string) => void
  setModel: (selection: ModelSelection | null) => void
  setVariant: (variant: string | null) => void
  cycleAgent: (direction?: 1 | -1) => void
}

export const useCatalog = create<CatalogState>((set, get) => ({
  agents: [],
  commands: [],
  providers: [],
  defaults: {},
  agent: "",
  model: null,
  variant: null,
  loaded: false,
  scope: null,
  loading: false,
  error: null,
  defaultModel: null,
  defaultAgent: null,
  defaultResolution: UNRESOLVED_DEFAULTS,

  load: async (directory) => {
    const connections = useConnections.getState()
    const connectionId = connections.activeConnection?.id
    const normalizedDirectory = directory?.trim() ? stripTrailingSlash(directory.trim()) : undefined
    const client = connections.clientForDirectory(normalizedDirectory)
    if (!client || !connectionId) return

    const scope = { connectionId, directory: normalizedDirectory }
    const current = get()
    if (current.loaded && current.scope?.connectionId === scope.connectionId && current.scope.directory === scope.directory) return
    const request = ++requestSequence
    // Immediately stop treating the previous directory's options/defaults as
    // loaded or selectable for the new scope. Explicit pending selections are
    // preserved (not part of the patch) so the success path re-validates them.
    set(beginCatalogLoad(scope))

    try {
      const [agentResult, commandResult, providerResult, defaultModelResult] = await Promise.all([
        client.agent.list(),
        client.command.list(),
        client.provider.list(),
        client.model.default(),
      ])

      const agents = Array.isArray(agentResult) ? agentResult : []
      const commands = Array.isArray(commandResult) ? commandResult : []

    // The v2 adapter returns one normalized catalog assembled from the official
    // provider/model endpoints. Keep only connected providers for pickers.
      const raw = providerResult
      const connected = new Set(Array.isArray(raw.connected) ? raw.connected : [])
      const defaults = raw.default || {}
      const providers: Provider[] = Array.isArray(raw.all)
      ? raw.all
          .filter((p) => connected.has(p.id))
          .map((p) => ({
            id: p.id,
            name: p.name || p.id,
            connected: connected.has(p.id),
            models: Object.values(p.models || {})
              .filter((m) => m.status !== "deprecated")
              .map((m) => ({
                id: m.id,
                name: m.name || m.id,
                reasoning: m.reasoning ?? false,
                attachment: m.attachment ?? false,
                limit: m.limit,
                variants: m.variants,
              })),
          }))
          .filter((p) => p.models.length > 0)
        : []

    // Filter out hidden agents
      const visible = agents.filter((a) => !a.hidden)

    // Keep only an explicit valid selection. An empty agent lets a new v2
    // session use the server's configured default.
      const current = get().agent
      const agent = current && visible.some((a) => a.name === current) ? current : ""

      // Keep only a valid explicit selection. Defaults remain informational so
      // sending a new session preserves omission semantics.
      const existing = get().model
      const model = chooseModelSelection({ providers, defaults, existing, agentModel: null })
      const defaultModel = defaultModelResult && typeof defaultModelResult === "object"
        ? { providerID: defaultModelResult.providerID, modelID: defaultModelResult.id }
        : null
       // Mirror the TUI resolution exactly: the server sorts its agent list
       // with the effective default agent first (config default_agent, else
       // the first primary agent), so the first visible primary/all agent in
       // server order IS the default. No config.get() entry-ordering guess is
       // needed. Sessions without an explicit agent selection still omit the
       // field on the wire so the server picks its own default.
       const defaultAgent = visible.find(
         (item) => item.mode === "primary" || item.mode === "all",
       )?.name ?? null

      if (!isCurrentRequest(request, scope)) return
      set((state) => ({
        agents: visible,
        commands,
        providers,
        defaults,
        agent,
        model,
        variant: sameModel(state.model, model) ? state.variant : null,
        loaded: true,
        loading: false,
        error: null,
        scope,
        defaultModel,
        defaultAgent,
        defaultResolution: { agent: defaultAgent ? "resolved" : "unresolved", model: defaultModel ? "resolved" : "unresolved" },
      }))
    } catch (error) {
      if (!isCurrentRequest(request, scope)) return
      // Scope and options were already reset at load start; a failure must
      // leave the requested scope unloaded with no stale prior options behind.
      set(failCatalogLoad(error))
    }
  },

  setAgent: (name) => {
    if (!name) {
      set({ agent: "" })
      return
    }
    const match = get().agents.find((a) => a.name === name)
    if (!match) return
    const model = match.model || get().model
    set((state) => ({
      agent: name,
      model,
      variant: sameModel(state.model, model) ? state.variant : null,
    }))
  },

  setModel: (selection) =>
    set((state) => ({
      model: selection,
      variant: sameModel(state.model, selection) ? state.variant : null,
    })),

  setVariant: (variant) => set({ variant }),

  cycleAgent: (direction = 1) => {
    const { agents, agent } = get()
    const primary = agents.filter((a) => a.mode === "primary" || a.mode === "all")
    if (primary.length < 2) return
    const idx = primary.findIndex((a) => a.name === agent)
    const next = (idx + direction + primary.length) % primary.length
    get().setAgent(primary[next].name)
  },
}))
