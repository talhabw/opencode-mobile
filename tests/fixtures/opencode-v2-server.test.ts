import assert from "node:assert/strict"
import test from "node:test"
import { mock } from "bun:test"
import { Schema } from "effect"
import * as LocationSchema from "@opencode/schema/location"
import * as ProjectSchema from "@opencode/schema/project"
import * as AgentSchema from "@opencode/schema/agent"
import * as CommandSchema from "@opencode/schema/command"
import * as ModelSchema from "@opencode/schema/model"
import * as ProviderSchema from "@opencode/schema/provider"
import * as ConfigSchema from "@opencode/schema/config"
import * as VcsSchema from "@opencode/schema/vcs"
import * as PermissionSchema from "@opencode/schema/permission"
import * as PermissionSavedSchema from "@opencode/schema/permission-saved"
import * as FormSchema from "@opencode/schema/form"
import * as SessionSchema from "@opencode/schema/session"
import * as SessionMessageSchema from "@opencode/schema/session-message"
import * as SessionInboxSchema from "@opencode/schema/session-inbox"
import * as FileSystemSchema from "@opencode/schema/filesystem"
import { Latest } from "@opencode/schema/event-manifest"
import { ServerInfo } from "@opencode/protocol/groups/server"
import {
  CommandNotFoundError,
  FileNotFoundError,
  FormNotFoundError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  PermissionNotFoundError,
  SessionNotFoundError,
  UnauthorizedError,
} from "@opencode/protocol/errors"
import { OpenCodeEvent } from "@opencode/protocol/groups/event"
import { OpenCode } from "@opencode/client"
import { fromQuestionForm, isQuestionForm, toFormAnswer } from "../../src/lib/question-inputs"
import { isSessionActuallyIdleFromNewestFirst } from "../../src/lib/session-status-reconcile"

// Expo's fetch module imports React Native internals under Bun; the production
// SDK still gets instantiated, with the platform fetch replaced for this test.
mock.module("expo/fetch", () => ({ fetch: globalThis.fetch }))
const { createClient, ApiAuthError, ApiError } = await import("../../src/lib/sdk")

type Json = Record<string, unknown>
const port = Number(process.env.OPENCODE_FIXTURE_TEST_PORT) || 42000 + process.pid % 20000
const base = `http://127.0.0.1:${port}`
const auth = { Authorization: `Basic ${Buffer.from("opencode:devpassword").toString("base64")}` }
const jsonHeaders = { ...auth, "content-type": "application/json" }
const client = createClient({ baseUrl: base, directory: "/fixture/workspace", auth: { username: "opencode", password: "devpassword" } })

const decode = <T,>(schema: unknown, value: unknown, label?: string): T => {
  try {
    return Schema.decodeUnknownSync(schema as never)(value as never) as T
  } catch (error) {
    throw new Error(`${label ?? "payload"}: ${String(error).split("\n").slice(0, 6).join(" | ")}`)
  }
}
const decodeLocation = (value: unknown) => decode<LocationSchema.PublicInfo>(LocationSchema.PublicInfo, value, "location")
const decodeSessions = (value: unknown) => decode<Array<SessionSchema.Info>>(Schema.Array(SessionSchema.Info), value, "sessions")
const decodeMessages = (value: unknown) => decode<Array<SessionMessageSchema.Info>>(Schema.Array(SessionMessageSchema.Info), value, "messages")
const decodeForms = (value: unknown) => decode<Array<FormSchema.Info>>(Schema.Array(FormSchema.Info), value, "forms")
const decodeSavedPermissions = (value: unknown) => decode<Array<PermissionSavedSchema.Info>>(Schema.Array(PermissionSavedSchema.Info), value, "saved permissions")
const decodeFileEntries = (value: unknown) => decode<Array<FileSystemSchema.Entry>>(Schema.Array(FileSystemSchema.Entry), value, "file entries")

async function start() {
  const server = Bun.spawn(["bun", "tests/fixtures/opencode-v2-server.ts", "--port", String(port)], { stdout: "pipe", stderr: "pipe" })
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      if ((await fetch(`${base}/health`, { headers: auth })).ok) return server
    } catch {}
    await Bun.sleep(25)
  }
  server.kill()
  throw new Error("fixture server did not become ready")
}

async function eventually<T>(probe: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    last = await probe()
    if (predicate(last)) return last
    await Bun.sleep(20)
  }
  throw new Error(`condition not met in time: ${JSON.stringify(last)}`)
}

const raw = async (target: string, path: string): Promise<Json> => {
  const response = await fetch(`${target}${path}`, { headers: auth })
  assert.equal(response.ok, true, `${path} -> ${response.status}`)
  return response.json() as Promise<Json>
}
const status = async (target: string, path: string, init: RequestInit = {}) =>
  (await fetch(`${target}${path}`, { headers: auth, ...init })).status

// Released generated client (@opencode/client), created fresh per server.
const generated = (target: string) => OpenCode.make({
  baseUrl: target,
  headers: auth,
})

// Raw SSE reader: the exact bytes the fixture writes, decoded per data frame.
async function* eventStream(target: string, signal: AbortSignal): AsyncGenerator<Json> {
  const response = await fetch(`${target}/api/event`, { headers: auth, signal })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const line = frame.split("\n").find((item) => item.startsWith("data: "))
        if (line) yield JSON.parse(line.slice("data: ".length)) as Json
      }
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }
}

// Official durability for an event type, from the released event manifest.
const durability = (type: string) => {
  const definition = Latest.get(type)
  return definition?.durability === "durable" ? definition.durable.version : undefined
}

