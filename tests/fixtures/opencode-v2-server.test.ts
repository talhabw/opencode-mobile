import assert from "node:assert/strict"
import test from "node:test"
import { mock } from "bun:test"
import { fromQuestionForm, isQuestionForm, toFormAnswer } from "../../src/lib/question-inputs"

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
  assert.deepEqual(await client.permission.list(), [{
    id: "fixture-permission-1",
    sessionID: "fixture-child",
    action: "shell",
    resources: ["git status"],
    message: "Inspect the child workspace",
    source: { messageID: "fixture-child-assistant", id: "call-child" },
    tool: { messageID: "fixture-child-assistant", callID: "call-child" },
    permission: "shell",
    patterns: ["git status"],
  }])
  assert.deepEqual(await client.session.active(), {})

  const all = await client.protocol.session.list({ directory: "/fixture/workspace" })
  assert.deepEqual(all.data.map((item) => item.id).sort(), ["fixture-child", "fixture-root"])
  // Without a directory the list spans every workspace; with one it is exact
  // location.directory match ("fixture-other" lives in /fixture/other).
  assert.deepEqual((await client.protocol.session.list({ parentID: null })).data.map((item) => item.id), ["fixture-root", "fixture-other"])
  assert.deepEqual((await client.protocol.session.list({ directory: "/fixture/workspace", parentID: null })).data.map((item) => item.id), ["fixture-root"])
  assert.deepEqual((await client.protocol.session.list({ parentID: "fixture-root" })).data.map((item) => item.id), ["fixture-child"])
  assert.deepEqual((await client.session.page({ parentID: null })).data.map((item) => item.id), ["fixture-root"])
  assert.deepEqual((await client.session.list({ parentID: "fixture-root" })).map((item) => item.id), ["fixture-child"])
  assert.equal((await client.session.get("fixture-root")).id, "fixture-root")
  const created = await client.session.create({ title: "Created by SDK" })
  assert.equal((await client.session.get(created.id)).title, "Created by SDK")
  const rootMessages = await client.session.messages("fixture-root")
  assert.ok(rootMessages.length >= 4)
  const shell = rootMessages.find((message) => message.info.id === "fixture-shell")
  assert.equal(shell?.info.presentation, "shell")
  assert.equal(shell?.info.shell?.shellID, "fixture-shell-1")
  assert.equal(shell?.info.shell?.output?.truncated, false)
  const task = rootMessages.flatMap((message) => message.parts).find((part) => part.tool === "task")
  assert.deepEqual(task?.state?.metadata, { sessionId: "fixture-child", parentSessionId: "fixture-root" })
  const instructions = rootMessages.find((message) => message.info.id === "fixture-instructions")
  assert.equal(instructions?.info.systemKind, "system")
  assert.ok((instructions?.parts[0]?.text?.length ?? 0) > 1_000)

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

  assert.equal(await client.permission.reply("fixture-permission-1", "once", "fixture-child"), true)
  assert.equal((await client.permission.list()).length, 0)

  const pendingForms = await client.form.requestList()
  assert.equal(pendingForms.length, 1)
  assert.equal(isQuestionForm(pendingForms[0]), true)
  const pendingQuestion = fromQuestionForm(pendingForms[0]!)
  await client.form.reply({ sessionID: pendingQuestion.sessionID, formID: pendingQuestion.formID!, answer: toFormAnswer(pendingQuestion, [["Staging"], ["EU", "US"]]) })
  assert.equal((await client.form.requestList()).length, 0)

  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
  assert.equal((await client.permission.list()).length, 1)
  assert.equal((await client.form.requestList()).length, 1)
})

