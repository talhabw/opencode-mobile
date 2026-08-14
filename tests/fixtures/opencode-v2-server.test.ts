import assert from "node:assert/strict"
import test from "node:test"
import { mock } from "bun:test"

// Expo's fetch module imports React Native internals under Bun; the production
// SDK still gets instantiated, with the platform fetch replaced for this test.
mock.module("expo/fetch", () => ({ fetch: globalThis.fetch }))
const { createClient } = await import("../../src/lib/sdk")

const port = Number(process.env.OPENCODE_FIXTURE_TEST_PORT) || 42000 + process.pid % 20000
const base = `http://127.0.0.1:${port}`
const auth = { Authorization: `Basic ${Buffer.from("opencode:devpassword").toString("base64")}` }
const client = createClient({ baseUrl: base, directory: "/fixture/workspace", auth: { username: "opencode", password: "devpassword" } })

async function start() {
  const process = Bun.spawn(["bun", "tests/fixtures/opencode-v2-server.ts", "--port", String(port)], { stdout: "pipe", stderr: "pipe" })
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      if ((await fetch(`${base}/health`, { headers: auth })).ok) return process
    } catch {}
    await Bun.sleep(25)
  }
  process.kill()
  throw new Error("fixture server did not become ready")
}

test("v2 fixture matches the generated client protocol", async (context) => {
  const process = await start()
  context.after(() => process.kill())

  assert.equal((await client.global.health()).version, "2.0.0-fixture")
  assert.equal((await client.path.get()).directory, "/fixture/workspace")
  assert.equal((await client.project.list())[0]?.id, "fixture-project")
  assert.equal((await client.project.current()).id, "fixture-project")
  assert.equal((await client.agent.list()).length, 3)
  assert.equal((await client.model.list())[0]?.modelID, "fixture-model")
  assert.equal((await client.provider.list()).all[0]?.id, "fixture")
  assert.equal((await client.config.get())[0]?.info.default_agent, "build")
  assert.equal((await client.vcs.get()).branch.current, "fixture")
  assert.deepEqual(await client.vcs.status(), [])
  assert.equal(await client.vcs.diff(), "")
  assert.deepEqual(await client.permission.list(), [])
  assert.deepEqual(await client.session.active(), {})

  const all = await client.protocol.session.list({ directory: "/fixture/workspace" })
  assert.deepEqual(all.data.map((item) => item.id).sort(), ["fixture-child", "fixture-root"])
  assert.deepEqual((await client.protocol.session.list({ parentID: null })).data.map((item) => item.id), ["fixture-root"])
  assert.deepEqual((await client.protocol.session.list({ parentID: "fixture-root" })).data.map((item) => item.id), ["fixture-child"])
  assert.equal((await client.session.get("fixture-root")).id, "fixture-root")
  const created = await client.session.create({ title: "Created by SDK" })
  assert.equal((await client.session.get(created.id)).title, "Created by SDK")
  assert.ok((await client.session.messages("fixture-root")).length >= 4)

  const events = client.global.events()
  const eventPromise = (async () => {
    for await (const event of events) {
      if (event.type === "session.status" && event.properties.status.type === "idle") return event
    }
  })()
  await client.session.switchAgent("fixture-root", "plan")
  await client.session.switchModel("fixture-root", { providerID: "fixture", modelID: "fixture-model", variant: "deep" })
  await client.session.prompt("fixture-root", { parts: [{ type: "text", text: "ping" }] })
  assert.equal((await eventPromise)?.type, "session.status")
  const updated = await client.session.messages("fixture-root")
  assert.equal(new Set(updated.map((message) => message.info.id)).size, updated.length)

  assert.deepEqual(await client.question.list(), [{ id: "fixture-question-1", sessionID: "fixture-child", questions: [{ question: "Continue the child task?", header: "Continue", options: [{ label: "Yes", description: "Continue" }, { label: "No", description: "Stop" }], multiple: false }], tool: { messageID: "fixture-child-assistant", callID: "call-child" } }])
  assert.equal(await client.question.reply("fixture-question-1", [["Yes"]], "fixture-child"), true)
  assert.equal((await client.question.list()).length, 0)

  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
  assert.equal((await client.question.list()).length, 1)
})