test("released fixture serves every payload through the released schemas", async (context) => {
  const process = await start()
  context.after(() => process.kill())

  // server.info replaces the removed ServiceHealth probe.
  const info = await raw(base, "/api/info")
  decode<ServerInfo>(ServerInfo, info, "GET /api/info")
  assert.deepEqual(Object.keys(info).sort(), ["paths", "pid", "urls", "version"])
  assert.equal(info.version, "2.0.0-fixture")
  assert.equal(typeof info.pid, "number")
  assert.deepEqual(info.urls, [base])
  assert.deepEqual(info.paths, { tmp: "/tmp" })
  assert.equal(await status(base, "/api/health"), 404)

  decodeLocation(await raw(base, "/api/location"))
  decode<Array<ProjectSchema.Info>>(Schema.Array(ProjectSchema.Info), await raw(base, "/api/project"), "projects")
  decode<Array<AgentSchema.Info>>(Schema.Array(AgentSchema.Info), ((await raw(base, "/api/agent")) as { data: unknown }).data, "agents")
  decode<Array<CommandSchema.Info>>(Schema.Array(CommandSchema.Info), ((await raw(base, "/api/command")) as { data: unknown }).data, "commands")
  decode<Array<ModelSchema.Info>>(Schema.Array(ModelSchema.Info), ((await raw(base, "/api/model")) as { data: unknown }).data, "models")
  decode<ModelSchema.Info>(ModelSchema.Info, ((await raw(base, "/api/model/default")) as { data: unknown }).data, "default model")
  decode<Array<ProviderSchema.Info>>(Schema.Array(ProviderSchema.Info), ((await raw(base, "/api/provider")) as { data: unknown }).data, "providers")
  decode<Array<ConfigSchema.Entry>>(Schema.Array(ConfigSchema.Entry), await raw(base, "/api/config"), "config")
  decode<VcsSchema.Info>(VcsSchema.Info, ((await raw(base, "/api/vcs")) as { data: unknown }).data, "vcs")
  decode<Array<VcsSchema.FileStatus>>(Schema.Array(VcsSchema.FileStatus), ((await raw(base, "/api/vcs/status")) as { data: unknown }).data, "vcs status")
  decode<Array<PermissionSchema.Request>>(Schema.Array(PermissionSchema.Request), ((await raw(base, "/api/permission/request")) as { data: unknown }).data, "permissions")
  decodeSavedPermissions(((await raw(base, "/api/permission/saved")) as { data: unknown }).data)

  const formList = await raw(base, "/api/form?location%5Bdirectory%5D=%2Ffixture%2Fworkspace")
  assert.deepEqual(Object.keys(formList).sort(), ["data", "location"])
  assert.deepEqual(formList.location, { directory: "/fixture/workspace" })
  decodeForms(formList.data)
  assert.deepEqual((await raw(base, "/api/form?location%5Bdirectory%5D=%2Ffixture%2Fother")).data, [])

  decodeSessions(((await raw(base, "/api/session?directory=%2Ffixture%2Fworkspace")) as { data: unknown }).data)
  decodeMessages(((await raw(base, "/api/session/ses_fixture_root/message?order=asc")) as { data: unknown }).data)
  decodeForms(((await raw(base, "/api/session/ses_fixture_child/form")) as { data: unknown }).data)

  // Mutation envelopes: prompt returns Session.Inbox.User, revert/stage
  // returns {data: Session.Revert}, interrupt returns {interrupted}, and the
  // command/form/permission replies are 204 No Content.
  const prompt = await fetch(`${base}/api/session/ses_fixture_root/prompt`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ text: "schema probe" }) })
  assert.equal(prompt.status, 200)
  const inboxRaw = ((await prompt.json()) as { data: Json }).data
  decode<SessionInboxSchema.User>(SessionInboxSchema.User, inboxRaw, "prompt echo")
  assert.deepEqual(Object.keys(inboxRaw).sort(), ["delivery", "id", "payload", "sessionID", "time", "type"])
  assert.equal(typeof (inboxRaw.time as { created?: unknown }).created, "number")

  const stage = await fetch(`${base}/api/session/ses_fixture_root/revert/stage`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ messageID: "msg_fixture_user_1" }) })
  assert.equal(stage.status, 200)
  decode<{ data: SessionSchema.Revert }>(Schema.Struct({ data: SessionSchema.Revert }), await stage.json(), "revert stage")
  assert.equal(await status(base, "/api/session/ses_fixture_root/revert", { method: "DELETE" }), 204)

  const interrupt = await fetch(`${base}/api/session/ses_fixture_root/interrupt`, { method: "POST", headers: auth })
  assert.equal(interrupt.status, 200)
  decode<{ interrupted: boolean }>(Schema.Struct({ interrupted: Schema.Boolean }), await interrupt.json(), "interrupt")

  const command = await fetch(`${base}/api/session/ses_fixture_root/command`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ name: "review", text: "fixture.txt" }) })
  assert.equal(command.status, 204)

  // Removed beta surfaces are absent: /api/health, /api/project/current,
  // session.rename, session.revert.clear, session.form.cancel, form.request.list.
  const removed = [
    { method: "GET", path: "/api/project/current" },
    { method: "POST", path: "/api/session/ses_fixture_root/rename", body: { title: "Beta rename" } },
    { method: "POST", path: "/api/session/ses_fixture_root/revert/clear" },
    { method: "POST", path: "/api/session/ses_fixture_child/form/frm_fixture_1/cancel" },
    { method: "GET", path: "/api/form/request?location%5Bdirectory%5D=%2Ffixture%2Fworkspace" },
  ]
  for (const plan of removed) {
    const response = await fetch(`${base}${plan.path}`, {
      method: plan.method,
      headers: plan.body === undefined ? auth : jsonHeaders,
      body: plan.body === undefined ? undefined : JSON.stringify(plan.body),
    })
    assert.equal(response.status, 404, `${plan.method} ${plan.path}`)
  }

  // The released bodies are required on the wire, rejected as the declared
  // tagged InvalidRequestError.
  const betaCommand = await fetch(`${base}/api/session/ses_fixture_root/command`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ command: "review", text: "fixture.txt" }) })
  assert.equal(betaCommand.status, 400)
  const betaCommandBody = (await betaCommand.json()) as Json
  decode(InvalidRequestError, betaCommandBody, "beta command body")
  assert.equal(betaCommandBody._tag, "InvalidRequestError")
  const betaReply = await fetch(`${base}/api/session/ses_fixture_child/permission/per_fixture_1/reply`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ reply: "once" }) })
  assert.equal(betaReply.status, 400)
  const betaReplyBody = (await betaReply.json()) as Json
  decode(InvalidRequestError, betaReplyBody, "beta reply body")
  assert.equal(betaReplyBody._tag, "InvalidRequestError")
  assert.equal(await status(base, "/api/session/ses_fixture_root/interrupt?resume=maybe", { method: "POST" }), 400)

  // session.form.cancel uses DELETE and removes the form.
  assert.equal(await status(base, "/api/session/ses_fixture_child/form/frm_fixture_1", { method: "DELETE" }), 204)
  assert.deepEqual(((await raw(base, "/api/form?location%5Bdirectory%5D=%2Ffixture%2Fworkspace")) as { data: unknown[] }).data, [])

  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
  const fixtureStatus = await raw(base, "/fixture/status")
  assert.equal(fixtureStatus.ready, true)
  assert.equal("protocol" in fixtureStatus, false)
})

test("released generated client drives the fixture end to end", async (context) => {
  const process = await start()
  context.after(() => process.kill())
  const api = generated(base)

  assert.equal((await api.server.info()).version, "2.0.0-fixture")
  const location = await api.location.get({ location: { directory: "/fixture/workspace" } })
  assert.equal(location.directory, "/fixture/workspace")
  assert.equal(location.project.id, "fixture-project")
  assert.equal((await api.project.list())[0]?.id, "fixture-project")
  assert.equal((await api.agent.list({ location: { directory: "/fixture/workspace" } })).data.length, 3)
  assert.equal((await api.command.list({ location: { directory: "/fixture/workspace" } })).data[0]?.name, "review")
  assert.equal((await api.model.list({ location: { directory: "/fixture/workspace" } })).data[0]?.modelID, "fixture-model")
  assert.equal((await api.model.default({ location: { directory: "/fixture/workspace" } })).data?.modelID, "fixture-model")
  assert.equal((await api.provider.list({ location: { directory: "/fixture/workspace" } })).data[0]?.id, "fixture")
  assert.equal((await api.config.get({ location: { directory: "/fixture/workspace" } }))[0]?.info.default_agent, "build")
  assert.equal((await api.vcs.get({ location: { directory: "/fixture/workspace" } })).data.branch.current, "fixture")
  assert.deepEqual((await api.vcs.status({ location: { directory: "/fixture/workspace" } })).data, [])
  assert.deepEqual((await api.vcs.diff({ location: { directory: "/fixture/workspace" }, mode: "working" })).data, [])
  assert.deepEqual(await api.permission.request.list({ location: { directory: "/fixture/workspace" } }), {
    location: { directory: "/fixture/workspace" },
    data: [{
      id: "per_fixture_1",
      sessionID: "ses_fixture_child",
      action: "shell",
      resources: ["git status"],
      save: ["git status"],
      message: "Inspect the child workspace",
      source: { type: "tool", messageID: "msg_fixture_child_assistant", id: "call-child" },
    }],
  })

  // Sessions: create, update (rename), list scopes, messages, active, delete.
  const created = await api.session.create({ title: "Created by generated client", location: { directory: "/fixture/workspace" } })
  assert.equal((await api.session.get({ sessionID: created.id })).title, "Created by generated client")
  assert.equal((await api.session.get({ sessionID: created.id })).location.directory, "/fixture/workspace")
  await api.session.update({ sessionID: "ses_fixture_root", title: "Released rename" })
  assert.equal((await api.session.get({ sessionID: "ses_fixture_root" })).title, "Released rename")
  assert.deepEqual((await api.session.list({ directory: "/fixture/workspace" })).data.map((item) => item.id).sort(), ["ses_fixture_child", "ses_fixture_root", created.id].sort())
  // Without a directory the list spans every workspace; with one it is exact
  // location.directory match ("ses_fixture_other" lives in /fixture/other).
  assert.deepEqual((await api.session.list({ parentID: null })).data.map((item) => item.id), [created.id, "ses_fixture_root", "ses_fixture_other"])
  assert.deepEqual((await api.session.list({ directory: "/fixture/workspace", parentID: null })).data.map((item) => item.id), [created.id, "ses_fixture_root"])
  assert.deepEqual((await api.session.list({ parentID: "ses_fixture_root" })).data.map((item) => item.id), ["ses_fixture_child"])

  const messages = await api.message.list({ sessionID: "ses_fixture_root", order: "asc", limit: 200 })
  assert.ok(messages.data.length >= 4)
  const shell = messages.data.find((message) => message.id === "msg_fixture_shell")
  assert.equal(shell?.type, "shell")
  const task = messages.data.flatMap((message) => message.type === "assistant" ? message.content : []).find((content) => content.type === "tool" && content.name === "task")
  assert.deepEqual(task?.state.metadata, { sessionId: "ses_fixture_child", parentSessionId: "ses_fixture_root" })
  assert.deepEqual(await api.session.active(), {})

  await api.session.switchAgent({ sessionID: "ses_fixture_root", agent: "plan" })
  await api.session.switchModel({ sessionID: "ses_fixture_root", model: { providerID: "fixture", id: "fixture-model", variant: "deep" } })
  const echo = await api.session.prompt({ sessionID: "ses_fixture_root", text: "generated client ping" })
  assert.equal(echo.type, "user")
  assert.equal(typeof echo.time.created, "number")
  assert.deepEqual(await api.session.interrupt({ sessionID: "ses_fixture_root", resume: true }), { interrupted: true })
  assert.deepEqual(await api.session.interrupt({ sessionID: "ses_fixture_root", resume: true }), { interrupted: false })

  await api.session.revert.stage({ sessionID: "ses_fixture_root", messageID: "msg_fixture_user_1" })
  assert.equal((await api.session.get({ sessionID: "ses_fixture_root" })).revert?.messageID, "msg_fixture_user_1")
  await api.session.revert.clear({ sessionID: "ses_fixture_root" })
  assert.equal((await api.session.get({ sessionID: "ses_fixture_root" })).revert, undefined)

  await api.session.command({ sessionID: "ses_fixture_root", name: "review", text: "fixture.txt" })
  await eventually(
    () => api.message.list({ sessionID: "ses_fixture_root", order: "asc", limit: 200 }),
    (page) => page.data.some((message) => message.type === "user" && message.text === "/review fixture.txt"),
  )

  const forms = await api.form.list({ location: { directory: "/fixture/workspace" } })
  assert.equal(forms.data.length, 1)
  assert.equal(isQuestionForm(forms.data[0]), true)
  assert.deepEqual(await api.session.form.list({ sessionID: "ses_fixture_child" }), forms.data)
  await api.session.form.cancel({ sessionID: "ses_fixture_child", formID: forms.data[0].id })
  assert.deepEqual((await api.form.list({ location: { directory: "/fixture/workspace" } })).data, [])

  await api.permission.reply({ sessionID: "ses_fixture_child", requestID: "per_fixture_1", decision: "always" })
  assert.deepEqual((await api.permission.request.list({ location: { directory: "/fixture/workspace" } })).data, [])
  // Replying always persisted the request's save pattern as a project grant.
  const savedByReply = await api.permission.saved.list({ projectID: "fixture-project" })
  decodeSavedPermissions(savedByReply)
  assert.equal(savedByReply.some((item) => item.action === "shell" && item.resource === "git status"), true)

  await api.session.remove({ sessionID: created.id })
  assert.equal(await status(base, `/api/session/${created.id}`), 404)

  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
})

