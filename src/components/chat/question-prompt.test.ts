import assert from "node:assert/strict"
import test from "node:test"
import { isQuestionAnswerValid, questionValidationMessage, updateQuestionAnswer, updateQuestionDraft } from "./question-prompt"

test("validates non-empty answers and rejects an empty unanswerable question", () => {
  assert.equal(isQuestionAnswerValid({ options: ["Yes"] }, ["Yes"]), true)
  assert.equal(questionValidationMessage({ options: ["Yes"] }, []), "required")
  assert.equal(questionValidationMessage({ options: [], custom: false }, []), "unanswerable")
})

test("updates single and multiple answers without mutating prior pages", () => {
  const initial = [["old"], []]
  assert.deepEqual(updateQuestionAnswer(initial, 0, "new", false), [["new"], []])
  assert.deepEqual(updateQuestionAnswer(initial, 1, "one", true), [["old"], ["one"]])
  assert.deepEqual(updateQuestionAnswer([["one", "two"]], 0, "one", true), [["two"]])
  assert.deepEqual(initial, [["old"], []])
})

test("keeps custom drafts independently for each page", () => {
  const drafts = updateQuestionDraft(["first", ""], 1, "second")
  assert.deepEqual(drafts, ["first", "second"])
})
