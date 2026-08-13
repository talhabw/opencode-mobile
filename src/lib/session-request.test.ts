import assert from "node:assert/strict"
import test from "node:test"
import { attachmentUri, inlineFileUri, parseServerCommand, promptRequest, selectedModel } from "./session-request.ts"

test("prompt mapping preserves normal text whitespace and maps generated file URI fields", () => {
  assert.deepEqual(promptRequest([
    { type: "text", text: "  keep leading\n\nand trailing  " },
    { type: "file", mime: "image/jpeg", url: "data:image/jpeg;base64,YQ==", filename: "a.jpg" },
  ]), {
    text: "  keep leading\n\nand trailing  ",
    files: [{ uri: "data:image/jpeg;base64,YQ==", name: "a.jpg" }],
  })
})

test("attachment mapping prefers transferable data URIs and restores inline server files", () => {
  assert.equal(attachmentUri({ uri: "file:///local/a.jpg", mime: "image/jpeg", base64: "YQ==" }), "data:image/jpeg;base64,YQ==")
  assert.equal(attachmentUri({ uri: "https://example.test/a.jpg", mime: "image/jpeg" }), "https://example.test/a.jpg")
  assert.equal(inlineFileUri({ data: "YQ==", mime: "image/png" }), "data:image/png;base64,YQ==")
})

test("slash command mapping only recognizes listed commands and keeps argument whitespace", () => {
  const commands = [{ name: "review" }]
  assert.deepEqual(parseServerCommand("/review first  second\nthird", commands), {
    command: "review",
    arguments: "first  second\nthird",
  })
  assert.equal(parseServerCommand("/unknown text", commands), null)
  assert.equal(parseServerCommand(" /review text", commands), null)
})

test("selected model mapping keeps provider and slash-containing model IDs distinct", () => {
  assert.deepEqual(selectedModel({ providerID: "provider", modelID: "family/model" }, "high"), {
    providerID: "provider",
    id: "family/model",
    variant: "high",
  })
  assert.equal(selectedModel(undefined, "high"), undefined)
})