test("released fixture serves the synthetic filesystem through the released schemas", async (context) => {
  const process = await start()
  context.after(() => process.kill())
  const api = generated(base)

  // fs.list: directories first with trailing slashes, paths relative to the
  // requested location, and only the documented {location, data} envelope.
  const rootList = await api.file.list({ location: { directory: "/fixture/workspace" }, path: "." })
  assert.deepEqual(Object.keys(rootList).sort(), ["data", "location"])
  assert.equal(rootList.location.directory, "/fixture/workspace")
  decodeFileEntries(rootList.data)
  assert.deepEqual(rootList.data, [
    { path: "docs/", type: "directory" },
    { path: "empty/", type: "directory" },
    { path: "src/", type: "directory" },
    { path: "opencode.json", type: "file" },
    { path: "README.md", type: "file" },
  ])

  // The location normalizes a trailing slash, and the target accepts relative
  // and absolute paths as documented by the released OpenAPI.
  const srcList = await api.file.list({ location: { directory: "/fixture/workspace/" }, path: "src" })
  assert.equal(srcList.location.directory, "/fixture/workspace")
  assert.deepEqual(srcList.data, [
    { path: "src/lib/", type: "directory" },
    { path: "src/index.ts", type: "file" },
  ])
  const absolute = await api.file.list({ location: { directory: "/fixture/workspace" }, path: "/fixture/workspace/docs" })
  assert.deepEqual(absolute.data, [{ path: "docs/guide.md", type: "file" }])
  const sibling = await api.file.list({ location: { directory: "/fixture/workspace" }, path: "/fixture/other" })
  assert.deepEqual(sibling.data, [{ path: "../other/notes.md", type: "file" }])

  // Empty directories list empty; the parent chain used by the browser's
  // up-navigation is synthetic as well.
  assert.deepEqual((await api.file.list({ location: { directory: "/fixture/workspace" }, path: "empty" })).data, [])
  assert.deepEqual((await api.file.list({ location: { directory: "/fixture/workspace" }, path: "src/lib/deep" })).data, [])
  assert.deepEqual((await api.file.list({ location: { directory: "/fixture" } })).data, [
    { path: "other/", type: "directory" },
    { path: "workspace/", type: "directory" },
  ])
  assert.deepEqual((await api.file.list({ location: { directory: "/" } })).data, [{ path: "fixture/", type: "directory" }])

  // Only the synthetic tree resolves: host paths and files are rejected with
  // the tagged InvalidRequestError the released fs contract declares.
  for (const request of ["/api/fs/list?location%5Bdirectory%5D=%2Ffixture%2Fworkspace&path=missing", "/api/fs/list?location%5Bdirectory%5D=%2Ffixture%2Fworkspace&path=README.md", "/api/fs/list?location%5Bdirectory%5D=%2Fetc"]) {
    const response = await fetch(`${base}${request}`, { headers: auth })
    assert.equal(response.status, 400, request)
    const rejected = (await response.json()) as Json
    decode(InvalidRequestError, rejected, `GET ${request}`)
    assert.equal(rejected._tag, "InvalidRequestError")
  }

  // fs.find: deterministic ranking, type filtering, and the default/limit cap.
  const found = await api.file.find({ location: { directory: "/fixture/workspace" }, query: "utils" })
  assert.equal(found.location.directory, "/fixture/workspace")
  decodeFileEntries(found.data)
  assert.deepEqual(found.data, [{ path: "src/lib/utils.ts", type: "file" }])
  const directoryMatches = await api.file.find({ location: { directory: "/fixture/workspace" }, query: "lib", type: "directory" })
  assert.deepEqual(directoryMatches.data, [
    { path: "src/lib/", type: "directory" },
    { path: "src/lib/deep/", type: "directory" },
  ])
  assert.deepEqual((await api.file.find({ location: { directory: "/fixture/workspace" }, query: "notes" })).data, [])
  assert.equal((await api.file.find({ location: { directory: "/fixture/workspace" }, query: "i", limit: 1 })).data.length, 1)
  const noQuery = await fetch(`${base}/api/fs/find?location%5Bdirectory%5D=%2Ffixture%2Fworkspace`, { headers: auth })
  assert.equal(noQuery.status, 400)
  decode(InvalidRequestError, await noQuery.json(), "fs.find 400")

  // fs.read: raw bytes relative to the location; missing files, directories,
  // and cross-location reads are the declared FileNotFoundError.
  const readme = new TextDecoder().decode(await api.file.read({ location: { directory: "/fixture/workspace" }, path: "README.md" }))
  assert.equal(readme, "# Fixture workspace\n\nSynthetic files served by the released-contract v2 fixture.\n")
  const config = JSON.parse(new TextDecoder().decode(await api.file.read({ location: { directory: "/fixture/workspace" }, path: "opencode.json" }))) as { default_agent?: string }
  assert.equal(config.default_agent, "build")
  const missingRead = await fetch(`${base}/api/fs/read/nope.txt?location%5Bdirectory%5D=%2Ffixture%2Fworkspace`, { headers: auth })
  assert.equal(missingRead.status, 404)
  const missingBody = (await missingRead.json()) as Json
  decode(FileNotFoundError, missingBody, "fs.read 404")
  assert.deepEqual(missingBody, { _tag: "FileNotFoundError", path: "nope.txt", message: "File not found: nope.txt" })
  for (const path of ["nope.txt", "src", "/fixture/other/notes.md"]) {
    await assert.rejects(
      api.file.read({ location: { directory: "/fixture/workspace" }, path }),
      (error: { name?: string }) => error.name === "FileNotFoundError",
      path,
    )
  }

  // The fs routes sit behind the same Basic auth as every other API route.
  assert.equal((await fetch(`${base}/api/fs/list`)).status, 401)
  assert.equal((await fetch(`${base}/api/fs/read/README.md`)).status, 401)

  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
})

