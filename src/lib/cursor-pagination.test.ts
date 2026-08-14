import assert from "node:assert/strict"
import test from "node:test"
import {
  appendCursorPage,
  chronologicalPage,
  dedupePage,
  mergeCursorRefresh,
  mergeCursorRefreshSnapshot,
  mergePartsRefreshSnapshot,
  prependCursorPage,
  truncateCommittedRevert,
} from "./cursor-pagination.ts"

const item = (id: string, value = id) => ({ id, value })

test("first descending page becomes chronological without changing opaque cursors", () => {
  const page = {
    data: [item("m3"), item("m2"), item("m1")],
    cursor: { previous: "opaque-newer", next: "opaque-older" },
  }

  assert.deepEqual(chronologicalPage(page).map((entry) => entry.id), ["m1", "m2", "m3"])
  assert.deepEqual(page.cursor, { previous: "opaque-newer", next: "opaque-older" })
})

test("next page prepends older items and deduplicates an overlapping boundary", () => {
  const merged = prependCursorPage(
    [item("m3"), item("m4")],
    { data: [item("m3", "stale"), item("m2"), item("m1")], cursor: { next: "next-page" } },
  )

  assert.deepEqual(merged.map((entry) => entry.id), ["m1", "m2", "m3", "m4"])
  assert.equal(merged.find((entry) => entry.id === "m3")?.value, "m3")
})

test("refresh updates duplicates, adds new items, and retains loaded history", () => {
  const merged = mergeCursorRefresh(
    [item("m1"), item("m2", "old"), item("m3")],
    { data: [item("m4"), item("m3"), item("m2", "fresh")], cursor: { next: "older" } },
  )

  assert.deepEqual(merged.map((entry) => entry.id), ["m1", "m2", "m3", "m4"])
  assert.equal(merged.find((entry) => entry.id === "m2")?.value, "fresh")
})

test("refresh repairs a live assistant-first list to canonical user/assistant order", () => {
  const merged = mergeCursorRefresh(
    [item("assistant", "assistant")],
    { data: [item("assistant"), item("user")], cursor: {} },
  )
  assert.deepEqual(merged.map((entry) => entry.id), ["user", "assistant"])
})

test("refresh repairs malformed overlapping values and lets canonical values win", () => {
  const merged = mergeCursorRefresh(
    [item("assistant", "wrong"), item("user", "wrong")],
    { data: [item("assistant", "fresh assistant"), item("user", "fresh user")], cursor: {} },
  )
  assert.deepEqual(merged, [item("user", "fresh user"), item("assistant", "fresh assistant")])
})

test("refresh keeps loaded older history before the canonical first page", () => {
  const merged = mergeCursorRefresh(
    [item("older"), item("assistant")],
    { data: [item("assistant"), item("user")], cursor: { next: "older-page" } },
  )
  assert.deepEqual(merged.map((entry) => entry.id), ["older", "user", "assistant"])
})

test("refresh begun with history keeps an optimistic temp send that arrives before the stale response", () => {
  const merged = mergeCursorRefreshSnapshot(
    [item("m1"), item("m2"), item("temp-99")],
    [item("m1"), item("m2")],
    { data: [item("m2"), item("m1")], cursor: {} },
  )
  assert.deepEqual(merged.map((entry) => entry.id), ["m1", "m2", "temp-99"])
})

test("refresh retains real SSE messages that arrive in flight and are absent from the stale page", () => {
  const merged = mergeCursorRefreshSnapshot(
    [item("u1"), item("a1"), item("a2")],
    [item("u1"), item("a1")],
    { data: [item("a1"), item("u1")], cursor: {} },
  )
  assert.deepEqual(merged.map((entry) => entry.id), ["u1", "a1", "a2"])
})

test("snapshot refresh still repairs a live assistant-first list to canonical order", () => {
  const merged = mergeCursorRefreshSnapshot(
    [item("assistant")],
    [item("assistant")],
    { data: [item("assistant"), item("user")], cursor: {} },
  )
  assert.deepEqual(merged.map((entry) => entry.id), ["user", "assistant"])
})

