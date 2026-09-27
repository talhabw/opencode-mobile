import assert from "node:assert/strict"
import test from "node:test"
import { OpenCode, type SessionInfo, type SessionMessageInfo } from "@opencode-ai/client"
import { V2EventAdapter, normalizeAgent, normalizeCommand, normalizeEvent, normalizeMessage, normalizeSession, isV2HealthResponse, normalizeProviderCatalog, parseSyntheticTag, V2_REQUIRED_ERROR } from "./protocol-v2.ts"

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
      if (url.pathname.endsWith("/interrupt")) {
        return new Response(JSON.stringify({ interrupted: true }), { status: 200, headers: { "content-type": "application/json" } })
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
    text: "first  second",
    files: [{ uri: "data:image/jpeg;base64,YQ==", name: "a.jpg", description: "Screenshot" }],
  })
  await client.session.interrupt({ sessionID: "session/id" })
  await client.permission.reply({ sessionID: "session/id", requestID: "permission/id", reply: "once", message: "Approved" })
  await client.session.revert.stage({ sessionID: "session/id", messageID: "message/id" })
  await client.session.revert.clear({ sessionID: "session/id" })
  await client.session.revert.commit({ sessionID: "session/id" })

  assert.deepEqual(requests.map((request) => request.url.pathname), [
    "/api/session/session%2Fid/command",
    "/api/session/session%2Fid/interrupt",
    "/api/session/session%2Fid/permission/permission%2Fid/reply",
    "/api/session/session%2Fid/revert/stage",
    "/api/session/session%2Fid/revert/clear",
    "/api/session/session%2Fid/revert/commit",
  ])
  // The beta command request is flat: arguments became `text` and the file
  // attachments moved next to it; agent/model selection is no longer part of
  // the request body.
  assert.deepEqual(requests[0].body, {
    command: "review",
    text: "first  second",
    files: [{ uri: "data:image/jpeg;base64,YQ==", name: "a.jpg", description: "Screenshot" }],
  })
  assert.deepEqual(requests[2].body, { reply: "once", message: "Approved" })
  assert.deepEqual(requests[3].body, { messageID: "message/id" })
})

test("beta client removes the legacy question API and project directories endpoint", async () => {
  const client = OpenCode.make({
    baseUrl: "http://example.test",
    fetch: async () => new Response(null, { status: 204 }),
  })
  assert.equal("question" in client, false)
  assert.equal("directories" in client.project, false)
})

test("v2 health detection rejects legacy or malformed responses", () => {
  assert.equal(isV2HealthResponse({ healthy: true, version: "2.0.0" }), true)
  assert.equal(isV2HealthResponse({ status: "ok" }), false)
  assert.equal(V2_REQUIRED_ERROR, "OpenCode v2 server required")
})

test("normalizes v2 provider and model catalog without selecting a default", () => {
  const catalog = normalizeProviderCatalog(
    [
      { id: "p", name: "Provider", activation: "enabled" },
      { id: "auto", name: "Auto Provider", activation: "auto" },
      { id: "off", name: "Disabled Provider", activation: "disabled" },
    ] as never,
    [{
      id: "m", providerID: "p", name: "Model", capabilities: { input: ["text"], output: ["text"], tools: true },
      cost: [], limit: { context: 100, output: 10 }, variants: [], status: "active",
    } as never],
    null,
  )
  // Provider activation drives connectivity: `disabled` is excluded, `auto`
  // and `enabled` both count as connected for the pickers.
  assert.deepEqual(catalog.connected, ["p", "auto"])
  assert.equal(catalog.all[0].models.m.id, "m")
  assert.deepEqual(catalog.default, {})
})