test("app client navigates the synthetic fixture filesystem root, child, and empty paths", async (context) => {
  const process = await start()
  context.after(() => process.kill())

  // Root: the directory browser keeps only directory entries and re-roots
  // their relative paths against the connection directory.
  const root = await client.file.list()
  decodeFileEntries(root.map((entry) => ({ path: entry.path, type: entry.type })))
  assert.deepEqual(root.filter((entry) => entry.type === "directory").map((entry) => [entry.name, entry.absolute]), [
    ["docs", "/fixture/workspace/docs/"],
    ["empty", "/fixture/workspace/empty/"],
    ["src", "/fixture/workspace/src/"],
  ])
  assert.equal(root.some((entry) => entry.path === "README.md" && entry.absolute === "/fixture/workspace/README.md" && entry.ignored === false), true)

  // Each entry's absolute path (with the directory's trailing slash) is fed
  // straight back into a directory-scoped client, exactly like the sheet's
  // enter() — the flow that surfaced the fs.list 404 on the emulator.
  const openDirectory = async (absolute: string) => {
    const scoped = createClient({ baseUrl: base, directory: absolute, auth: { username: "opencode", password: "devpassword" } })
    return (await scoped.file.list()).filter((entry) => entry.type === "directory")
  }
  const src = await openDirectory("/fixture/workspace/src/")
  assert.deepEqual(src.map((entry) => entry.name), ["lib"])
  const lib = await openDirectory(src[0].absolute)
  assert.deepEqual(lib.map((entry) => entry.name), ["deep"])
  await assert.deepEqual(await openDirectory(lib[0].absolute), [])

  // Files surface through the same synthetic tree via find and read.
  const matches = await client.file.find("guide")
  decodeFileEntries(matches)
  assert.deepEqual(matches, [{ path: "docs/guide.md", type: "file" }])
  assert.equal((new TextDecoder().decode(await client.file.read("README.md"))).startsWith("# Fixture workspace"), true)
  const config = JSON.parse(new TextDecoder().decode(await client.file.read("opencode.json"))) as { default_agent?: string }
  assert.equal(config.default_agent, "build")

  // Wrong credentials still fail at the fs boundary.
  const bad = createClient({ baseUrl: base, directory: "/fixture/workspace", auth: { username: "opencode", password: "wrong" } })
  await assert.rejects(bad.file.list(), (error: unknown) => error instanceof ApiAuthError)

  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
})

test("released fixture emits only official v2 events with manifest durability", { timeout: 30_000 }, async (context) => {
  const process = await start()
  context.after(() => process.kill())

  const controller = new AbortController()
  context.after(() => controller.abort())
  const collected: Array<Json & { type?: string; durable?: { version: number } }> = []
  const failures: string[] = []
  const streamDone = (async () => {
    try {
      for await (const event of eventStream(base, controller.signal)) {
        collected.push(event)
        try {
          decode(OpenCodeEvent, event, event.type as string)
        } catch (error) {
          failures.push(String(error).split("\n").slice(0, 2).join(" | "))
        }
      }
    } catch {}
  })()

  const eventuallyIdle = (count: number) => eventually(
    () => Promise.resolve(collected.filter((event) => event.type === "session.idle").length),
    (idles) => idles >= count,
    5_000,
  )
  await client.session.prompt("ses_fixture_root", { parts: [{ type: "text", text: "ping" }] })
  await eventuallyIdle(1)
  await client.session.command("ses_fixture_root", { command: "review", arguments: "all" })
  await eventuallyIdle(2)
  await client.session.prompt("ses_fixture_child", { parts: [{ type: "text", text: "fixture:form-question" }] })
  await eventuallyIdle(3)
  await client.session.prompt("ses_fixture_child", { parts: [{ type: "text", text: "fixture:permission" }] })
  await eventuallyIdle(4)
  await client.session.prompt("ses_fixture_root", { parts: [{ type: "text", text: "fixture:stream-stress" }] })
  await eventually(() => client.session.active(), (active) => "ses_fixture_root" in active)
  await client.session.interrupt("ses_fixture_root")
  await eventuallyIdle(5)
  await client.session.revert("ses_fixture_root", "msg_fixture_user_1")
  await client.session.clearRevert("ses_fixture_root")
  await client.session.prompt("ses_fixture_root", { parts: [{ type: "text", text: "fixture:tool-stress" }] })
  await eventuallyIdle(6)
  const sessionToDelete = (await client.session.create({ title: "Delete me" })).id
  await client.session.delete(sessionToDelete)
  await eventually(() => Promise.resolve(collected.some((event) => event.type === "session.deleted")), Boolean)

  controller.abort()
  await streamDone

  assert.deepEqual(failures, [])
  const types = new Set(collected.map((event) => event.type))
  for (const expected of ["server.connected", "session.created", "session.status", "session.idle", "session.execution.started", "session.execution.succeeded", "session.execution.interrupted", "session.step.started", "session.step.ended", "session.text.started", "session.text.delta", "session.text.ended", "session.tool.input.started", "session.tool.input.delta", "session.tool.called", "session.tool.progress", "session.tool.success", "session.revert.staged", "session.revert.cleared", "form.created", "permission.asked", "session.deleted"]) {
    assert.equal(types.has(expected), true, `missing event type ${expected}`)
  }
  assert.equal(collected.every((event) => String(event.id).startsWith("evt_fixture_")), true)

  // Durable envelopes and versions come straight from the released manifest;
  // ephemeral types must not carry one.
  for (const event of collected) {
    const expected = durability(event.type!)
    const durable = event.durable as { aggregateID: string; seq: number; version: number } | undefined
    if (expected === undefined) {
      assert.equal(durable, undefined, `${event.type} must be ephemeral`)
      continue
    }
    assert.equal(durable?.version, expected, `${event.type} durable version`)
    assert.equal(durable?.aggregateID, (event.data as Json).sessionID, `${event.type} durable aggregate`)
    assert.equal(typeof durable?.seq, "number")
  }
  assert.equal((collected.find((event) => event.type === "session.tool.success")?.durable as { version: number }).version, 2)
  assert.equal((collected.find((event) => event.type === "session.deleted")?.durable as { version: number }).version, 2)
  assert.equal(collected.find((event) => event.type === "session.text.delta")?.durable, undefined)

  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
})

test("released fixture streams a tool input storm that accumulates and resolves canonically", async (context) => {
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

  await client.session.prompt("ses_fixture_root", { parts: [{ type: "text", text: "fixture:tool-stress" }] })
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
  assert.equal(collected.some((event) => event.type === "session.status"), true)
  assert.equal(collected[collected.length - 1]?.type, "session.status")

  // The canonical page shows the persisted completed tool call.
  const messages = await client.session.messages("ses_fixture_root")
  const tool = messages.flatMap((message) => message.parts).find((part) => part.callID === "call-tool-stress")
  assert.deepEqual(tool?.state?.input, JSON.parse(payload))
  assert.equal(tool?.state?.output, `wrote ${payload.length} bytes`)

  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
})

