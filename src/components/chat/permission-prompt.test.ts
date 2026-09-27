import assert from "node:assert/strict"
import test from "node:test"
import { permissionReplyPhaseAfter, permissionReplySucceeded, restoreFailedPermission } from "./permission-prompt"

test("a failed reply returns the prompt to idle so the buttons recover", () => {
  assert.equal(permissionReplyPhaseAfter("sending", false), "idle")
  assert.equal(permissionReplyPhaseAfter("sending", true), "done")
  // A prompt that already succeeded or is idle is not changed by a late result.
  assert.equal(permissionReplyPhaseAfter("done", false), "done")
  assert.equal(permissionReplyPhaseAfter("idle", false), "idle")
})

test("onReply handlers may resolve nothing; only explicit false is failure", () => {
  assert.equal(permissionReplySucceeded(undefined), true)
  assert.equal(permissionReplySucceeded(true), true)
  assert.equal(permissionReplySucceeded(false), false)
})

test("failed reply rollback merges the request back without replacing the bucket", () => {
  const failed = { id: "perm-1", permission: "bash", patterns: ["ls"] }
  const other = { id: "perm-2", permission: "edit", patterns: ["a.ts"] }
  // Requests resolved while the reply was in flight survive, and the failed
  // request is appended rather than resurrecting a stale snapshot.
  assert.deepEqual(restoreFailedPermission([other], failed), [other, failed])
  // Already restored by SSE or a refresh — no duplicate.
  assert.equal(restoreFailedPermission([other, failed], failed), null)
  // Nothing to restore.
  assert.equal(restoreFailedPermission([other], undefined), null)
  // Empty/absent bucket still restores.
  assert.deepEqual(restoreFailedPermission(undefined, failed), [failed])
})
