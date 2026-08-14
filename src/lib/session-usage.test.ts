import { describe, expect, test } from "bun:test"
import type { Message } from "./sdk"
import type { Provider } from "../stores/catalog"
import { computeSessionUsage } from "./session-usage"

const message = (overrides: Partial<Message> = {}): Message => ({
  id: "m1",
  sessionID: "s1",
  role: "assistant",
  presentation: "assistant",
  time: { created: 1, completed: 2 },
  providerID: "p1",
  modelID: "m1",
  tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
  ...overrides,
})

const providers = (context?: number): Provider[] => [{
  id: "p1",
  name: "Provider",
  connected: true,
  models: [{ id: "m1", name: "Model", reasoning: true, attachment: false, limit: context === undefined ? undefined : { context, output: 100 } }],
}]

describe("computeSessionUsage", () => {
  test("uses the exact provider and model pair", () => {
    const result = computeSessionUsage([message()], [
      { ...providers(100)[0], id: "other" },
      ...providers(100),
    ])
    expect(result.context).toBe(100)
    expect(result.percent).toBe(42)
  })

  test("distinguishes missing limits and unknown usage from zero", () => {
    expect(computeSessionUsage([], providers(100))).toMatchObject({ total: 0, context: null, percent: null })
    expect(computeSessionUsage([message()], providers())).toMatchObject({ total: 42, context: null, percent: null })
  })

  test("rounds context usage to the nearest whole percent", () => {
    expect(computeSessionUsage([message({ tokens: { input: 1, output: 2 } })], providers(8)).percent).toBe(38)
  })

  test("uses the latest eligible assistant response and ignores users and system rows", () => {
    const old = message({ id: "old", tokens: { input: 1, output: 1 } })
    const system = message({ id: "system", presentation: "system", tokens: { input: 90, output: 90 } })
    const latest = message({ id: "latest", tokens: { input: 2, output: 3 } })
    const user: Message = { ...message({ id: "user" }), role: "user", presentation: "user", tokens: { input: 100, output: 100 } }
    expect(computeSessionUsage([old, user, system, latest], providers(10)).total).toBe(5)
  })

  test("reports zero and values over one hundred percent", () => {
    expect(computeSessionUsage([message({ tokens: { input: 0, output: 0 } })], providers(100)).percent).toBe(0)
    expect(computeSessionUsage([message({ tokens: { input: 150, output: 1 } })], providers(100)).percent).toBe(151)
  })
})