test("released fixture exposes the forms-based question surface end to end", async (context) => {
  const process = await start()
  context.after(() => process.kill())
  const waitFor = async (match: (event: { type: string }) => boolean) => {
    for await (const event of client.global.events()) if (match(event)) return event
    throw new Error("event stream ended before match")
  }

  // Pending question inputs are seeded and recovered exclusively through the
  // forms surface.
  const seeded = await client.form.requestList()
  assert.equal(seeded.length, 1)
  await client.form.cancel({ sessionID: "ses_fixture_child", formID: seeded[0].id })
  assert.deepEqual(await client.form.requestList(), [])

  const created = waitFor((event) => event.type === "form.created")
  await client.session.prompt("ses_fixture_child", { parts: [{ type: "text", text: "fixture:form-question" }] })
  const createdEvent = await created
  const form = createdEvent.properties.form as { id?: string; sessionID?: string; metadata?: { kind?: string } }
  assert.equal(form.sessionID, "ses_fixture_child")
  assert.equal(form.metadata?.kind, "question")

  const listed = await client.form.requestList()
  assert.equal(listed.length, 1)
  assert.equal(isQuestionForm(listed[0]), true)
  assert.deepEqual(await client.form.list("ses_fixture_child"), listed)
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
  await client.form.reply({ sessionID: "ses_fixture_child", formID, answer })
  assert.deepEqual((await replied).properties, { id: formID, sessionID: "ses_fixture_child", answer })
  assert.deepEqual(await client.form.requestList(), [])

  const cancelled = waitFor((event) => event.type === "form.cancelled")
  await client.session.prompt("ses_fixture_child", { parts: [{ type: "text", text: "fixture:form-question" }] })
  const second = (await client.form.requestList())[0]
  await client.form.cancel({ sessionID: "ses_fixture_child", formID: second.id })
  assert.deepEqual((await cancelled).properties, { id: second.id, sessionID: "ses_fixture_child" })
  assert.deepEqual(await client.form.requestList(), [])

  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
  assert.equal((await client.form.requestList()).length, 1)
})

