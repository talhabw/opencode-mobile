import { test } from "node:test"
import assert from "node:assert/strict"
import { create } from "zustand"
import {
  beginCatalogLoad,
  failCatalogLoad,
  isSelectableModel,
  matchesCatalogScope,
  UNRESOLVED_DEFAULTS,
  type CatalogScope,
  type DefaultResolution,
  type Provider,
} from "./catalog-load.ts"
import type { Agent, Command } from "./sdk.ts"

test("matches only the active connection and normalized directory", () => {
  const scope = { connectionId: "c1", directory: "/workspace/project" }
  assert.equal(matchesCatalogScope(scope, "c1", "/workspace/project/"), true)
  assert.equal(matchesCatalogScope(scope, "c2", "/workspace/project"), false)
  assert.equal(matchesCatalogScope(scope, "c1", "/workspace/other"), false)
})

test("isSelectableModel hides explicitly disabled and deprecated models only", () => {
  assert.equal(isSelectableModel({}), true)
  assert.equal(isSelectableModel({ enabled: true, status: "active" }), true)
  assert.equal(isSelectableModel({ enabled: true, status: "alpha" }), true)
  assert.equal(isSelectableModel({ enabled: false }), false)
  assert.equal(isSelectableModel({ enabled: false, status: "active" }), false)
  assert.equal(isSelectableModel({ status: "deprecated" }), false)
  assert.equal(isSelectableModel({ status: "deprecated", enabled: true }), false)
})

interface ModelSelection {
  providerID: string
  modelID: string
}

interface HarnessState {
  agents: Agent[]
  commands: Command[]
  providers: Provider[]
  defaults: Record<string, string>
  agent: string
  model: ModelSelection | null
  variant: string | null
  loaded: boolean
  scope: CatalogScope | null
  loading: boolean
  error: string | null
  defaultModel: ModelSelection | null
  defaultAgent: string | null
  defaultResolution: DefaultResolution
  beginLoad: (scope: CatalogScope) => void
  failLoad: (error: unknown) => void
}

// Real zustand store wired exactly like src/stores/catalog.ts's load() start
// and error transitions, so the regression scenarios exercise the same merge
// semantics the store will apply.
function createHarness() {
  return create<HarnessState>((set) => ({
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
    beginLoad: (scope) => set(beginCatalogLoad(scope)),
    failLoad: (error) => set(failCatalogLoad(error)),
  }))
}

const priorAgent: Agent = { name: "build", mode: "primary", hidden: false, model: null }
const priorModel: ModelSelection = { providerID: "p1", modelID: "m1" }
const priorCommand: Command = { name: "old-cmd", description: "" }
const priorProvider: Provider = {
  id: "p1",
  name: "P1",
  connected: true,
  models: [{ id: "m1", name: "M1", reasoning: false, attachment: false }],
}

function seedLoadedPriorDirectory(store: ReturnType<typeof createHarness>) {
  store.setState({
    agents: [priorAgent],
    commands: [priorCommand],
    providers: [priorProvider],
    defaults: { p1: "m1" },
    agent: priorAgent.name,
    model: priorModel,
    variant: "low",
    loaded: true,
    loading: false,
    scope: { connectionId: "c1", directory: "/a" },
    defaultModel: priorModel,
    defaultAgent: "build",
    defaultResolution: { agent: "resolved", model: "resolved" },
  })
}

test("beginCatalogLoad clears scoped options and marks the requested scope unloaded", () => {
  const patch = beginCatalogLoad({ connectionId: "c1", directory: "/b" })
  assert.deepEqual(patch.agents, [])
  assert.deepEqual(patch.commands, [])
  assert.deepEqual(patch.providers, [])
  assert.deepEqual(patch.defaults, {})
  assert.equal(patch.loaded, false)
  assert.equal(patch.loading, true)
  assert.equal(patch.error, null)
  assert.deepEqual(patch.scope, { connectionId: "c1", directory: "/b" })
  assert.equal(patch.defaultModel, null)
  assert.equal(patch.defaultAgent, null)
  assert.deepEqual(patch.defaultResolution, { agent: "unresolved", model: "unresolved" })
  // Explicit pending selections are not part of the patch: the store's merge
  // keeps them so the success path can re-validate them later.
  assert.ok(!("agent" in patch))
  assert.ok(!("model" in patch))
  assert.ok(!("variant" in patch))
})

test("starting a load immediately drops prior-directory options but keeps pending selections", () => {
  const store = createHarness()
  seedLoadedPriorDirectory(store)

  store.getState().beginLoad({ connectionId: "c1", directory: "/b" })

  const state = store.getState()
  assert.equal(state.loaded, false)
  assert.equal(state.loading, true)
  assert.equal(state.error, null)
  assert.deepEqual(state.scope, { connectionId: "c1", directory: "/b" })
  assert.deepEqual(state.agents, [])
  assert.deepEqual(state.commands, [])
  assert.deepEqual(state.providers, [])
  assert.deepEqual(state.defaults, {})
  assert.equal(state.defaultModel, null)
  assert.equal(state.defaultAgent, null)
  assert.deepEqual(state.defaultResolution, { agent: "unresolved", model: "unresolved" })
  // Explicit pending selections survive for later validation.
  assert.equal(state.agent, "build")
  assert.deepEqual(state.model, priorModel)
  assert.equal(state.variant, "low")
})

test("a failed load leaves the requested scope unloaded with empty options", () => {
  const store = createHarness()
  seedLoadedPriorDirectory(store)

  store.getState().beginLoad({ connectionId: "c1", directory: "/b" })
  store.getState().failLoad(new Error("boom"))

  const state = store.getState()
  assert.equal(state.loaded, false)
  assert.equal(state.loading, false)
  assert.equal(state.error, "boom")
  // The new scope is kept, but never paired with stale prior-directory data.
  assert.deepEqual(state.scope, { connectionId: "c1", directory: "/b" })
  assert.deepEqual(state.agents, [])
  assert.deepEqual(state.commands, [])
  assert.deepEqual(state.providers, [])
  assert.deepEqual(state.defaults, {})
  assert.equal(state.defaultModel, null)
  assert.equal(state.defaultAgent, null)
  assert.deepEqual(state.defaultResolution, { agent: "unresolved", model: "unresolved" })
  assert.equal(state.agent, "build")
})

test("a retry after a failed load starts fresh instead of keeping the error state", () => {
  const store = createHarness()
  seedLoadedPriorDirectory(store)

  store.getState().beginLoad({ connectionId: "c1", directory: "/b" })
  store.getState().failLoad(new Error("boom"))
  store.getState().beginLoad({ connectionId: "c1", directory: "/b" })

  const state = store.getState()
  assert.equal(state.loaded, false)
  assert.equal(state.loading, true)
  assert.equal(state.error, null)
  assert.deepEqual(state.scope, { connectionId: "c1", directory: "/b" })
  assert.deepEqual(state.agents, [])
})

test("failCatalogLoad formats the error and never flips loaded back on", () => {
  assert.deepEqual(failCatalogLoad(new Error("boom")), {
    loading: false,
    loaded: false,
    error: "boom",
  })
  assert.deepEqual(failCatalogLoad("plain failure"), {
    loading: false,
    loaded: false,
    error: "plain failure",
  })
})
