// Pure catalog-scope transition helpers for the catalog store
// (src/stores/catalog.ts). No React Native imports — unit-testable with
// node --test (mirrors model-selection.ts / path-utils.ts).

export interface ProviderModel {
  id: string
  name: string
  reasoning: boolean
  attachment: boolean
  limit?: { context: number; output: number }
  variants?: Record<string, { reasoningEffort?: string }>
}

export interface SelectableModel {
  status?: string
  enabled?: boolean
}

/**
 * The pickers only offer models that can actually run. An explicitly disabled
 * model (`enabled: false`) is never selectable, and deprecated catalog entries
 * are hidden. Servers/fixtures that omit the flag stay selectable — only an
 * explicit false hides a model.
 */
export function isSelectableModel(model: SelectableModel): boolean {
  return model.enabled !== false && model.status !== "deprecated"
}

export interface Provider {
  id: string
  name: string
  connected: boolean
  models: ProviderModel[]
}

export interface CatalogScope {
  connectionId: string
  directory?: string
}

export function matchesCatalogScope(
  scope: CatalogScope | null,
  connectionId: string | null | undefined,
  directory?: string,
): boolean {
  const normalized = directory?.trim().replace(/[\\/]+$/, "") || directory?.trim() || undefined
  return !!scope && scope.connectionId === connectionId && scope.directory === normalized
}

export interface DefaultResolution {
  agent: "resolved" | "unresolved"
  model: "resolved" | "unresolved"
}

export const UNRESOLVED_DEFAULTS: DefaultResolution = { agent: "unresolved", model: "unresolved" }

/**
 * State patch applied the moment a load begins for a scope. Prior-directory
 * options and default resolution must never remain considered loaded or
 * selectable once the scope changes (or a reload is in flight), and a failed
 * load must not leave the new scope paired with stale data. Explicit pending
 * selections (agent/model/variant) are intentionally NOT part of the patch,
 * so the store's merge preserves them for re-validation against the fresh
 * catalog on success.
 */
export function beginCatalogLoad(scope: CatalogScope) {
  return {
    agents: [],
    commands: [],
    providers: [],
    defaults: {},
    loaded: false,
    loading: true,
    error: null,
    scope,
    defaultModel: null,
    defaultAgent: null,
    defaultResolution: UNRESOLVED_DEFAULTS,
  }
}

/**
 * State patch for a failed load: the scope stays as requested at load start
 * (already reset by beginCatalogLoad) and remains unloaded with empty options.
 */
export function failCatalogLoad(error: unknown) {
  return {
    loading: false,
    loaded: false,
    error: error instanceof Error ? error.message : String(error),
  }
}