test("released fixture reproduces the healthy-but-idle SSE reconnect", async (context) => {
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

test("released fixture honors official pagination for sessions and messages", async (context) => {
  const process = await start()
  context.after(() => process.kill())

  const createdTitles = ["Pagination one", "Pagination two", "Pagination three"]
  for (const title of createdTitles) await client.session.create({ title })

  // Sessions: newest first, two per page, cursors link the windows.
  const firstPage = await client.session.page({ order: "desc", limit: 2 })
  assert.deepEqual(firstPage.data.map((item) => item.title), ["Pagination three", "Pagination two"])
  assert.equal(typeof firstPage.cursor.next, "string")
  assert.equal(firstPage.cursor.previous, undefined)
  const secondPage = await client.session.page({ cursor: firstPage.cursor.next!, limit: 2 })
  assert.deepEqual(secondPage.data.map((item) => item.title), ["Pagination one", "Fixture root session"])
  assert.equal(typeof secondPage.cursor.previous, "string")
  assert.equal(typeof secondPage.cursor.next, "string")
  const thirdPage = await client.session.page({ cursor: secondPage.cursor.next!, limit: 2 })
  assert.deepEqual(thirdPage.data.map((item) => item.title), ["Fixture child task"])
  assert.equal(thirdPage.cursor.next, undefined)
  // Search filters by title substring.
  assert.deepEqual((await client.session.list({ search: "pagination two" })).map((item) => item.title), ["Pagination two"])

  // Messages: the app asks for newest first with limit + cursor, then follows
  // cursor.next for older pages. Paginated order must round-trip exactly.
  const idle = eventually(() => client.session.active(), (active) => !("ses_fixture_root" in active))
  await client.session.prompt("ses_fixture_root", { parts: [{ type: "text", text: "page one" }] })
  await idle
  const full = (await client.session.messagePage("ses_fixture_root", { limit: 200, order: "asc" })).data.map((item) => item.info.id)
  assert.ok(full.length >= 6)
  const descending: string[] = []
  let cursor: string | undefined
  let guard = 0
  do {
    const page = await client.session.messagePage("ses_fixture_root", { limit: 2, order: cursor ? undefined : "desc", cursor })
    descending.push(...page.data.map((item) => item.info.id))
    cursor = page.cursor.next ?? undefined
    guard += 1
  } while (cursor && guard < 20)
  assert.equal(cursor, undefined)
  assert.deepEqual(descending, [...full].reverse())

  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
})

test("released fixture command and interrupt complete the app lifecycle", async (context) => {
  const process = await start()
  context.after(() => process.kill())

  const controller = new AbortController()
  context.after(() => controller.abort())
  const events = client.global.events(controller.signal)
  const seen: Array<{ type: string }> = []
  const collector = (async () => {
    for await (const event of events) seen.push(event)
  })()
  const waitFor = async (match: (event: { type: string }) => boolean) => {
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      const found = seen.find(match)
      if (found) return found
      await Bun.sleep(20)
    }
    throw new Error(`event never arrived: ${JSON.stringify(seen.slice(-5))}`)
  }

  // session.command succeeds with 204 (the generated client rejects anything
  // else) and still streams the canonical command transcript.
  await client.session.command("ses_fixture_root", { command: "review", arguments: "fixture.txt" })
  await waitFor((event) => event.type === "session.status")
  await eventually(() => client.session.messages("ses_fixture_root"), (messages) => messages.some((message) => message.parts.some((part) => part.text === "Fixture command reply: /review fixture.txt")))
  const commandMessages = await client.session.messages("ses_fixture_root")
  assert.equal(commandMessages.flatMap((message) => message.parts).some((part) => part.text === "/review fixture.txt"), true)

  // session.interrupt returns {interrupted} and stops the run without further streaming.
  await client.session.prompt("ses_fixture_root", { parts: [{ type: "text", text: "fixture:stream-stress" }] })
  await eventually(() => client.session.active(), (active) => "ses_fixture_root" in active)
  await Bun.sleep(100)
  const interrupt = await client.session.interrupt("ses_fixture_root")
  assert.deepEqual(interrupt, { interrupted: true })
  assert.deepEqual(await client.session.interrupt("ses_fixture_root"), { interrupted: false })
  await eventually(() => client.session.active(), (active) => !("ses_fixture_root" in active))
  seen.length = 0
  await Bun.sleep(250)
  assert.equal(seen.some((event) => event.type === "message.part.updated"), false)
  assert.equal(seen.some((event) => event.type === "session.status" && (event as { properties?: { status?: { type?: string } } }).properties?.status?.type === "busy"), false)

  collector.catch(() => {})
  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
})

test("released fixture surfaces permission.asked and permission.replied", async (context) => {
  const process = await start()
  context.after(() => process.kill())

  const events = client.global.events()
  const asked = (async () => {
    for await (const event of events) if (event.type === "permission.asked") return event
    throw new Error("permission.asked never arrived")
  })()
  await client.session.prompt("ses_fixture_child", { parts: [{ type: "text", text: "fixture:permission" }] })
  const event = await asked
  assert.equal(event.properties.sessionID, "ses_fixture_child")
  assert.equal(event.properties.permission, "shell")
  assert.deepEqual(event.properties.patterns, ["git status"])
  assert.deepEqual(event.properties.tool, { messageID: "msg_fixture_assistant_2", callID: "call-permission-2" })

  const pending = await client.permission.list()
  const raised = pending.find((item) => item.id === "per_fixture_2")
  assert.ok(raised)
  assert.equal(await client.permission.reply("per_fixture_2", "once", "ses_fixture_child"), true)
  assert.equal((await client.permission.list()).some((item) => item.id === "per_fixture_2"), false)

  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
})

test("released fixture serves saved permissions with project filtering and always persistence", async (context) => {
  const process = await start()
  context.after(() => process.kill())
  const api = generated(base)

  // Raw envelope: {data} only (no location wrapper), every entry decodes
  // against PermissionSaved.Info (branded psv_ ID, Project.ID, DateTimeUtc).
  const all = await raw(base, "/api/permission/saved")
  assert.deepEqual(Object.keys(all).sort(), ["data"])
  decodeSavedPermissions(all.data)
  assert.deepEqual((all.data as Json[]).map((item) => [item.id, item.projectID, item.action, item.resource]), [
    ["psv_fixture_1", "fixture-project", "webfetch", "https://example.com"],
    ["psv_fixture_2", "fixture-project", "shell", "git log"],
    ["psv_fixture_3", "fixture-other-project", "edit", "/fixture/other/notes.md"],
  ])
  for (const item of all.data as Json[]) assert.equal(typeof (item.time as Json).created, "number")

  // projectID filters exactly; an unknown project never leaks another's grants.
  const scoped = await raw(base, "/api/permission/saved?projectID=fixture-project")
  decodeSavedPermissions(scoped.data)
  assert.deepEqual((scoped.data as Json[]).map((item) => item.id), ["psv_fixture_1", "psv_fixture_2"])
  assert.deepEqual(((await raw(base, "/api/permission/saved?projectID=fixture-other-project")).data as Json[]).map((item) => item.id), ["psv_fixture_3"])
  assert.deepEqual((await raw(base, "/api/permission/saved?projectID=unknown-project")).data, [])

  // Generated client: optional filter on list, idempotent 204 remove.
  assert.deepEqual((await api.permission.saved.list()).map((item) => item.id), ["psv_fixture_1", "psv_fixture_2", "psv_fixture_3"])
  assert.deepEqual((await api.permission.saved.list({ projectID: "fixture-project" })).map((item) => item.id), ["psv_fixture_1", "psv_fixture_2"])
  await api.permission.saved.remove({ id: "psv_fixture_2" })
  assert.deepEqual((await api.permission.saved.list({ projectID: "fixture-project" })).map((item) => item.id), ["psv_fixture_1"])
  await api.permission.saved.remove({ id: "psv_fixture_unknown" })
  assert.equal((await api.permission.saved.list()).length, 2)

  // "Always" persists exactly request.save (not resources), scoped to the
  // session's project and deduplicated per (projectID, action, resource).
  await api.permission.reply({ sessionID: "ses_fixture_child", requestID: "per_fixture_1", decision: "always" })
  const persisted = await api.permission.saved.list({ projectID: "fixture-project" })
  decodeSavedPermissions(persisted)
  assert.deepEqual(persisted.map((item) => [item.id, item.action, item.resource]), [
    ["psv_fixture_1", "webfetch", "https://example.com"],
    ["psv_fixture_4", "shell", "git status"],
  ])

  const raise = async (text = "fixture:permission") => {
    await api.session.prompt({ sessionID: "ses_fixture_child", text })
    return eventually(
      () => api.permission.request.list({ location: { directory: "/fixture/workspace" } }),
      (page) => page.data.length === 1,
    )
  }
  // Repeating an approval for the same grant does not duplicate it.
  const duplicate = await raise()
  await api.permission.reply({ sessionID: "ses_fixture_child", requestID: duplicate.data[0].id, decision: "always" })
  assert.equal((await api.permission.saved.list({ projectID: "fixture-project" })).length, 2)
  // once and reject persist nothing at all.
  const once = await raise()
  await api.permission.reply({ sessionID: "ses_fixture_child", requestID: once.data[0].id, decision: "once" })
  const reject = await raise()
  await api.permission.reply({ sessionID: "ses_fixture_child", requestID: reject.data[0].id, decision: "reject" })
  assert.equal((await api.permission.saved.list({ projectID: "fixture-project" })).length, 2)

  // `save` decides what is remembered: resources that are not proposed for
  // saving (git log) never persist, while a save-only pattern (git diff) does.
  const subset = await raise("fixture:permission-save")
  assert.deepEqual(subset.data[0].resources, ["git status", "git log"])
  assert.deepEqual(subset.data[0].save, ["git status", "git diff"])
  await api.permission.reply({ sessionID: "ses_fixture_child", requestID: subset.data[0].id, decision: "always" })
  assert.deepEqual((await api.permission.saved.list({ projectID: "fixture-project" })).map((item) => [item.id, item.action, item.resource]), [
    ["psv_fixture_1", "webfetch", "https://example.com"],
    ["psv_fixture_4", "shell", "git status"],
    ["psv_fixture_5", "shell", "git diff"],
  ])

  // App client: the same list/remove surface the settings screen uses.
  const appSaved = await client.protocol.permission.saved.list({ projectID: "fixture-project" })
  decodeSavedPermissions(appSaved)
  assert.deepEqual(appSaved.map((item) => item.id), ["psv_fixture_1", "psv_fixture_4", "psv_fixture_5"])
  assert.equal(appSaved.some((item) => item.projectID !== "fixture-project"), false, "fixture-project list leaks another project")
  assert.deepEqual((await client.protocol.permission.saved.list({ projectID: "fixture-other-project" })).map((item) => item.id), ["psv_fixture_3"])
  await client.protocol.permission.saved.remove({ id: "psv_fixture_5" })
  assert.deepEqual((await client.protocol.permission.saved.list({ projectID: "fixture-project" })).map((item) => item.id), ["psv_fixture_1", "psv_fixture_4"])

  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
  assert.equal((await raw(base, "/api/permission/saved")).data.length, 3)
})

test("app client drives the released fixture end to end", async (context) => {
  const process = await start()
  context.after(() => process.kill())

  // /api/info supplies health directly; the removed /api/health is not used.
  assert.deepEqual(await client.global.health(), { healthy: true, version: "2.0.0-fixture" })
  const project = await client.project.current()
  assert.equal(project.id, "fixture-project")
  assert.equal(project.path?.absolute, "/fixture/workspace")
  assert.equal((await client.agent.list()).length, 3)
  assert.equal((await client.command.list())[0]?.name, "review")
  assert.equal((await client.model.list())[0]?.modelID, "fixture-model")
  assert.equal((await client.model.default())?.modelID, "fixture-model")
  assert.equal((await client.provider.list()).all[0]?.id, "fixture")
  assert.equal((await client.config.get())[0]?.info.default_agent, "build")
  assert.equal((await client.vcs.get()).branch.current, "fixture")
  assert.deepEqual(await client.vcs.status(), [])
  assert.deepEqual(await client.vcs.diff(), [])
  assert.deepEqual(await client.permission.list(), [{
    id: "per_fixture_1",
    sessionID: "ses_fixture_child",
    action: "shell",
    resources: ["git status"],
    save: ["git status"],
    message: "Inspect the child workspace",
    source: { type: "tool", messageID: "msg_fixture_child_assistant", id: "call-child" },
    tool: { messageID: "msg_fixture_child_assistant", callID: "call-child" },
    permission: "shell",
    patterns: ["git status"],
  }])
  assert.deepEqual(await client.session.active(), {})

  const all = await client.session.page()
  assert.deepEqual(all.data.map((item) => item.id).sort(), ["ses_fixture_child", "ses_fixture_root"])
  assert.deepEqual((await client.session.page({ parentID: null })).data.map((item) => item.id), ["ses_fixture_root"])
  assert.deepEqual((await client.session.list({ parentID: "ses_fixture_root" })).map((item) => item.id), ["ses_fixture_child"])
  const created = await client.session.create({ title: "Created by app client" })
  assert.equal((await client.session.get(created.id)).title, "Created by app client")
  assert.equal((await client.session.get(created.id)).directory, "/fixture/workspace")
  const rootMessages = await client.session.messages("ses_fixture_root")
  assert.ok(rootMessages.length >= 4)
  const shell = rootMessages.find((message) => message.info.id === "msg_fixture_shell")
  assert.equal(shell?.info.presentation, "shell")
  assert.equal(shell?.info.shell?.shellID, "sh_fixture_1")
  assert.equal(shell?.info.shell?.output?.truncated, false)
  const task = rootMessages.flatMap((message) => message.parts).find((part) => part.tool === "task")
  assert.deepEqual(task?.state?.metadata, { sessionId: "ses_fixture_child", parentSessionId: "ses_fixture_root" })
  const instructions = rootMessages.find((message) => message.info.id === "msg_fixture_instructions")
  assert.equal(instructions?.info.systemKind, "system")
  assert.ok((instructions?.parts[0]?.text?.length ?? 0) > 1_000)

  const events = client.global.events()
  const eventPromise = (async () => {
    for await (const event of events) {
      if (event.type === "session.status" && event.properties.status.type === "idle") return event
    }
  })()
  await client.session.switchAgent("ses_fixture_root", "plan")
  await client.session.switchModel("ses_fixture_root", { providerID: "fixture", modelID: "fixture-model", variant: "deep" })
  await client.session.prompt("ses_fixture_root", { parts: [{ type: "text", text: "ping" }] })
  assert.equal((await eventPromise)?.type, "session.status")
  const updated = await client.session.messages("ses_fixture_root")
  assert.equal(new Set(updated.map((message) => message.info.id)).size, updated.length)

  // Rename and revert-clear go through the documented released routes.
  assert.equal((await client.session.rename("ses_fixture_root", "App released rename")).title, "App released rename")
  await client.session.revert("ses_fixture_root", "msg_fixture_user_1")
  assert.equal((await client.session.get("ses_fixture_root")).revert?.messageID, "msg_fixture_user_1")
  assert.equal((await client.session.clearRevert("ses_fixture_root")).revert, undefined)

  // Command uses the {name, text} body and still streams the transcript.
  await client.session.command("ses_fixture_root", { command: "review", arguments: "fixture.txt" })
  await eventually(
    () => client.session.messages("ses_fixture_root"),
    (messages) => messages.some((message) => message.parts.some((part) => part.text === "Fixture command reply: /review fixture.txt")),
  )

  // Forms are listed through GET /api/form and cancelled through DELETE.
  const forms = await client.form.requestList()
  assert.equal(forms.length, 1)
  assert.equal(isQuestionForm(forms[0]), true)
  await client.form.cancel({ sessionID: "ses_fixture_child", formID: forms[0].id })
  assert.deepEqual(await client.form.requestList(), [])

  // Permission replies use {decision}; "always" persists request.save.
  assert.equal(await client.permission.reply("per_fixture_1", "always", "ses_fixture_child"), true)
  assert.equal((await client.permission.list()).length, 0)
  const savedAfterAlways = await client.protocol.permission.saved.list({ projectID: "fixture-project" })
  decodeSavedPermissions(savedAfterAlways)
  assert.equal(savedAfterAlways.some((item) => item.action === "shell" && item.resource === "git status"), true)

  // Interrupt uses ?resume= and stops the simulated run.
  await client.session.prompt("ses_fixture_root", { parts: [{ type: "text", text: "fixture:stream-stress" }] })
  await eventually(() => client.session.active(), (active) => "ses_fixture_root" in active)
  assert.deepEqual(await client.session.interrupt("ses_fixture_root", true), { interrupted: true })
  assert.deepEqual(await client.session.interrupt("ses_fixture_root"), { interrupted: false })
  await eventually(() => client.session.active(), (active) => !("ses_fixture_root" in active))

  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
})

test("released fixture serves the declared tagged errors for 400/404 and Basic auth", async (context) => {
  const process = await start()
  context.after(() => process.kill())
  const api = generated(base)

  // Every /api route, declared or not, sits behind the same Basic auth and
  // answers the released tagged UnauthorizedError plus the challenge header.
  for (const path of ["/api/info", "/api/definitely-not-a-route", "/api/session/ses_missing"]) {
    const response = await fetch(`${base}${path}`)
    assert.equal(response.status, 401, path)
    assert.equal(response.headers.get("www-authenticate"), 'Basic realm="Secure Area"', path)
    const body = (await response.json()) as Json
    decode(UnauthorizedError, body, `GET ${path}`)
    assert.deepEqual(body, { _tag: "UnauthorizedError", message: "Authentication required" })
  }
  const wrong = createClient({ baseUrl: base, directory: "/fixture/workspace", auth: { username: "opencode", password: "wrong" } })
  await assert.rejects(wrong.session.page(), (error: unknown) => error instanceof ApiAuthError && error.status === 401)

  // Undeclared routes are the released empty 404, including unknown session
  // subroutes.
  const unknown = await fetch(`${base}/api/definitely-not-a-route`, { headers: auth })
  assert.equal(unknown.status, 404)
  assert.equal(await unknown.text(), "")
  const unknownSubroute = await fetch(`${base}/api/session/ses_fixture_root/nonsense`, { method: "POST", headers: jsonHeaders, body: "{}" })
  assert.equal(unknownSubroute.status, 404)
  assert.equal(await unknownSubroute.text(), "")

  // SessionNotFoundError on every session-scoped route, branded id included.
  for (const plan of [
    { method: "GET", path: "/api/session/ses_missing" },
    { method: "PATCH", path: "/api/session/ses_missing", body: { title: "x" } },
    { method: "DELETE", path: "/api/session/ses_missing" },
    { method: "GET", path: "/api/session/ses_missing/message" },
    { method: "GET", path: "/api/session/ses_missing/form" },
    { method: "POST", path: "/api/session/ses_missing/prompt", body: { text: "hi" } },
    { method: "POST", path: "/api/session/ses_missing/interrupt" },
  ]) {
    const response = await fetch(`${base}${plan.path}`, {
      method: plan.method,
      headers: plan.body === undefined ? auth : jsonHeaders,
      body: plan.body === undefined ? undefined : JSON.stringify(plan.body),
    })
    assert.equal(response.status, 404, `${plan.method} ${plan.path}`)
    const body = (await response.json()) as Json
    decode(SessionNotFoundError, body, `${plan.method} ${plan.path}`)
    assert.deepEqual(body, { _tag: "SessionNotFoundError", sessionID: "ses_missing", message: "Session not found: ses_missing" })
  }
  // The generated client throws the declared class; the app wrapper maps the
  // same payload to its typed 404 ApiError.
  await assert.rejects(
    api.session.get({ sessionID: "ses_missing" }),
    (error: { name?: string }) => error.name === "SessionNotFoundError",
  )
  await assert.rejects(
    client.session.get("ses_missing"),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  )

  // MessageNotFoundError keeps both ids (the revert-stage path the app uses).
  const staged = await fetch(`${base}/api/session/ses_fixture_root/revert/stage`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ messageID: "msg_missing" }) })
  assert.equal(staged.status, 404)
  const messageBody = (await staged.json()) as Json
  decode(MessageNotFoundError, messageBody, "revert/stage 404")
  assert.deepEqual(messageBody, { _tag: "MessageNotFoundError", sessionID: "ses_fixture_root", messageID: "msg_missing", message: "Message not found: msg_missing" })

  // PermissionNotFoundError / FormNotFoundError / CommandNotFoundError.
  const permission = await fetch(`${base}/api/session/ses_fixture_child/permission/per_missing/reply`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ decision: "once" }) })
  assert.equal(permission.status, 404)
  const permissionBody = (await permission.json()) as Json
  decode(PermissionNotFoundError, permissionBody, "permission reply 404")
  assert.deepEqual(permissionBody, { _tag: "PermissionNotFoundError", requestID: "per_missing", message: "Permission request not found: per_missing" })
  const formReply = await fetch(`${base}/api/session/ses_fixture_child/form/frm_missing/reply`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ answer: { q0: "Staging" } }) })
  assert.equal(formReply.status, 404)
  assert.deepEqual(await formReply.json(), { _tag: "FormNotFoundError", id: "frm_missing", message: "Form not found: frm_missing" })
  const formCancel = await fetch(`${base}/api/session/ses_fixture_child/form/frm_missing`, { method: "DELETE", headers: auth })
  assert.equal(formCancel.status, 404)
  decode(FormNotFoundError, await formCancel.json(), "form cancel 404")
  const command = await fetch(`${base}/api/session/ses_fixture_root/command`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ name: "nope", text: "" }) })
  assert.equal(command.status, 404)
  const commandBody = (await command.json()) as Json
  decode(CommandNotFoundError, commandBody, "command 404")
  assert.deepEqual(commandBody, { _tag: "CommandNotFoundError", command: "nope", message: "Command not found: nope" })

  // InvalidRequestError: released decoding order matters — bodies are
  // validated before the requested permission/form is resolved — and every
  // payload carries the released `kind`.
  for (const plan of [
    { path: "/api/session/ses_fixture_child/permission/per_missing/reply", body: {} },
    { path: "/api/session/ses_fixture_child/permission/per_fixture_1/reply", body: { decision: "bogus" } },
    { path: "/api/session/ses_fixture_root/prompt", body: {} },
    { path: "/api/session/ses_fixture_root/prompt", body: { text: 123 } },
    { path: "/api/session/ses_fixture_root/command", body: { name: "review" } },
    { path: "/api/session/ses_fixture_root/agent", body: {} },
    { path: "/api/session/ses_fixture_root/model", body: {} },
    { path: "/api/session/ses_fixture_root/revert/stage", body: {} },
    { path: "/api/session/ses_fixture_child/form/frm_fixture_1/reply", body: {} },
    { path: "/api/session/ses_fixture_child/form/frm_fixture_1/reply", body: { answer: 1 } },
  ]) {
    const response = await fetch(`${base}${plan.path}`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(plan.body) })
    assert.equal(response.status, 400, plan.path)
    const body = (await response.json()) as Json
    decode(InvalidRequestError, body, plan.path)
    assert.equal(body._tag, "InvalidRequestError")
    assert.equal(body.kind, "Payload", plan.path)
  }
  const badTitle = await fetch(`${base}/api/session/ses_fixture_root`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ title: 123 }) })
  assert.equal(badTitle.status, 400)
  decode(InvalidRequestError, await badTitle.json(), "PATCH title 400")

  // Query validation: an undecodable cursor is InvalidCursorError, invalid
  // enums/integers are InvalidRequestError with kind "Query"; the session and
  // message lists declare different lower limits, exactly like the released
  // server.
  for (const plan of [
    { path: "/api/session?cursor=garbage" },
    { path: "/api/session?order=bogus" },
    { path: "/api/session?limit=abc" },
    { path: "/api/session?limit=0", message: 'Expected a value greater than 0\n  at ["limit"]' },
    { path: "/api/session/ses_fixture_root/message?cursor=garbage" },
    { path: "/api/session/ses_fixture_root/message?limit=abc" },
    { path: "/api/session/ses_fixture_root/message?limit=0", message: 'Expected a value greater than or equal to 1\n  at ["limit"]' },
  ]) {
    const response = await fetch(`${base}${plan.path}`, { headers: auth })
    assert.equal(response.status, 400, plan.path)
    const body = (await response.json()) as Json
    assert.equal(body._tag, plan.path.includes("cursor") ? "InvalidCursorError" : "InvalidRequestError", plan.path)
    if (body._tag === "InvalidCursorError") decode(InvalidCursorError, body, plan.path)
    else {
      decode(InvalidRequestError, body, plan.path)
      if (plan.message) assert.equal(body.message, plan.message, plan.path)
    }
  }
  const badResume = await fetch(`${base}/api/session/ses_fixture_root/interrupt?resume=maybe`, { method: "POST", headers: auth })
  assert.equal(badResume.status, 400)
  const badResumeBody = (await badResume.json()) as Json
  decode(InvalidRequestError, badResumeBody, "resume 400")
  assert.equal(badResumeBody.kind, "Query")

  // Malformed/absent bodies only fail on routes that declare a body; an
  // unbranded session id is a Params validation error before any lookup.
  const malformed = await fetch(`${base}/api/session/ses_fixture_root/prompt`, { method: "POST", headers: jsonHeaders, body: "{" })
  assert.equal(malformed.status, 400)
  assert.deepEqual(await malformed.json(), { _tag: "InvalidRequestError", message: "Expected a valid JSON body", kind: "Payload" })
  const noBody = await fetch(`${base}/api/session/ses_fixture_root/prompt`, { method: "POST", headers: jsonHeaders })
  assert.equal(noBody.status, 400)
  assert.deepEqual(await noBody.json(), { _tag: "InvalidRequestError", message: "Expected object", kind: "Payload" })
  assert.equal((await fetch(`${base}/api/session/ses_fixture_root/interrupt`, { method: "POST", headers: auth })).status, 200)
  const unbranded = await fetch(`${base}/api/session/notases`, { headers: auth })
  assert.equal(unbranded.status, 400)
  const unbrandedBody = (await unbranded.json()) as Json
  decode(InvalidRequestError, unbrandedBody, "unbranded session id")
  assert.equal(unbrandedBody.kind, "Params")

  // The generated client surfaces the declared classes for 400s too.
  await assert.rejects(
    api.session.list({ order: "bogus" as never }),
    (error: { name?: string }) => error.name === "InvalidRequestError",
  )
  await assert.rejects(
    client.file.list({ path: "missing" }),
    (error: { name?: string }) => error.name === "InvalidRequestError",
  )

  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
})

