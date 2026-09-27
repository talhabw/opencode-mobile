import assert from "node:assert/strict"
import test from "node:test"
import {
  fromQuestionForm,
  isQuestionForm,
  isQuestionFormMetadata,
  toFormAnswer,
} from "./question-inputs.ts"

const questionForm = {
  id: "form_1",
  sessionID: "ses_1",
  title: "Questions",
  metadata: {
    kind: "question",
    tool: { messageID: "msg_1", id: "call_1" },
  },
  fields: [
    {
      key: "q0",
      title: "Deploy target",
      description: "Which environment should receive the deploy?",
      type: "string",
      options: [
        { value: "Staging", label: "Staging", description: "Deploy to staging first" },
        { value: "Production", label: "Production" },
      ],
      custom: true,
    },
    {
      key: "q1",
      title: "Regions",
      description: "Which regions should be notified?",
      type: "multiselect",
      options: [
        { value: "EU", label: "EU", description: "Europe" },
        { value: "US", label: "US" },
      ],
      custom: true,
    },
  ],
}

test("fromQuestionForm maps question-tool fields into the canonical view", () => {
  assert.equal(isQuestionForm(questionForm), true)
  const view = fromQuestionForm(questionForm)
  assert.deepEqual(view, {
    id: "form_1",
    sessionID: "ses_1",
    questions: [
      {
        header: "Deploy target",
        question: "Which environment should receive the deploy?",
        options: [
          { label: "Staging", description: "Deploy to staging first" },
          { label: "Production" },
        ],
        custom: true,
      },
      {
        header: "Regions",
        question: "Which regions should be notified?",
        options: [{ label: "EU", description: "Europe" }, { label: "US" }],
        multiple: true,
        custom: true,
      },
    ],
    tool: { messageID: "msg_1", callID: "call_1" },
    transport: "form",
    formID: "form_1",
    fieldKeys: ["q0", "q1"],
    fieldTypes: ["string", "multiselect"],
  })
})

test("isQuestionForm only accepts question-kind forms with the required wire fields", () => {
  assert.equal(isQuestionForm(null), false)
  assert.equal(isQuestionForm("form.created"), false)
  assert.equal(isQuestionForm({ id: "f", sessionID: "s", fields: [] }), false)
  assert.equal(isQuestionFormMetadata(undefined), false)
  assert.equal(isQuestionFormMetadata({ kind: "integration" }), false)
  assert.equal(
    isQuestionForm({ id: "f", sessionID: "s", metadata: { kind: "other" }, fields: [{ key: "q0", type: "string" }] }),
    false,
  )
  assert.equal(
    isQuestionForm({ id: "f", sessionID: "s", metadata: { kind: "question" }, fields: [{ key: "q0", type: "string" }] }),
    true,
  )
  // Missing sessionID or fields never narrows even with question metadata.
  assert.equal(isQuestionForm({ id: "f", metadata: { kind: "question" }, fields: [] }), false)
  assert.equal(isQuestionForm({ id: "f", sessionID: "s", metadata: { kind: "question" } }), false)
})

test("fromQuestionForm is defensive against malformed server data", () => {
  const malformed = {
    id: "form_2",
    sessionID: "ses_2",
    metadata: { kind: "question", tool: { messageID: 7, id: "call_2" } },
    fields: [
      null,
      { key: "ok", title: "Plain", type: "string" },
      { type: "string" },
      { key: "dup", title: "First", type: "string" },
      { key: "dup", title: "Second", type: "string" },
      { key: "weird", type: "mystery", title: "Weird", description: "Unknown type" },
      { key: "opts", type: "multiselect", title: "Opts", options: [null, { value: 1 }, { label: "Keep", value: "keep", description: "kept" }] },
      { key: 42, type: "string" },
    ],
  }
  const view = fromQuestionForm(malformed)
  assert.deepEqual(view.fieldKeys, ["ok", "dup", "weird", "opts"])
  assert.deepEqual(view.fieldTypes, ["string", "string", "string", "multiselect"])
  assert.equal(view.tool, undefined)
  assert.deepEqual(view.questions, [
    { header: "Plain", question: "Plain", options: [], custom: false },
    { header: "First", question: "First", options: [], custom: false },
    // Unknown field types degrade to a plain free-text question with no options.
    { header: "Weird", question: "Unknown type", options: [], custom: true },
    {
      header: "Opts",
      question: "Opts",
      options: [{ label: "Keep", description: "kept" }],
      multiple: true,
      custom: false,
    },
  ])
})

test("toFormAnswer encodes scalars for string fields and arrays for multiselect", () => {
  const view = fromQuestionForm(questionForm)
  assert.deepEqual(
    toFormAnswer(view, [["Staging"], ["EU", "US", "custom-region"]]),
    { q0: "Staging", q1: ["EU", "US", "custom-region"] },
  )
  // Missing selections encode as empty values, never undefined.
  assert.deepEqual(toFormAnswer(view, []), { q0: "", q1: [] })
  assert.deepEqual(toFormAnswer(view, [["", "Staging"]]), { q0: "", q1: [] })
})

test("toFormAnswer tolerates a view without form fields", () => {
  const fieldless = fromQuestionForm({ id: "q_1", sessionID: "ses_1", metadata: { kind: "question" }, fields: [] })
  assert.deepEqual(toFormAnswer(fieldless, [["Yes"]]), {})
})