test("normalizes beta command info into name and description only", () => {
  assert.deepEqual(normalizeCommand({ name: "review", description: "Review the diff" }), {
    name: "review",
    description: "Review the diff",
  })
  assert.deepEqual(normalizeCommand({ name: "bare" }), { name: "bare", description: undefined })
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

test("passes permission message through permission.asked normalization", () => {
  const event = normalizeEvent({
    type: "permission.asked",
    data: {
      id: "perm/1",
      sessionID: "s1",
      action: "bash",
      resources: ["cat /etc/hostname"],
      source: { type: "tool", messageID: "m1", id: "call/1" },
      message: "Run bash: cat /etc/hostname",
    },
  })
  assert.equal(event.type, "permission.asked")
  const properties = event.properties as Record<string, unknown>
  assert.equal(properties.message, "Run bash: cat /etc/hostname")
  assert.equal(properties.permission, "bash")
  assert.deepEqual(properties.patterns, ["cat /etc/hostname"])
  assert.deepEqual(properties.tool, { messageID: "m1", callID: "call/1" })
  assert.equal(properties.sessionID, "s1")
  // Legacy question events are no longer normalized specially — they fall
  // through like any unknown event type.
  assert.deepEqual(normalizeEvent({ type: "question.asked", data: { id: "q1", questions: [] } }), {
    type: "question.asked",
    properties: { id: "q1", questions: [] },
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

test("streams tool input without parsing every delta", () => {
  const adapter = new V2EventAdapter()
  const payload = JSON.stringify({ filePath: "/tmp/a.ts", content: "x".repeat(4_096) })
  adapter.push({ type: "session.tool.input.started", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", name: "write" } })

  let finalDelta: unknown
  for (let offset = 0; offset < payload.length; offset += 7) {
    const [event] = adapter.push({ type: "session.tool.input.delta", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", delta: payload.slice(offset, offset + 7) } })
    finalDelta = (event.properties.part as { state: { input: unknown } }).state.input
    // The raw accumulated text is visible while streaming; nothing is parsed.
    assert.equal(typeof finalDelta, "string")
  }
  assert.equal(finalDelta, payload)

  const called = adapter.push({ type: "session.tool.called", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1" } })[0]
  assert.deepEqual((called.properties.part as { state: { input: unknown } }).state.input, JSON.parse(payload))

  const success = adapter.push({ type: "session.tool.success", data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", content: [{ type: "text", text: "done" }] } })[0]
  const state = (success.properties.part as { state: { status: string; input: unknown; output: unknown } }).state
  assert.equal(state.status, "completed")
  assert.deepEqual(state.input, JSON.parse(payload))
  assert.equal(state.output, "done")
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

test("classifies synthetic shell tags into structured shell rows with truthful state", () => {
  for (const state of ["completed", "error", "cancelled"] as const) {
    const result = normalizeMessage({
      id: `msg_${state}`,
      type: "synthetic",
      time: { created: 5 },
      text: `<shell id="call_x_${state}" state="${state}" command="bun run dev:env">`,
    } satisfies SessionMessageInfo, "s1")
    assert.equal(result.info.presentation, "shell", state)
    assert.deepEqual(result.info.shell, {
      id: `msg_${state}`,
      shellID: `call_x_${state}`,
      command: "bun run dev:env",
      status: state,
      time: { created: 5 },
    }, state)
    assert.deepEqual(result.parts, [], state)
  }
})

test("classifies synthetic subagent tags into structured subagent rows", () => {
  for (const state of ["completed", "error", "cancelled"] as const) {
    const result = normalizeMessage({
      id: `msg_${state}`,
      type: "synthetic",
      time: { created: 7 },
      text: `<subagent id="ses_child_${state}" state="${state}" description="Trace streaming UI freeze">`,
    } satisfies SessionMessageInfo, "s1")
    assert.equal(result.info.presentation, "subagent", state)
    assert.deepEqual(result.info.subagent, {
      id: `msg_${state}`,
      refID: `ses_child_${state}`,
      state,
      description: "Trace streaming UI freeze",
      time: { created: 7 },
    }, state)
    assert.deepEqual(result.parts, [], state)
  }
})

test("synthetic tag parser tolerates attribute order, quoting, and unknown attributes", () => {
  assert.deepEqual(
    parseSyntheticTag(`<shell command='bun run dev:env' state="completed" id="call_1" extra="ignored">`),
    { kind: "shell", id: "call_1", state: "completed", command: "bun run dev:env" },
  )
  assert.deepEqual(
    parseSyntheticTag(`  <subagent  state='error'  id='ses_1'  description='Investigate freeze'  unknown="x" >  `),
    { kind: "subagent", id: "ses_1", state: "error", description: "Investigate freeze" },
  )
  assert.deepEqual(
    parseSyntheticTag(`<shell id="call_2" state="completed">`),
    { kind: "shell", id: "call_2", state: "completed", command: "" },
  )
})

test("synthetic tag parser captures wrapped marker content between open and close tags", () => {
  assert.deepEqual(
    parseSyntheticTag(`<shell id="call_1" state="completed" command="bun run dev:env">\nDone in 412ms\n</shell>`),
    { kind: "shell", id: "call_1", state: "completed", command: "bun run dev:env", content: "Done in 412ms" },
  )
  assert.deepEqual(
    parseSyntheticTag(`<subagent id="ses_1" state="completed" description="Trace freeze">\nSubagent finished the trace\n</subagent>`),
    { kind: "subagent", id: "ses_1", state: "completed", description: "Trace freeze", content: "Subagent finished the trace" },
  )
  // Empty content between the tags is treated as no content, not "".
  assert.deepEqual(
    parseSyntheticTag(`<shell id="call_2" state="error" command="ls">\n</shell>`),
    { kind: "shell", id: "call_2", state: "error", command: "ls" },
  )
})

test("wrapped synthetic markers map content into shell output and subagent result", () => {
  const shell = normalizeMessage({
    id: "m1",
    type: "synthetic",
    time: { created: 1 },
    text: `<shell id="call_1" state="completed" command="bun run dev:env">\nDone in 412ms\n</shell>`,
  } satisfies SessionMessageInfo, "s1")
  assert.equal(shell.info.presentation, "shell")
  assert.equal(shell.info.shell?.output?.output, "Done in 412ms")

  const subagent = normalizeMessage({
    id: "m2",
    type: "synthetic",
    time: { created: 1 },
    text: `<subagent id="ses_1" state="completed" description="Trace">\nFound the race\n</subagent>`,
  } satisfies SessionMessageInfo, "s1")
  assert.equal(subagent.info.presentation, "subagent")
  assert.equal(subagent.info.subagent?.result, "Found the race")
})

test("malformed or non-marker synthetic text keeps the system-row fallback", () => {
  const fallbacks = [
    "plain synthetic text",
    '<shell id="call_1" state="completed"',
    '<shell id="call_1" state="finished" command="ls">',
    '<foo id="x" state="completed">',
    '<subagent state="completed">',
    '<subagent id="ses_1">',
    'prefix <shell id="c" state="completed">',
  ]
  for (const text of fallbacks) {
    const result = normalizeMessage({ id: "m", type: "synthetic", time: { created: 1 }, text } satisfies SessionMessageInfo, "s1")
    assert.equal(result.info.presentation, "system", text)
    assert.equal(result.info.systemKind, "synthetic", text)
    assert.equal(result.parts.length, 1, text)
    assert.equal(result.parts[0].text, text, text)
  }
})

test("subagent payload prefers the tag description and falls back to the persisted description", () => {
  const fromPersisted = normalizeMessage({
    id: "m1",
    type: "synthetic",
    time: { created: 1 },
    text: `<subagent id="ses_1" state="completed">`,
    description: "Persisted description",
  } satisfies SessionMessageInfo, "s1")
  assert.equal(fromPersisted.info.subagent?.description, "Persisted description")

  const fromTag = normalizeMessage({
    id: "m2",
    type: "synthetic",
    time: { created: 1 },
    text: `<subagent id="ses_2" state="cancelled" description="From tag">`,
    description: "Persisted description",
  } satisfies SessionMessageInfo, "s1")
  assert.equal(fromTag.info.subagent?.description, "From tag")

  const none = normalizeMessage({
    id: "m3",
    type: "synthetic",
    time: { created: 1 },
    text: `<subagent id="ses_3" state="error">`,
  } satisfies SessionMessageInfo, "s1")
  assert.equal(none.info.subagent?.description, undefined)
})

test("preserves synthetic tag ids exactly", () => {
  const shell = normalizeMessage({
    id: "msgA",
    type: "synthetic",
    time: { created: 1 },
    text: `<shell id="call_weird/id=1" state="completed" command="x">`,
  } satisfies SessionMessageInfo, "s1")
  assert.equal(shell.info.shell?.shellID, "call_weird/id=1")

  const subagent = normalizeMessage({
    id: "msgB",
    type: "synthetic",
    time: { created: 1 },
    text: `<subagent id="ses_abc/DEF-123" state="completed" description="d">`,
  } satisfies SessionMessageInfo, "s1")
  assert.equal(subagent.info.subagent?.refID, "ses_abc/DEF-123")
  assert.equal(subagent.info.id, "msgB")
})