test("released fixture records canonical idle rows after completion and interruption", async (context) => {
  const process = await start()
  context.after(() => process.kill())
  const api = generated(base)

  const settle = async (sessionID: string, run: () => Promise<unknown>) => {
    await run()
    await eventually(() => api.session.active(), (active) => !(sessionID in active), 5_000)
  }

  // Completion appends the released Session.Message.Idle row after the
  // assistant reply: the newest message, outcome "succeeded".
  await settle("ses_fixture_root", () => api.session.prompt({ sessionID: "ses_fixture_root", text: "idle row completion" }))
  const newest = await api.message.list({ sessionID: "ses_fixture_root", order: "desc", limit: 3 })
  const idleRaw = newest.data[0]
  assert.equal(idleRaw.type, "idle")
  if (idleRaw.type === "idle") assert.equal(typeof idleRaw.time.created, "number")
  const idle = decode<SessionMessageSchema.Idle>(SessionMessageSchema.Idle, idleRaw, "idle row")
  assert.equal(idle.type, "idle")
  assert.equal(idle.outcome, "succeeded")
  const completed = newest.data[1]
  assert.equal(completed.type, "assistant")
  if (completed.type === "assistant") assert.equal(typeof completed.time.completed, "number")
  // Ascending pages end on the same marker: it is the canonical tail.
  const ascending = await api.message.list({ sessionID: "ses_fixture_root", order: "asc", limit: 200 })
  assert.deepEqual(ascending.data.at(-1), newest.data[0])

  // Interruption finalizes the turn with outcome "interrupted".
  await client.session.prompt("ses_fixture_root", { parts: [{ type: "text", text: "fixture:stream-stress" }] })
  await eventually(() => api.session.active(), (active) => "ses_fixture_root" in active, 5_000)
  assert.deepEqual(await client.session.interrupt("ses_fixture_root"), { interrupted: true })
  await eventually(() => api.session.active(), (active) => !("ses_fixture_root" in active), 5_000)
  const interrupted = await api.message.list({ sessionID: "ses_fixture_root", order: "desc", limit: 2 })
  const marker = decode<SessionMessageSchema.Idle>(SessionMessageSchema.Idle, interrupted.data[0], "interrupted idle row")
  assert.equal(marker.outcome, "interrupted")
  // The assistant turn it closes is finalized, which is the terminal evidence
  // the reconnect resync keys on behind the marker.
  const aborted = interrupted.data[1]
  assert.equal(aborted.type, "assistant")
  if (aborted.type === "assistant") assert.equal(typeof aborted.time.completed, "number")

  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
})