test("v2 fixture emits a tool input storm that accumulates and resolves canonically", async (context) => {
  const process = await start()
  context.after(() => process.kill())

  // Mirrors the payload the fixture server streams for fixture:tool-stress.
  const payload = JSON.stringify({
    filePath: "/fixture/workspace/stress.txt",
    content: Array.from({ length: 64 }, (_, index) => `tool stress line ${index + 1}: ${"y".repeat(96)}`).join("\n"),
  })

  const events = client.global.events()
  const collected: Array<{ type: string; properties: Record<string, unknown> }> = []
  const done = (async () => {
    for await (const event of events) {
      collected.push(event)
      if (event.type === "session.status" && event.properties.status && (event.properties.status as { type: string }).type === "idle") return
    }
    throw new Error("event stream ended before the tool stress run completed")
  })()

  await client.session.prompt("fixture-root", { parts: [{ type: "text", text: "fixture:tool-stress" }] })
  await done

  const parts = collected
    .filter((event) => event.type === "message.part.updated")
    .map((event) => event.properties.part as { id: string; type: string; callID: string; state: { status: string; input?: unknown; output?: unknown; metadata?: unknown } })
    .filter((part) => part.type === "tool" && part.callID === "call-tool-stress")
  const pending = parts.filter((part) => part.state.status === "pending")
  const running = parts.filter((part) => part.state.status === "running")
  const completed = parts.filter((part) => part.state.status === "completed")

  // input.started plus exactly 2,000 deltas, all coalesced into pending parts.
  assert.equal(pending.length, 2_001)
  // Deltas accumulate the raw text; the last pending part carries the full payload.
  assert.equal(pending[pending.length - 1]?.state.input, payload)
  assert.equal(parts.length, 2_001 + running.length + completed.length)

  // called installs the parsed object, progress stays running, success carries output.
  const called = parts.find((part) => part.state.status === "running")
  assert.deepEqual(called?.state.input, JSON.parse(payload))
  assert.equal(running.length, 51) // called + 50 progress events
  assert.equal(completed.length, 1)
  assert.equal(completed[0]?.state.status, "completed")
  assert.equal(completed[0]?.state.output, `wrote ${payload.length} bytes`)

  // The run ends canonically: step.ended then the normalized idle status.
  assert.equal(collected.some((event) => event.type === "session.step.ended"), true)
  assert.equal(collected[collected.length - 1]?.type, "session.status")

  // The canonical page shows the persisted completed tool call.
  const messages = await client.session.messages("fixture-root")
  const tool = messages.flatMap((message) => message.parts).find((part) => part.callID === "call-tool-stress")
  assert.deepEqual(tool?.state?.input, JSON.parse(payload))
  assert.equal(tool?.state?.output, `wrote ${payload.length} bytes`)

  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
})

test("v2 fixture exposes the forms-based question surface end to end", async (context) => {
  const process = await start()
  context.after(() => process.kill())
  const waitFor = async (match: (event: { type: string }) => boolean) => {
    for await (const event of client.global.events()) if (match(event)) return event
    throw new Error("event stream ended before match")
  }

  // Pending question inputs are seeded and recovered exclusively through the
  // forms surface on beta-18743.
  const seeded = await client.form.requestList()
  assert.equal(seeded.length, 1)
  await client.form.cancel({ sessionID: "fixture-child", formID: seeded[0].id })
  assert.deepEqual(await client.form.requestList(), [])

  const created = waitFor((event) => event.type === "form.created")
  await client.session.prompt("fixture-child", { parts: [{ type: "text", text: "fixture:form-question" }] })
  const createdEvent = await created
  const form = createdEvent.properties.form as { id?: string; sessionID?: string; metadata?: { kind?: string } }
  assert.equal(form.sessionID, "fixture-child")
  assert.equal(form.metadata?.kind, "question")

  const listed = await client.form.requestList()
  assert.equal(listed.length, 1)
  assert.equal(isQuestionForm(listed[0]), true)
  assert.deepEqual(await client.form.list("fixture-child"), listed)
  const view = fromQuestionForm(listed[0])
  const formID = view.formID ?? ""
  assert.equal(view.id, form.id)
  assert.equal(view.transport, "form")
  assert.deepEqual(view.fieldKeys, ["q0", "q1"])
  assert.deepEqual(view.fieldTypes, ["string", "multiselect"])
  assert.deepEqual(view.questions.map((question) => [question.header, question.multiple ?? false]), [["Deploy target", false], ["Regions", true]])

  // Multiselect answers encode as arrays (custom entries included), string
  // answers as scalars.
  const answer = toFormAnswer(view, [["Staging"], ["EU", "Custom region"]])
  assert.deepEqual(answer, { q0: "Staging", q1: ["EU", "Custom region"] })

  const replied = waitFor((event) => event.type === "form.replied")
  await client.form.reply({ sessionID: "fixture-child", formID, answer })
  assert.deepEqual((await replied).properties, { id: formID, sessionID: "fixture-child", answer })
  assert.deepEqual(await client.form.requestList(), [])

  const cancelled = waitFor((event) => event.type === "form.cancelled")
  await client.session.prompt("fixture-child", { parts: [{ type: "text", text: "fixture:form-question" }] })
  const second = (await client.form.requestList())[0]
  await client.form.cancel({ sessionID: "fixture-child", formID: second.id })
  assert.deepEqual((await cancelled).properties, { id: second.id, sessionID: "fixture-child" })
  assert.deepEqual(await client.form.requestList(), [])

  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
  assert.equal((await client.form.requestList()).length, 1)
})

