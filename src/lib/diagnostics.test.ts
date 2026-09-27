import assert from "node:assert/strict"
import test from "node:test"
import { mock } from "bun:test"

// diagnostics.ts imports react-native, expo-clipboard, and expo-device, which
// pull native modules that don't load under Bun. The probe behavior under test
// only needs Platform/Device metadata and the share stub, so replace them
// before the module is evaluated.
mock.module("react-native", () => ({
  Platform: { OS: "android", Version: 36 },
  Share: { share: async () => ({ action: "dismissed" }) },
}))
mock.module("expo-clipboard", () => ({ setStringAsync: async () => {} }))
mock.module("expo-device", () => ({ modelName: "Bun Test Device" }))

const { probeConnection } = await import("./diagnostics.ts")

type FetchCall = { url: string; headers: Headers }
let calls: FetchCall[] = []

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

// Run `probe` with a stubbed global fetch, restoring the real one afterwards so
// other test files in the same Bun process keep their network access.
async function withFetch<T>(routes: Record<string, () => Response>, probe: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  calls = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, headers: new Headers(init?.headers) })
    const route = routes[url]
    return route ? route() : json({ _tag: "NotFound" }, 404)
  }) as typeof globalThis.fetch
  try {
    return await probe()
  } finally {
    globalThis.fetch = original
  }
}

const healthyRoutes = (info: () => Response) => ({
  "http://server.test:4096/api/info": info,
  "http://server.test:4096/": () => new Response("<html></html>", { status: 200 }),
  "https://www.gstatic.com/generate_204": () => new Response(null, { status: 204 }),
})

test("probeConnection checks the released v2 identity at GET /api/info, never the removed /api/health", async () => {
  const report = await withFetch(
    healthyRoutes(() => json({ version: "2.0.18", pid: 1, urls: [], paths: { tmp: "/tmp" } })),
    () => probeConnection("http://server.test:4096", { username: "opencode", password: "devpassword" }),
  )

  assert.equal(report.classification, "ok")
  // A released v2 server 404s /api/health; probing it classified healthy
  // servers as "health-failed" and sent users chasing a removed route.
  assert.ok(!calls.some((call) => call.url.includes("/api/health")), "/api/health must not be probed")
  assert.deepEqual(
    calls
      .filter((call) => call.url.startsWith("http://server.test:4096"))
      .map((call) => call.url)
      .sort(),
    ["http://server.test:4096/", "http://server.test:4096/api/info"],
  )

  const infoCall = calls.find((call) => call.url.endsWith("/api/info"))
  assert.equal(infoCall?.headers.get("authorization"), `Basic ${btoa("opencode:devpassword")}`)
  assert.equal(report.attempts.find((attempt) => attempt.name === "info")?.status, 200)
})

test("a server that 404s /api/info is reported as a failed v2 identity, with the probed route named", async () => {
  const report = await withFetch(
    healthyRoutes(() => json({ _tag: "NotFound" }, 404)),
    () => probeConnection("http://server.test:4096"),
  )

  assert.equal(report.classification, "health-failed")
  assert.match(report.summary, /\/api\/info/)
  assert.doesNotMatch(report.summary, /\/api\/health/)
  assert.equal(report.attempts.find((attempt) => attempt.name === "info")?.status, 404)
})

test("diagnostics use the same UTF-8 Basic auth as the app for Unicode credentials", async () => {
  const report = await withFetch(
    healthyRoutes(() => json({ version: "2.0.18" }, 401)),
    () => probeConnection("http://server.test:4096", { username: "opencode", password: "ключ🔑" }),
  )
  assert.equal(report.classification, "health-failed")
  assert.equal(
    calls.find((call) => call.url.endsWith("/api/info"))?.headers.get("authorization"),
    `Basic ${Buffer.from("opencode:ключ🔑", "utf8").toString("base64")}`,
  )
})

test("a malformed URL still classifies without probing the server", async () => {
  const report = await withFetch(healthyRoutes(() => json({ version: "2.0.18" })), () =>
    probeConnection("not a url"),
  )

  assert.equal(report.classification, "malformed-url")
  assert.equal(report.attempts.find((attempt) => attempt.name === "info")?.error, "skipped: malformed url")
  assert.ok(!calls.some((call) => call.url.startsWith("not a url")))
})