test("snapshot refresh still reconciles a temp that existed before the request", () => {
  const m1 = item("m1")
  const temp = item("temp-1")
  const merged = mergeCursorRefreshSnapshot(
    [m1, temp],
    [m1, temp],
    { data: [item("m1")], cursor: {} },
  )
  assert.deepEqual(merged.map((entry) => entry.id), ["m1"])
})

test("snapshot refresh keeps older history, lets canonical win, and never duplicates real messages", () => {
  const older = item("older")
  const m1 = item("m1")
  const live = item("r1", "live")
  const merged = mergeCursorRefreshSnapshot(
    [older, m1, live],
    [older, m1],
    { data: [item("r1", "canonical"), item("m1")], cursor: { next: "older-page" } },
  )
  assert.deepEqual(merged.map((entry) => entry.id), ["older", "m1", "r1"])
  assert.equal(merged.find((entry) => entry.id === "r1")?.value, "live")
})

test("snapshot refresh preserves a same-ID message replacement at the canonical position", () => {
  const original = item("m1", "before")
  const updated = item("m1", "after")
  assert.deepEqual(
    mergeCursorRefreshSnapshot([updated], [original], { data: [item("m2"), item("m1", "stale")], cursor: {} }),
    [updated, item("m2")],
  )
})

test("snapshot refresh does not resurrect a message removed in flight", () => {
  const removed = item("m1")
  assert.deepEqual(mergeCursorRefreshSnapshot([], [removed], { data: [removed], cursor: {} }), [])
})

test("parts preserve in-flight replacements and orphan parts, but only for live messages", () => {
  const message = item("m1")
  const orphanMessage = item("m2")
  const deletedPartsMessage = item("m3")
  const changed = [{ id: "p1" }]
  const orphan = [{ id: "orphan" }]
  assert.deepEqual(
    mergePartsRefreshSnapshot(
      [message, orphanMessage, deletedPartsMessage],
      { m1: changed, m2: orphan, m3: [] },
      { m1: [], m2: [], m3: [{ id: "old" }] },
      { m1: [{ id: "stale" }], m2: [{ id: "stale" }], m3: [{ id: "stale" }] },
    ),
    { m1: changed, m2: orphan, m3: [] },
  )
})

test("parts preserve in-flight deletion and a truly orphaned live part", () => {
  assert.deepEqual(
    mergePartsRefreshSnapshot(
      [item("m1")],
      { orphan: [{ id: "live" }] },
      { m1: [{ id: "old" }] },
      { m1: [{ id: "stale" }] },
    ),
    { orphan: [{ id: "live" }] },
  )
})

test("a page with no next cursor represents the end", () => {
  const page = { data: [item("m1")], cursor: { previous: "newer", next: null } }
  assert.equal(page.cursor.next, null)
  assert.deepEqual(prependCursorPage([], page), [item("m1")])
})

test("a refreshed list page deduplicates repeated ids", () => {
  assert.deepEqual(
    dedupePage({ data: [item("s1", "old"), item("s1", "fresh"), item("s2")], cursor: {} }),
    [item("s1", "fresh"), item("s2")],
  )
})

test("a next list page appends in server order and deduplicates overlap", () => {
  const merged = appendCursorPage(
    [item("s4"), item("s3")],
    { data: [item("s3", "fresh"), item("s2")], cursor: { next: "more" } },
  )
  assert.deepEqual(merged, [item("s4"), item("s3", "fresh"), item("s2")])
})

test("committed revert removes the target and tail but keeps optimistic sends", () => {
  const result = truncateCommittedRevert(
    [item("m1"), item("m2"), item("m3"), item("temp-new")],
    "m2",
  )
  assert.deepEqual(result.map((entry) => entry.id), ["m1", "temp-new"])
})
