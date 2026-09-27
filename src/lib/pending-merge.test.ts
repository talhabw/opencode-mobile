import assert from "node:assert/strict"
import test from "node:test"
import {
  mergePendingBuckets,
  pruneResolved,
  reconcilePendingSource,
  replacePendingSessions,
  type PendingItem,
} from "./pending-merge.ts"

interface Req extends PendingItem {
  label: string
}

const req = (id: string, sessionID = "ses_1", label = id): Req => ({ id, sessionID, label })
const idsFor = (buckets: Record<string, Req[]>, sessionID: string): string[] => (buckets[sessionID] ?? []).map((item) => item.id)

test("an SSE request arriving during a fetch is not overwritten by an older snapshot", () => {
  const before = { ses_1: [req("a"), req("b")] }
  // The server snapshot was computed before the SSE form.created for "c".
  const snapshot = [req("a"), req("b")]
  // By the time the fetch resolves, the stream has delivered "c".
  const current = { ses_1: [req("a"), req("b"), req("c")] }
  const buckets = mergePendingBuckets({ snapshot, before, current, resolved: new Set() })
  // Old behavior replaced the bucket with the snapshot and silently dropped
  // "c"; the merge keeps it.
  assert.deepEqual(idsFor(buckets, "ses_1"), ["a", "b", "c"])
})

test("a request pending before the fetch that the snapshot no longer lists is dropped", () => {
  const before = { ses_1: [req("a"), req("b")] }
  const snapshot = [req("a")] // "b" was settled server-side while offline
  const current = { ses_1: [req("a"), req("b")] } // local state never heard
  const buckets = mergePendingBuckets({ snapshot, before, current, resolved: new Set() })
  assert.deepEqual(idsFor(buckets, "ses_1"), ["a"])
})

test("an optimistically resolved request is not resurrected by a stale snapshot", () => {
  const before = { ses_1: [req("q_1")] }
  const current = { ses_1: [] } // user replied; optimistically removed
  const resolved = new Set(["q_1"])
  const snapshot = [req("q_1")] // server hasn't processed the reply yet
  const buckets = mergePendingBuckets({ snapshot, before, current, resolved })
  assert.deepEqual(idsFor(buckets, "ses_1"), [])
})

test("buckets stay session-scoped while preserving mid-fetch arrivals", () => {
  const before = { ses_1: [req("a", "ses_1")], ses_2: [req("x", "ses_2")] }
  const current = { ses_1: [req("a", "ses_1"), req("b", "ses_1")], ses_2: [req("x", "ses_2")] }
  const snapshot = [req("a", "ses_1"), req("x", "ses_2")]
  const buckets = mergePendingBuckets({ snapshot, before, current, resolved: new Set() })
  assert.deepEqual(idsFor(buckets, "ses_1"), ["a", "b"])
  assert.deepEqual(idsFor(buckets, "ses_2"), ["x"])
})

test("a failed source yields null so the caller leaves that bucket untouched", () => {
  const result = reconcilePendingSource({
    fetched: null,
    before: { ses_1: [req("q_1")] },
    current: { ses_1: [req("q_1")] },
    resolved: new Set(),
  })
  assert.equal(result, null)
})

test("a successful source still reconciles its own buckets when another source fails", () => {
  const before = { ses_1: [req("perm_1")] }
  const current = { ses_1: [req("perm_1"), req("perm_2")] } // SSE mid-fetch
  const failedForms = reconcilePendingSource({
    fetched: null,
    before: {},
    current: {},
    resolved: new Set(),
  })
  const successPermissions = reconcilePendingSource({
    fetched: [req("perm_1"), req("perm_2")],
    before,
    current,
    resolved: new Set(),
  })
  assert.equal(failedForms, null)
  assert.ok(successPermissions)
  assert.deepEqual(idsFor(successPermissions!, "ses_1"), ["perm_1", "perm_2"])
})

test("pruneResolved keeps ids the server still reports and drops settled ones", () => {
  const resolved = new Set(["q_1", "q_2", "q_3"])
  pruneResolved(resolved, [req("q_2")])
  assert.deepEqual([...resolved].sort(), ["q_2"])
})

test("reconcilePendingSource prunes settled ids without resurrecting optimistic resolutions", () => {
  const resolved = new Set(["q_1", "q_2"])
  const buckets = reconcilePendingSource({
    fetched: [req("q_2")], // only q_2 still pending server-side
    before: { ses_1: [req("q_1"), req("q_2")] },
    current: { ses_1: [req("q_2")] },
    resolved,
  })
  assert.ok(buckets)
  // q_1 settled -> pruned; q_2 still excluded from the buckets.
  assert.deepEqual([...resolved].sort(), ["q_2"])
  assert.deepEqual(idsFor(buckets!, "ses_1"), [])
})

test("an optimistic resolution is not pruned while the server still reports the request", () => {
  const resolved = new Set(["q_1"])
  reconcilePendingSource({
    fetched: [req("q_1")],
    before: { ses_1: [req("q_1")] },
    current: { ses_1: [] },
    resolved,
  })
  assert.deepEqual([...resolved], ["q_1"])
})

test("session-scoped replacement preserves buckets from other workspace scopes", () => {
  const current = { root: [req("stale", "root")], child: [req("old", "child")], other: [req("keep", "other")] }
  const reconciled = { child: [req("fresh", "child")] }
  assert.deepEqual(replacePendingSessions(current, reconciled, new Set(["root", "child"])), {
    child: [req("fresh", "child")],
    other: [req("keep", "other")],
  })
})
