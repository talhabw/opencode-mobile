import assert from "node:assert/strict"
import test from "node:test"
import type { Session } from "./sdk.ts"
import { childCountsFromSessions, decrementChildCount, descendantIDs, flattenSessionHierarchy, incrementChildCount, pendingSessionCounts, purgeSessionHierarchy, unassociatedDescendantPending, upsertSessionHierarchy } from "./session-hierarchy.ts"

const session = (id: string, parentID?: string): Session => ({
  id, slug: id, projectID: "p", directory: "/work", parentID, title: id, version: "2", time: { created: 1, updated: 1 },
})

test("flattens only expanded descendants at the correct depth", () => {
  const root = session("root")
  const child = session("child", "root")
  const sibling = session("sibling", "root")
  const grandchild = session("grandchild", "child")
  const children = { root: [child, sibling], child: [grandchild] }
  assert.deepEqual(flattenSessionHierarchy([root], children, new Set()), [{ session: root, depth: 0 }])
  assert.deepEqual(flattenSessionHierarchy([root], children, new Set(["root", "child"])), [
    { session: root, depth: 0 }, { session: child, depth: 1 }, { session: grandchild, depth: 2 }, { session: sibling, depth: 1 },
  ])
})

test("recursive deletion discovers cached descendants", () => {
  assert.deepEqual([...descendantIDs("root", { root: [session("child", "root")], child: [session("grand", "child")] })], ["root", "child", "grand"])
})

test("routes roots and children and moves updates between hierarchy caches", () => {
  const root = session("root")
  const child = session("child", "root")
  let cache = upsertSessionHierarchy([], {}, child)
  assert.deepEqual(cache.roots, [])
  assert.deepEqual(cache.childrenByParent.root, [child])
  cache = upsertSessionHierarchy(cache.roots, cache.childrenByParent, root)
  assert.deepEqual(cache.roots, [root])
  cache = upsertSessionHierarchy(cache.roots, cache.childrenByParent, { ...child, parentID: undefined })
  assert.deepEqual(cache.roots.map((item) => item.id), ["child", "root"])
  assert.deepEqual(cache.childrenByParent.root, [])
})

test("counts own and nested descendant pending requests without double counting", () => {
  const children = { root: [{ id: "child", parentID: "root" } as Session], child: [{ id: "grandchild", parentID: "child" } as Session] }
  const pending = { root: [{ id: "r" }], child: [{ id: "c1" }, { id: "c2" }], grandchild: [{ id: "g" }] }
  assert.deepEqual(pendingSessionCounts("root", children, pending), { own: 1, descendants: 3, total: 4 })
  assert.deepEqual(pendingSessionCounts("child", children, pending), { own: 2, descendants: 1, total: 3 })
})

test("returns only exact unassociated child requests for parent fallback", () => {
  const children = { root: [{ id: "child", parentID: "root" } as Session], child: [{ id: "grandchild", parentID: "child" } as Session] }
  const pending = { child: [{ id: "c", sessionID: "child" }], grandchild: [{ id: "g", sessionID: "grandchild" }] }
  assert.deepEqual(unassociatedDescendantPending("root", children, pending, new Set(["child"])), [{ id: "g", sessionID: "grandchild" }])
})

test("purges a subtree without touching unrelated roots", () => {
  const root = session("root")
  const other = session("other")
  const child = session("child", "root")
  const result = purgeSessionHierarchy([root, other], { root: [child], child: [session("grand", "child")] }, "root")
  assert.deepEqual(result.roots, [other])
  assert.deepEqual(result.childrenByParent, {})
  assert.deepEqual([...result.removed], ["root", "child", "grand"])
})

test("derives child counts from an unfiltered directory list", () => {
  const list = [
    session("root1"),
    session("root2"),
    session("childA", "root1"),
    session("childB", "root1"),
    session("grandchild", "childA"),
    session("childC", "root2"),
  ]
  assert.deepEqual(childCountsFromSessions(list), { root1: 2, childA: 1, root2: 1 })
  assert.deepEqual(childCountsFromSessions([]), {})
  assert.deepEqual(childCountsFromSessions([session("onlyRoot")]), {})
})

test("ignores sessions without a parentID when counting", () => {
  const list = [session("root"), { ...session("orphan"), parentID: undefined }]
  assert.deepEqual(childCountsFromSessions(list), {})
})

test("increments child counts on created sessions", () => {
  const counts = { root: 1 }
  assert.deepEqual(incrementChildCount(counts, "root"), { root: 2 })
  assert.deepEqual(counts, { root: 1 })
  // A parent whose count was never prefetched is established at 1.
  assert.deepEqual(incrementChildCount(counts, "fresh"), { root: 1, fresh: 1 })
  // Roots and unknown parents don't change anything.
  assert.equal(incrementChildCount(counts, undefined), counts)
  assert.equal(incrementChildCount(counts, null), counts)
})

test("decrements child counts on deleted sessions", () => {
  const counts = { root: 2, child: 1 }
  assert.deepEqual(decrementChildCount(counts, "root"), { root: 1, child: 1 })
  // Never drops below zero even if events race.
  assert.deepEqual(decrementChildCount({ root: 0 }, "root"), { root: 0 })
  // Unknown parents stay unknown rather than going negative.
  assert.equal(decrementChildCount(counts, "neverCounted"), counts)
  assert.equal(decrementChildCount(counts, undefined), counts)
  assert.equal(decrementChildCount(counts, null), counts)
})