test("v2 fixture reproduces the healthy-but-idle SSE reconnect", async (context) => {
  const process = await start()
  context.after(() => process.kill())

  // Normal subscription handshake: the first /api/event stream opens with an
  // immediate server.connected event.
  const first = client.global.events()
  let resolveConnected!: () => void
  const connected = new Promise<void>((resolve) => { resolveConnected = resolve })
  const firstEnded = (async () => {
    for await (const event of first) {
      if (event.type !== "server.connected") throw new Error(`unexpected event on closing stream: ${JSON.stringify(event)}`)
      resolveConnected()
    }
    return true
  })()
  await Promise.race([
    connected,
    Bun.sleep(2_000).then(() => { throw new Error("first event stream never sent server.connected") }),
  ])

  // The hook closes every current /api/event stream; having received
  // server.connected guarantees the server registered this client before the
  // streams are cut.
  const cut = await fetch(`${base}/fixture/reconnect-silent`, { method: "POST", headers: auth })
  assert.equal(cut.status, 200)
  assert.deepEqual(await cut.json(), { closed: 1, silentNextConnect: true })
  await Promise.race([
    firstEnded.then(() => {}),
    Bun.sleep(2_000).then(() => { throw new Error("existing event stream was not closed by /fixture/reconnect-silent") }),
  ])

  // The next subscription stays open but silent: no server.connected and no
  // stream end within the bounded window.
  const second = client.global.events()
  const secondEvent = (async () => {
    for await (const event of second) return event
    return "ended" as const
  })()
  const silence = await Promise.race([
    secondEvent.then((value) => value),
    Bun.sleep(500).then(() => "silent" as const),
  ])
  if (silence !== "silent") throw new Error(`reconnect stream was not silent: ${JSON.stringify(silence)}`)

  // The silent stream is still open and live: a normal session.created event
  // flows through it, proving open-not-closed while server.connected stays away.
  const createPromise = client.session.create({ title: "Silent reconnect probe" })
  const live = await Promise.race([
    secondEvent.then((value) => value),
    Bun.sleep(2_000).then(() => { throw new Error("silent reconnect stream is not open (no event delivered)") }),
  ]) as { type: string; properties: { info?: { id?: string } } }
  assert.equal(live.type, "session.created")
  assert.equal(live.properties.info?.id, (await createPromise).id)

  // The flag is one-shot: the following subscription gets the normal handshake again.
  const third = client.global.events()
  const thirdConnected = (async () => {
    for await (const event of third) {
      if (event.type === "server.connected") return event
    }
    throw new Error("third event stream ended before server.connected")
  })()
  assert.equal((await Promise.race([
    thirdConnected,
    Bun.sleep(2_000).then(() => { throw new Error("third stream never sent server.connected") }),
  ]))?.type, "server.connected")
})