test("released idle marker settles the app reconnect resync", async (context) => {
  const process = await start()
  context.after(() => process.kill())
  const api = generated(base)

  await api.session.prompt({ sessionID: "ses_fixture_root", text: "reconnect resync probe" })
  await eventually(() => api.session.active(), (active) => !("ses_fixture_root" in active), 5_000)

  // The released server appends the canonical idle row when the run settles,
  // so it is the head of the newest-first page the app's reconnect resync
  // fetches. The resync must decide "settled" from this page: the released
  // marker is the settle signal, and the finalized assistant reply behind it
  // carries time.completed. This is the end-to-end half of the helper unit
  // tests in src/lib/session-status-reconcile.test.ts.
  const page = await client.session.messagePage("ses_fixture_root", { limit: 1, order: "desc" })
  assert.equal(isSessionActuallyIdleFromNewestFirst(page.data.map((item) => item.info)), true)

  // A run interrupted while the stream was down settles the same way: the
  // canonical marker carries outcome "interrupted" and must also read as idle.
  await client.session.prompt("ses_fixture_root", { parts: [{ type: "text", text: "fixture:stream-stress" }] })
  await eventually(() => api.session.active(), (active) => "ses_fixture_root" in active, 5_000)
  assert.deepEqual(await client.session.interrupt("ses_fixture_root"), { interrupted: true })
  await eventually(() => api.session.active(), (active) => !("ses_fixture_root" in active), 5_000)
  const interruptedPage = await client.session.messagePage("ses_fixture_root", { limit: 1, order: "desc" })
  assert.equal(interruptedPage.data[0].info.systemKind, "idle")
  assert.equal(isSessionActuallyIdleFromNewestFirst(interruptedPage.data.map((item) => item.info)), true)

  const reset = await fetch(`${base}/fixture/reset`, { method: "POST", headers: auth })
  assert.equal(reset.status, 200)
})
