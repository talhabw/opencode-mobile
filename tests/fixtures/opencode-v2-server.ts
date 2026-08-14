/* Deterministic, in-memory OpenCode v2 server for emulator tests. */

import type {
  AgentInfo,
  ModelInfo,
  ProviderInfo,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageShell,
  SessionMessageUser,
} from "@opencode-ai/client"

declare const Bun: { serve(options: { port: number; hostname: string; fetch: (request: Request) => Promise<Response> }): unknown }

type Json = Record<string, unknown>
type Client = { controller: ReadableStreamDefaultController<Uint8Array>; encoder: TextEncoder }

const root = "/fixture/workspace"
const now = 1_700_000_000_000
const project = { id: "fixture-project", directory: root, canonical: root }
const agents = [
  { id: "build", name: "Build", description: "Fixture build agent", mode: "primary", hidden: false, steps: 12, model: { id: "fixture-model", providerID: "fixture" }, request: { settings: {}, headers: {}, body: {} }, permissions: [] },
  { id: "plan", name: "Plan", description: "Fixture planning agent", mode: "primary", hidden: false, request: { settings: {}, headers: {}, body: {} }, permissions: [] },
  { id: "explore", name: "Explore", description: "Fixture subagent", mode: "subagent", hidden: false, request: { settings: {}, headers: {}, body: {} }, permissions: [] },
] satisfies AgentInfo[]
const model = (modelID: string, name: string, variants: string[] = []) => ({
  id: modelID, modelID, providerID: "fixture", name, capabilities: { input: ["text"], output: ["text", "reasoning"], tools: true },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }], limit: { context: 32768, output: 4096 }, variants: variants.map((id) => ({ id })), status: "active", enabled: true, time: { released: now }, package: "fixture",
}) satisfies ModelInfo
const models = [model("fixture-model", "Fixture Model", ["fast", "deep"]), model("fixture-small", "Fixture Small")]
const provider = { id: "fixture", name: "Fixture Provider", package: "fixture", disabled: false } satisfies ProviderInfo
const clients = new Set<Client>()
let sessions: Json[]
let messages = new Map<string, Json[]>()
let questions: Json[]
let permissions: Json[]
let forms: Json[]
let eventSequence = 0
let messageSequence = 1
let formSequence = 0

const session = (id: string, title: string, parentID?: string): SessionInfo => ({ id, ...(parentID ? { parentID } : {}), projectID: project.id, agent: "build", model: { id: "fixture-model", providerID: "fixture", variant: "fast" }, location: { directory: root }, title, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: now, updated: now } })
const user = (id: string, _sessionID: string, text: string): SessionMessageUser => ({ type: "user", id, text, time: { created: now } })
const assistant = (id: string, text: string): SessionMessageAssistant => ({ type: "assistant", id, agent: "build", model: { id: "fixture-model", providerID: "fixture" }, cost: 0, tokens: { input: 3, output: 7, reasoning: 0, cache: { read: 0, write: 0 } }, content: [{ type: "text", text }], finish: "stop", time: { created: now, completed: now + 1 } })

