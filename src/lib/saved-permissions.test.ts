import assert from "node:assert/strict"
import test from "node:test"
import { savedPermissionsForProject } from "./saved-permissions"

const items = [
  { id: "a", projectID: "p1", action: "shell", resource: "git status" },
  { id: "b", projectID: "p2", action: "edit", resource: "/tmp/file" },
  { id: "c", projectID: "p1", action: "webfetch", resource: "https://example.com" },
]

test("keeps only approvals belonging to the requested project", () => {
  assert.deepEqual(savedPermissionsForProject(items, "p1").map((item) => item.id), ["a", "c"])
  assert.deepEqual(savedPermissionsForProject(items, "p2").map((item) => item.id), ["b"])
})

test("an unknown project yields an empty list, not another project's grants", () => {
  assert.deepEqual(savedPermissionsForProject(items, "p3"), [])
  assert.deepEqual(savedPermissionsForProject([], "p1"), [])
})
