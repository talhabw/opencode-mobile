import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { isComposerSessionReady, sameComposerDraft } from "./session-composer"

const dir = path.dirname(fileURLToPath(import.meta.url))
const sessionScreen = readFileSync(path.join(dir, "../../../app/session/[id].tsx"), "utf8")

test("composer is ready only when the store is bound to this screen's session", () => {
  assert.equal(isComposerSessionReady("s1", "s1", false), true)
  // Cold load: the store still points at the previously selected session.
  assert.equal(isComposerSessionReady("s2", "s1", true), false)
  // Failed load: no fetch is running, but the store never switched.
  assert.equal(isComposerSessionReady("s2", "s1", false), false)
  // Another selection started while this screen is still bound to s1.
  assert.equal(isComposerSessionReady("s1", "s1", true), false)
  // Missing route param.
  assert.equal(isComposerSessionReady(undefined, "s1", false), false)
})

test("draft snapshots compare text and attachment uris", () => {
  const base = { text: "hello", attachments: [{ uri: "file://a" }] }
  assert.equal(sameComposerDraft(base, { text: "hello", attachments: [{ uri: "file://a" }] }), true)
  assert.equal(sameComposerDraft(base, { text: "hello there", attachments: [{ uri: "file://a" }] }), false)
  assert.equal(sameComposerDraft(base, { text: "hello", attachments: [] }), false)
  assert.equal(sameComposerDraft(base, { text: "hello", attachments: [{ uri: "file://a" }, { uri: "file://b" }] }), false)
  assert.equal(sameComposerDraft(base, { text: "hello", attachments: [{ uri: "file://b" }] }), false)
})

// The screen's behavior cannot be driven without a device, so the wiring of
// these guards is asserted against the source (same approach as the other
// *.regression.test.ts files in this directory).
test("session screen gates sends and per-session state on the route binding", () => {
  assert.match(sessionScreen, /isComposerSessionReady\(routeSessionID/)
  assert.match(sessionScreen, /if \(!routeSessionID \|\| !composerReady\)/)
  assert.match(sessionScreen, /const sessionID = routeSessionID/)
  assert.doesNotMatch(sessionScreen, /const sessionID = currentSession\?\.id/)
  assert.match(sessionScreen, /sessionUnavailable/)
})

test("edit and undo results never overwrite a draft typed while they were in flight", () => {
  assert.match(sessionScreen, /sameComposerDraft\(draftAtStart, composerDraftRef\.current\)/)
  assert.doesNotMatch(sessionScreen, /setInput\(text\)/)
})

test("permission failure restores only the failed request and lets buttons recover", () => {
  assert.match(sessionScreen, /restoreFailedPermission\(state\.permissions\[sessionID\], request\)/)
  assert.doesNotMatch(sessionScreen, /\[sessionID\]: snapshot/)
  assert.match(sessionScreen, /handlePermissionReply\(perm\.id, reply\)/)
})

test("/new returns to the sessions list even without one in the stack", () => {
  assert.match(sessionScreen, /router\.dismissTo\("\/"\)/)
  assert.doesNotMatch(sessionScreen, /router\.back\(\)/)
})