function reset() {
  const rootSession = session("fixture-root", "Fixture root session")
  const child = session("fixture-child", "Fixture child task", rootSession.id as string)
  sessions = [rootSession, child]
  messages = new Map([
    [rootSession.id as string, [user("fixture-user-1", rootSession.id as string, "Show me the fixture transcript"), assistant("fixture-assistant-1", "This is a deterministic v2 fixture response.")]],
    [child.id as string, [user("fixture-child-user", child.id as string, "Inspect the workspace"), { ...assistant("fixture-child-assistant", "Workspace inspection complete."), content: [{ type: "tool", id: "call-child", name: "shell", time: { created: now, completed: now + 1 }, state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "fixture.txt" }] } }] } satisfies SessionMessageAssistant]],
  ])
  messages.get(rootSession.id as string)!.push({ type: "assistant", id: "fixture-task", agent: "build", model: { id: "fixture-model", providerID: "fixture" }, content: [{ type: "tool", id: "call-task", name: "task", time: { created: now, completed: now + 1 }, state: { status: "completed", input: { description: "Inspect workspace", subagent_type: "explore" }, content: [{ type: "text", text: "Delegated to fixture-child" }], metadata: { sessionId: child.id, parentSessionId: rootSession.id } } }], time: { created: now, completed: now + 1 } } satisfies SessionMessageAssistant)
  messages.get(rootSession.id as string)!.push({ type: "shell", id: "fixture-shell", shellID: "fixture-shell-1", command: "printf fixture", status: "exited", exit: 0, output: { output: "fixture\n", cursor: 8, size: 8, truncated: false }, time: { created: now, completed: now + 1 } } satisfies SessionMessageShell)
  questions = [{ id: "fixture-question-1", sessionID: child.id, questions: [{ question: "Continue the child task?", header: "Continue", options: [{ label: "Yes", description: "Continue" }, { label: "No", description: "Stop" }], multiple: false }], tool: { messageID: "fixture-child-assistant", id: "call-child" } }]
  permissions = []
  forms = []
  eventSequence = 0
  messageSequence = 1
  formSequence = 0
}
reset()

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } })
const empty = (status = 204) => new Response(null, { status })
async function body(request: Request): Promise<Json> { try { return await request.json() as Json } catch { return {} } }
function location() { return { directory: root, project } }
function id(path: string, marker: string) { return decodeURIComponent(path.split(`/api/session/`)[1].split(`/`)[0]) }
function questionForm(sessionID: string, messageID: string): Json {
  formSequence += 1
  return {
    id: `fixture-form-${formSequence}`,
    sessionID,
    title: "Questions",
    metadata: { kind: "question", tool: { messageID, id: `call-form-${formSequence}` } },
    fields: [
      { key: "q0", title: "Deploy target", description: "Which environment should receive the deploy?", type: "string", options: [{ value: "Staging", label: "Staging", description: "Deploy to staging first" }, { value: "Production", label: "Production", description: "Ship to production" }], custom: true },
      { key: "q1", title: "Regions", description: "Which regions should be notified?", type: "multiselect", options: [{ value: "EU", label: "EU", description: "Europe" }, { value: "US", label: "US", description: "United States" }], custom: true },
    ],
  }
}
function emit(type: string, data: Json) {
  const event = JSON.stringify({ id: `fixture-event-${++eventSequence}`, created: Date.now(), type, data })
  for (const client of clients) client.controller.enqueue(client.encoder.encode(`data: ${event}\n\n`))
}

async function handle(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization")
  if (auth !== "Basic " + btoa("opencode:devpassword")) return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": "Basic realm=opencode" } })
  const url = new URL(request.url)
  const path = url.pathname
  if (path === "/health" || path === "/api/health") return json({ healthy: true, version: "2.0.0-fixture", pid: 1 })
  if (path === "/fixture/status") return json({ ready: true, sessions: sessions.length, questions: questions.length, permissions: permissions.length, forms: forms.length })
  if (path === "/fixture/reset" && request.method === "POST") { reset(); emit("server.connected", {}); return json({ reset: true }) }
  if (path === "/api/event") {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { const client = { controller, encoder: new TextEncoder() }; clients.add(client); controller.enqueue(client.encoder.encode(`data: ${JSON.stringify({ id: "fixture-connected", created: Date.now(), type: "server.connected", data: {} })}\n\n`)); request.signal.addEventListener("abort", () => { clients.delete(client); try { controller.close() } catch {} }) }, cancel() {} })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } })
  }
  if (path === "/api/location") return json(location())
  if (path === "/api/project") return json([{ id: project.id, canonical: root, name: "Fixture project", vcs: "git", time: { created: now, updated: now }, sandboxes: [] }])
  if (path === "/api/project/current") return json({ id: project.id, worktree: root, directory: root, canonical: root, name: "Fixture project" })
  if (path === "/api/agent") return json({ location: location(), data: agents })
  if (path === "/api/command") return json({ location: location(), data: [{ name: "review", description: "Review fixture", template: "Review {{args}}", hints: [] }] })
  if (path === "/api/model") return json({ location: location(), data: models })
  if (path === "/api/model/known") return json({ location: location(), data: models })
  if (path === "/api/model/default") return json({ location: location(), data: models[0] })
  if (path === "/api/provider") return json({ location: location(), data: [{ ...provider, models: Object.fromEntries(models.map((item) => [item.id, item])) }] })
  if (path === "/api/config") return json([{ type: "document", path: "opencode.json", info: { model: "fixture/fixture-model", default_agent: "build" } }])
  if (path === "/api/vcs") return json({ location: location(), data: { branch: { current: "fixture" } } })
  if (path === "/api/vcs/status") return json({ location: location(), data: [] })
  if (path === "/api/vcs/diff") return json({ location: location(), data: "" })
  if (path === "/api/permission/request") return json({ data: permissions })
  if (path === "/api/question/request") return json({ data: questions })
  if (path === "/api/form/request") return json({ location: location(), data: forms })
  if (path === "/api/session/active") return json({ data: {} })
  if (path === "/api/session" && request.method === "GET") {
    const parentID = url.searchParams.get("parentID")
    const filtered = parentID === null ? sessions : sessions.filter((item) => parentID === "" || parentID === "null" ? !item.parentID : item.parentID === parentID)
    return json({ data: filtered, cursor: {} })
  }
  if (path === "/api/session" && request.method === "POST") { const input = await body(request); const created = session(`fixture-created-${sessions.length}`, (input.title as string) || "Fixture session"); sessions.unshift(created); messages.set(created.id, []); emit("session.created", { sessionID: created.id, projectID: project.id, location: created.location, parentID: created.parentID, slug: created.id, title: created.title, agent: created.agent, model: created.model, version: "2" }); return json({ data: created }) }
  if (path.startsWith("/api/message")) { const sid = url.searchParams.get("sessionID") || ""; return json({ data: messages.get(sid) || [], cursor: {} }) }
  if (path.startsWith("/api/session/")) return sessionRoute(request, path)
  return json({ error: "fixture route not found", path }, 404)
}

