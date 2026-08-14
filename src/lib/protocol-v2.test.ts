import assert from "node:assert/strict"
import test from "node:test"
import { OpenCode, type SessionInfo, type SessionMessageInfo } from "@opencode-ai/client"
import { V2EventAdapter, normalizeAgent, normalizeEvent, normalizeMessage, normalizeSession, isV2HealthResponse, normalizeProviderCatalog, V2_REQUIRED_ERROR } from "./protocol-v2.ts"

test("official client uses v2 /api paths and location query", async () => {
  const requests: URL[] = []
  const client = OpenCode.make({
    baseUrl: "http://example.test",
    fetch: async (input) => {
      requests.push(new URL(String(input)))
      return new Response(JSON.stringify({ location: { directory: "/tmp", project: { id: "p", directory: "/tmp", canonical: "/tmp" } }, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })

  await client.agent.list({ location: { directory: "/tmp" } })
  assert.equal(requests[0].pathname, "/api/agent")
  assert.equal(requests[0].searchParams.get("location[directory]"), "/tmp")
})

test("official client maps session actions to v2 paths and generated request bodies", async () => {
  const requests: Array<{ url: URL; body: unknown }> = []
  const client = OpenCode.make({
    baseUrl: "http://example.test",
    fetch: async (input, init) => {
      const url = new URL(String(input))
      requests.push({
        url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      })
      if (url.pathname.endsWith("/command")) {
        return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (url.pathname.endsWith("/revert/stage")) {
        return new Response(JSON.stringify({ data: { messageID: "message/id" } }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response(null, { status: 204 })
    },
  })

  await client.session.command({
    sessionID: "session/id",
    command: "review",
    arguments: "first  second",
    agent: "build",
    model: { providerID: "provider", id: "family/model", variant: "high" },
    files: [{ uri: "data:image/jpeg;base64,YQ==", name: "a.jpg" }],
  })
  await client.session.interrupt({ sessionID: "session/id" })
  await client.permission.reply({ sessionID: "session/id", requestID: "permission/id", reply: "once" })
  await client.question.reply({ sessionID: "session/id", requestID: "question/id", answers: [["yes"]] })
  await client.question.reject({ sessionID: "session/id", requestID: "question/id" })
  await client.session.revert.stage({ sessionID: "session/id", messageID: "message/id" })
  await client.session.revert.clear({ sessionID: "session/id" })
  await client.session.revert.commit({ sessionID: "session/id" })

  assert.deepEqual(requests.map((request) => request.url.pathname), [
    "/api/session/session%2Fid/command",
    "/api/session/session%2Fid/interrupt",
    "/api/session/session%2Fid/permission/permission%2Fid/reply",
    "/api/session/session%2Fid/question/question%2Fid/reply",
    "/api/session/session%2Fid/question/question%2Fid/reject",
    "/api/session/session%2Fid/revert/stage",
    "/api/session/session%2Fid/revert/clear",
    "/api/session/session%2Fid/revert/commit",
  ])
  assert.deepEqual(requests[0].body, {
    command: "review",
    arguments: "first  second",
    agent: "build",
    model: { providerID: "provider", id: "family/model", variant: "high" },
    files: [{ uri: "data:image/jpeg;base64,YQ==", name: "a.jpg" }],
  })
  assert.deepEqual(requests[2].body, { reply: "once" })
  assert.deepEqual(requests[3].body, { answers: [["yes"]] })
  assert.deepEqual(requests[5].body, { messageID: "message/id" })
})

test("v2 health detection rejects legacy or malformed responses", () => {
  assert.equal(isV2HealthResponse({ healthy: true, version: "2.0.0" }), true)
  assert.equal(isV2HealthResponse({ status: "ok" }), false)
  assert.equal(V2_REQUIRED_ERROR, "OpenCode v2 server required")
})

test("normalizes v2 provider and model catalog without selecting a default", () => {
  const catalog = normalizeProviderCatalog(
    [{ id: "p", name: "Provider", disabled: false } as never],
    [{
      id: "m", providerID: "p", name: "Model", capabilities: { input: ["text"], output: ["text"], tools: true },
      cost: [], limit: { context: 100, output: 10 }, variants: [], status: "active",
    } as never],
    null,
  )
  assert.deepEqual(catalog.connected, ["p"])
  assert.equal(catalog.all[0].models.m.id, "m")
  assert.deepEqual(catalog.default, {})
})

test("normalizes v2 sessions into app-owned location shape", () => {
  const session = normalizeSession({
    id: "s1",
    projectID: "p1",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    location: { directory: "/work" },
    title: "Session",
  } satisfies SessionInfo)

  assert.equal(session.directory, "/work")
  assert.equal(session.title, "Session")
  assert.equal(session.version, "2")
})

test("normalizes built-in and custom agents to their id with a display label", () => {
  const builtIn = normalizeAgent({ id: "build", name: "Build", mode: "primary" } as never)
  assert.equal(builtIn.name, "build")
  assert.equal(builtIn.label, "Build")
  const custom = normalizeAgent({ id: "code-reviewer", name: "Code Reviewer", mode: "primary" } as never)
  assert.equal(custom.name, "code-reviewer")
  assert.equal(custom.label, "Code Reviewer")
  assert.equal(normalizeAgent({ id: "plan", name: "Plan", mode: "primary" } as never).name, "plan")
})

test("normalizes known and unknown message variants without throwing", () => {
  const assistant: SessionMessageInfo = {
    id: "m1",
    type: "assistant",
    time: { created: 1 },
    agent: "build",
    model: { id: "model", providerID: "provider" },
    content: [
      { type: "text", text: "hello" },
      { type: "tool", id: "call", name: "read", state: { status: "streaming", input: "{" }, time: { created: 2 } },
    ],
  }
  const result = normalizeMessage(assistant, "s1")
  assert.equal(result.parts[0].text, "hello")
  assert.equal(result.parts[1].state?.status, "pending")

  const unknown = normalizeMessage({ id: "m2", type: "future", time: { created: 3 } } as unknown as SessionMessageInfo, "s1")
  assert.equal(unknown.info.id, "m2")
  assert.deepEqual(unknown.parts, [])
})

test("normalizes inline message files to renderable data URIs", () => {
  const message = normalizeMessage({
    id: "m-file",
    type: "user",
    time: { created: 1 },
    text: "",
    files: [{ data: "YQ==", mime: "image/png", source: { type: "inline" }, name: "a.png" }],
  }, "s1")
  assert.equal(message.parts[0].url, "data:image/png;base64,YQ==")
})

test("adapts v2 text deltas and preserves unknown events", () => {
  const adapter = new V2EventAdapter()
  adapter.push({ type: "session.text.started", created: 1, data: { sessionID: "s1", assistantMessageID: "m1", ordinal: 0 } })
  const [delta] = adapter.push({ type: "session.text.delta", created: 2, data: { sessionID: "s1", assistantMessageID: "m1", ordinal: 0, delta: "hi" } })
  assert.equal(delta.type, "message.part.updated")
  assert.equal((delta.properties.part as { text: string }).text, "hi")

  assert.deepEqual(normalizeEvent({ type: "future.event", data: { value: 1 } }), {
    type: "future.event",
    properties: { value: 1 },
  })
  assert.doesNotThrow(() => normalizeEvent(null))
})

test("normalizes complete session.created hierarchy and selection fields", () => {
  const event = normalizeEvent({
    type: "session.created",
    created: 42,
    data: {
      sessionID: "child", projectID: "project", parentID: "root", slug: "child-slug", title: "Child",
      agent: "explore", model: { providerID: "provider", id: "model", variant: "fast" },
      location: { directory: "/work", workspaceID: "workspace" }, version: "2",
    },
  })
  assert.deepEqual(event.properties.info, {
    id: "child", slug: "child-slug", projectID: "project", directory: "/work",
    location: { directory: "/work", workspaceID: "workspace" }, title: "Child", parentID: "root", agent: "explore",
    model: { providerID: "provider", modelID: "model", variant: "fast" }, version: "2", time: { created: 42, updated: 42 },
  })
})

test("preserves server.connected and tool lifecycle state", () => {
  const adapter = new V2EventAdapter()
  assert.deepEqual(adapter.push({ type: "server.connected", data: {} }), [{
    type: "server.connected", properties: {},
  }])
  adapter.push({ type: "session.tool.input.started", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", name: "bash" } })
  const called = adapter.push({ type: "session.tool.called", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", input: { command: "ls" }, metadata: { sessionId: "child", stage: "called" } } })[0]
  assert.equal((called.properties.part as { tool: string }).tool, "bash")
  assert.deepEqual((called.properties.part as { state: { input: unknown } }).state.input, { command: "ls" })
  assert.deepEqual((called.properties.part as { state: { metadata: unknown } }).state.metadata, { sessionId: "child", stage: "called" })
  const progress = adapter.push({ type: "session.tool.progress", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", metadata: { stage: "progress" } } })[0]
  assert.deepEqual((progress.properties.part as { state: { metadata: unknown } }).state.metadata, { sessionId: "child", stage: "progress" })
  const success = adapter.push({ type: "session.tool.success", data: {
    sessionID: "s1", assistantMessageID: "m1", id: "c1", metadata: { result: true }, content: [{ type: "text", text: "file.txt" }, { type: "file", uri: "file://x", mime: "text/plain" }],
  } })[0]
  const part = success.properties.part as { tool: string; state: { output: unknown } }
  assert.equal(part.tool, "bash")
  assert.equal(part.state.output, "file.txt\n[file: file://x (text/plain)]")
  assert.deepEqual((success.properties.part as { state: { metadata: unknown } }).state.metadata, { sessionId: "child", stage: "progress", result: true })
})

test("projects every generated non-chat message variant without blank parts", () => {
  const variants: SessionMessageInfo[] = [
    { id: "a", type: "agent-switched", time: { created: 1 }, agent: "build" },
    { id: "m", type: "model-switched", time: { created: 1 }, model: { providerID: "p", id: "m" } },
    { id: "l", type: "location-switched", time: { created: 1 }, location: { directory: "/tmp" } },
    { id: "s", type: "synthetic", time: { created: 1 }, text: "synthetic" },
    { id: "y", type: "system", time: { created: 1 }, text: "system" },
    { id: "k", type: "skill", time: { created: 1 }, skill: "x", name: "Skill", text: "skill" },
    { id: "h", type: "shell", time: { created: 1 }, shellID: "sh", command: "echo hi", status: "exited", output: { output: "hi", cursor: 2, size: 2, truncated: false } },
    { id: "c", type: "compaction", time: { created: 1 }, status: "completed", reason: "auto", summary: "summary", recent: "recent" },
  ]
  for (const message of variants) {
    const result = normalizeMessage(message, "s1")
    if (message.type === "shell") {
      assert.equal(result.info.presentation, "shell")
      assert.deepEqual(result.info.shell, {
        id: "h", shellID: "sh", command: "echo hi", status: "exited",
        output: { output: "hi", cursor: 2, size: 2, truncated: false }, time: { created: 1 },
      })
      assert.deepEqual(result.parts, [])
    } else {
      assert.equal(result.info.presentation, "system", message.type)
      assert.equal(result.info.systemKind, message.type === "agent-switched" ? "agent" : message.type === "model-switched" ? "model" : message.type === "location-switched" ? "location" : message.type)
      assert.equal(result.parts.length, 1, message.type)
      assert.ok(result.parts[0].text, message.type)
    }
  }
})

test("shell lifecycle events pass through without fabricating a message", () => {
  const started = normalizeEvent({
    type: "session.shell.started",
    created: 10,
    data: { sessionID: "s1", shell: { id: "shell-1", command: "sleep 1", status: "running", time: { started: 10 } } },
  })
  assert.equal(started.type, "session.shell.started")
  assert.equal((started.properties as { sessionID: string }).sessionID, "s1")
  assert.equal("info" in started.properties, false)

  const ended = normalizeEvent({
    type: "session.shell.ended",
    data: { sessionID: "s1", shell: { id: "shell-1", command: "sleep 1", status: "timeout", exit: "Infinity", time: { started: 10, completed: 20 } }, output: { output: "partial", cursor: 7, size: 7, truncated: true } },
  })
  assert.equal(ended.type, "session.shell.ended")
  assert.equal((ended.properties as { canonicalRefresh: boolean }).canonicalRefresh, true)
  assert.equal("info" in ended.properties, false)
})

test("maps v2 execution lifecycle to normalized session status", () => {
  assert.deepEqual(normalizeEvent({ type: "session.execution.started", data: { sessionID: "s1" } }), {
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "busy" } },
  })
  assert.deepEqual(normalizeEvent({ type: "session.execution.succeeded", data: { sessionID: "s1" } }), {
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "idle" }, canonicalRefresh: true },
  })
  assert.deepEqual(normalizeEvent({ type: "session.idle", data: { sessionID: "s1" } }), {
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "idle" }, canonicalRefresh: true },
  })
})

test("failed execution emits both the error and terminal idle state", () => {
  const events = new V2EventAdapter().push({
    type: "session.execution.failed",
    data: { sessionID: "s1", error: { message: "failed" } },
  })
  assert.equal(events[0].type, "session.error")
  assert.deepEqual(events[1], {
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "idle" }, canonicalRefresh: true },
  })
})

test("scopes streamed tool state so colliding callIDs stay independent", () => {
  const adapter = new V2EventAdapter()
  adapter.push({ type: "session.tool.input.started", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", name: "bash" } })
  adapter.push({ type: "session.tool.input.started", data: { sessionID: "s2", assistantMessageID: "m1", id: "c1", name: "glob" } })
  adapter.push({ type: "session.tool.input.started", data: { sessionID: "s1", assistantMessageID: "m2", id: "c1", name: "read" } })

  const delta1 = adapter.push({ type: "session.tool.input.delta", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", delta: "{\"command\":\"ls\"}" } })[0]
  const delta2 = adapter.push({ type: "session.tool.input.delta", data: { sessionID: "s2", assistantMessageID: "m1", id: "c1", delta: "{\"pattern\":\"**/*.ts\"}" } })[0]
  const delta3 = adapter.push({ type: "session.tool.input.delta", data: { sessionID: "s1", assistantMessageID: "m2", id: "c1", delta: "{\"filePath\":\"/tmp/a.ts\"}" } })[0]

  const stateOf = (event: unknown) => (event as { properties: { part: { tool?: string; state: { input: unknown } } } }).properties.part
  assert.equal(stateOf(delta1).tool, "bash")
  assert.equal(stateOf(delta2).tool, "glob")
  assert.equal(stateOf(delta3).tool, "read")

  const called1 = adapter.push({ type: "session.tool.called", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1" } })[0]
  const called2 = adapter.push({ type: "session.tool.called", data: { sessionID: "s2", assistantMessageID: "m1", id: "c1" } })[0]
  const called3 = adapter.push({ type: "session.tool.called", data: { sessionID: "s1", assistantMessageID: "m2", id: "c1" } })[0]
  assert.deepEqual(stateOf(called1).state.input, { command: "ls" })
  assert.deepEqual(stateOf(called2).state.input, { pattern: "**/*.ts" })
  assert.deepEqual(stateOf(called3).state.input, { filePath: "/tmp/a.ts" })
})

test("keeps raw input buffer independent of parsed input across deltas", () => {
  const adapter = new V2EventAdapter()
  adapter.push({ type: "session.tool.input.started", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", name: "bash" } })
  // The first delta already forms valid JSON...
  adapter.push({ type: "session.tool.input.delta", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", delta: "{\"command\":\"ls\"}" } })
  // ...but a later delta must continue the raw buffer instead of restarting from the parsed object.
  const events = adapter.push({ type: "session.tool.input.delta", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", delta: ",\"cwd\":\"/tmp\"}" } })
  const part = (events[0].properties.part as { state: { input: unknown } }).state
  assert.equal(part.input, '{"command":"ls"},"cwd":"/tmp"}')

  const called = adapter.push({ type: "session.tool.called", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1" } })[0]
  assert.deepEqual((called.properties.part as { state: { input: unknown } }).state.input, '{"command":"ls"},"cwd":"/tmp"}')
})

test("releases tool state after terminal success or failure", () => {
  const adapter = new V2EventAdapter()
  adapter.push({ type: "session.tool.input.started", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", name: "bash" } })
  adapter.push({ type: "session.tool.input.delta", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", delta: "{\"command\":\"ls\"}" } })

  const success = adapter.push({ type: "session.tool.success", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", content: [{ type: "text", text: "done" }] } })[0]
  const successPart = success.properties.part as { tool?: string; state: { status: string; input: unknown } }
  assert.equal(successPart.tool, "bash")
  assert.equal(successPart.state.status, "completed")
  assert.deepEqual(successPart.state.input, { command: "ls" })

  const failed = adapter.push({ type: "session.tool.failed", data: { sessionID: "s1", assistantMessageID: "m1", id: "c2", error: { message: "boom" } } })[0]
  assert.equal((failed.properties.part as { state: { status: string } }).state.status, "error")

  // Straggler deltas after the terminal events must not resurrect prior state.
  const straggler = adapter.push({ type: "session.tool.input.delta", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", delta: "x" } })[0]
  const part = straggler.properties.part as { tool?: string; state: { input: unknown } }
  assert.equal(part.tool, undefined)
  assert.equal(part.state.input, "x")
})

test("renders mixed text and file tool output as visible string with markers", () => {
  const adapter = new V2EventAdapter()
  adapter.push({ type: "session.tool.input.started", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", name: "bash" } })
  const success = adapter.push({ type: "session.tool.success", data: {
    sessionID: "s1", assistantMessageID: "m1", id: "c1",
    content: [
      { type: "text", text: "matched: src/a.ts\n" },
      { type: "file", uri: "file:///repo/src/a.ts", mime: "text/typescript", name: "a.ts" },
      { type: "text", text: "done" },
    ],
  } })[0]
  const output = (success.properties.part as { state: { output: unknown } }).state.output
  assert.equal(typeof output, "string")
  assert.equal(output, "matched: src/a.ts\n[file: a.ts (text/typescript)]\ndone")

  const glob = new V2EventAdapter()
  glob.push({ type: "session.tool.input.started", data: { sessionID: "s1", assistantMessageID: "m1", id: "c2", name: "glob" } })
  const filesOnly = glob.push({ type: "session.tool.success", data: {
    sessionID: "s1", assistantMessageID: "m1", id: "c2",
    content: [{ type: "file", uri: "file:///repo/a.ts", mime: "text/typescript", name: "a.ts" }],
  } })[0]
  assert.equal((filesOnly.properties.part as { state: { output: unknown } }).state.output, "[file: a.ts (text/typescript)]")
})

test("canonical tool parts flatten mixed content into visible output text", () => {
  const message = normalizeMessage({
    id: "m1",
    type: "assistant",
    time: { created: 1 },
    model: { id: "model", providerID: "provider" },
    content: [{
      type: "tool",
      id: "c1",
      name: "bash",
      state: {
        status: "completed",
        input: {},
        content: [
          { type: "text", text: "out\n" },
          { type: "file", uri: "file:///x", mime: "text/plain", name: "x.txt" },
        ],
        metadata: { sessionId: "child" },
      },
      time: { created: 1, completed: 2 },
    }],
  } satisfies SessionMessageInfo, "s1")
  assert.equal(message.parts[0].state?.output, "out\n[file: x.txt (text/plain)]")
  assert.deepEqual(message.parts[0].state?.metadata, { sessionId: "child" })
})
