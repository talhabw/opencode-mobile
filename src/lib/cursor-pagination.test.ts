import assert from "node:assert/strict"
import test from "node:test"
import {
  appendCursorPage,
  chronologicalPage,
  dedupePage,
  mergeCursorRefresh,
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