async function sessionRoute(request: Request, path: string): Promise<Response> {
  const sid = id(path, "/api/session/")
  const current = sessions.find((item) => item.id === sid)
  if (!current) return json({ error: "session not found" }, 404)
  const rest = path.slice(`/api/session/${encodeURIComponent(sid)}`.length)
  if (rest === "" && request.method === "GET") return json({ data: current })
  if (rest === "" && request.method === "DELETE") { sessions = sessions.filter((item) => item.id !== sid); emit("session.deleted", { sessionID: sid }); return empty() }
  if (rest === "/message" && request.method === "GET") return json({ data: messages.get(sid) || [], cursor: {} })
  const input = await body(request)
  if (rest === "/rename") { current.title = input.title; emit("session.renamed", { sessionID: sid, title: input.title }); return empty() }
  if (rest === "/agent") { current.agent = input.agent; emit("session.agent.selected", { sessionID: sid, agent: input.agent }); return empty() }
  if (rest === "/model") { current.model = input.model; emit("session.model.selected", { sessionID: sid, model: input.model }); return empty() }
  if (rest === "/interrupt") { emit("session.execution.interrupted", { sessionID: sid }); return empty() }
  if (rest === "/prompt" || rest === "/command") {
    const prompt = (input.id as Json | undefined) ?? input
    const text = rest === "/prompt" ? String(prompt.text || "") : `/${input.command} ${input.arguments || ""}`.trim()
    const messageID = ++messageSequence
    const userID = `fixture-user-${messageID}`
    const assistantID = `fixture-assistant-${messageID}`
    const streamingStressTest = text.toLowerCase() === "fixture:stream-stress"
    const formQuestion = text.toLowerCase() === "fixture:form-question"
    const toolStressTest = text.toLowerCase() === "fixture:tool-stress"
    const chunks = streamingStressTest
      ? Array.from({ length: 1_200 }, (_, index) => `${index % 12 === 0 ? `\n\n### Stream block ${index / 12 + 1}\n\n` : ""}Responsive streaming fixture text ${index}. \`inline code\` remains readable.\n`)
      : ["Fixture reply"]
    const reply = streamingStressTest ? chunks.join("") : `Fixture reply to: ${text}`

    // A several-KB write input streamed as ~2,000 deltas plus a progress burst
    // — the "busy run" shape that used to stall the UI with per-delta store
    // writes and mid-run canonical refreshes.
    const toolStressPayload = JSON.stringify({
      filePath: "/fixture/workspace/stress.txt",
      content: Array.from({ length: 64 }, (_, index) => `tool stress line ${index + 1}: ${"y".repeat(96)}`).join("\n"),
    })
    const toolStressChunks = Array.from({ length: 2_000 }, (_, index) => toolStressPayload.slice(index * 4, index * 4 + 4))

    messages.get(sid)!.push(user(userID, sid, text), toolStressTest
      ? {
          type: "assistant",
          id: assistantID,
          agent: "build",
          model: { providerID: "fixture", id: "fixture-model" },
          content: [{ type: "tool", id: "call-tool-stress", name: "write", time: { created: now, completed: now + 1 }, state: { status: "completed", input: JSON.parse(toolStressPayload), content: [{ type: "text", text: `wrote ${toolStressPayload.length} bytes` }] } }],
          time: { created: now, completed: now + 1 },
        }
      : assistant(assistantID, reply))
    if (formQuestion) {
      const form = questionForm(sid, assistantID)
      forms.push(form)
      emit("form.created", { form })
    }
    emit("session.execution.started", { sessionID: sid })
    emit("session.step.started", { sessionID: sid, assistantMessageID: assistantID, agent: "build", model: { providerID: "fixture", id: "fixture-model" } })

    if (toolStressTest) {
      emit("session.tool.input.started", { sessionID: sid, assistantMessageID: assistantID, id: "call-tool-stress", name: "write" })
      let deltaIndex = 0
      const toolInterval = setInterval(() => {
        for (let burst = 0; burst < 10 && deltaIndex < toolStressChunks.length; burst++) {
          emit("session.tool.input.delta", { sessionID: sid, assistantMessageID: assistantID, id: "call-tool-stress", delta: toolStressChunks[deltaIndex++] })
        }
        if (deltaIndex < toolStressChunks.length) return
        clearInterval(toolInterval)
        emit("session.tool.called", { sessionID: sid, assistantMessageID: assistantID, id: "call-tool-stress", input: JSON.parse(toolStressPayload), metadata: { tool: "write" } })
        for (let index = 0; index < 50; index++) emit("session.tool.progress", { sessionID: sid, assistantMessageID: assistantID, id: "call-tool-stress", metadata: { stage: index } })
        emit("session.tool.success", { sessionID: sid, assistantMessageID: assistantID, id: "call-tool-stress", content: [{ type: "text", text: `wrote ${toolStressPayload.length} bytes` }] })
        emit("session.step.ended", { sessionID: sid, assistantMessageID: assistantID })
        emit("session.execution.succeeded", { sessionID: sid })
      }, 2)
      return json({ data: user(userID, sid, text) })
    }

    emit("session.text.started", { sessionID: sid, assistantMessageID: assistantID, ordinal: 0 })

    let index = 0
    const interval = setInterval(() => {
      emit("session.text.delta", { sessionID: sid, assistantMessageID: assistantID, ordinal: 0, delta: chunks[index++] })
      if (index < chunks.length) return
      clearInterval(interval)
      emit("session.text.ended", { sessionID: sid, assistantMessageID: assistantID, ordinal: 0, text: reply })
      emit("session.execution.succeeded", { sessionID: sid })
    }, streamingStressTest ? 10 : 25)
    return json({ data: user(userID, sid, text) })
  }
  if (rest === "/revert/stage" || rest === "/revert/clear" || rest === "/revert/commit") return rest === "/revert/stage" ? json({ messageID: input.messageID }) : empty()
  if (rest.startsWith("/permission/") && rest.endsWith("/reply")) { const requestID = rest.split("/")[2]; permissions = permissions.filter((item) => item.id !== requestID); emit("permission.replied", { sessionID: sid, requestID, reply: input.reply }); return empty() }
  if (rest.startsWith("/question/") && (rest.endsWith("/reply") || rest.endsWith("/reject"))) { const requestID = rest.split("/")[2]; questions = questions.filter((item) => item.id !== requestID); emit(rest.endsWith("reply") ? "question.replied" : "question.rejected", { sessionID: sid, requestID, answers: input.answers }); return empty() }
  if (rest === "/form" && request.method === "GET") return json({ data: forms.filter((item) => item.sessionID === sid) })
  if (rest.startsWith("/form/") && (rest.endsWith("/reply") || rest.endsWith("/cancel"))) {
    const [, , formID, action] = rest.split("/")
    if (!forms.some((item) => item.id === formID)) return json({ error: "form not found" }, 404)
    forms = forms.filter((item) => item.id !== formID)
    if (action === "reply") emit("form.replied", { id: formID, sessionID: sid, answer: input.answer })
    else emit("form.cancelled", { id: formID, sessionID: sid })
    return empty()
  }
  if (rest === "/delete") { sessions = sessions.filter((item) => item.id !== sid); emit("session.deleted", { sessionID: sid }); return empty() }
  return empty()
}

const args = process.argv.slice(2)
const port = Number(args[args.indexOf("--port") + 1] || process.env.PORT || 4100)
const hostname = process.env.OPENCODE_FIXTURE_HOST || "127.0.0.1"
Bun.serve({ port, hostname, fetch: handle })
console.log(`OpenCode v2 fixture ready at http://${hostname}:${port} (opencode/devpassword)`)
