// Canonical view of a pending agent question, unified across the two server
// transports that can surface one:
// - "question": the legacy question API (question.asked / question.request)
// - "form": the forms API the question tool targets on newer servers
//   (form.created events with metadata.kind === "question")

export interface PendingInputOption {
  label: string
  description?: string
}

export interface PendingInputQuestion {
  question: string
  header: string
  options: PendingInputOption[]
  multiple?: boolean
  custom?: boolean
}

export type PendingInputTransport = "question" | "form"

export type FormFieldKind = "string" | "multiselect" | "number" | "integer" | "boolean" | "external"

export interface PendingInputTool {
  messageID: string
  callID: string
}

// Structurally compatible with the legacy PendingQuestion wire shape, so the
// store buckets and badge consumers keep working with either transport.
export interface PendingInput {
  id: string
  sessionID: string
  questions: PendingInputQuestion[]
  tool?: PendingInputTool
  transport: PendingInputTransport
  formID?: string
  fieldKeys?: string[]
  fieldTypes?: FormFieldKind[]
}

export interface QuestionRequestLike {
  id: string
  sessionID: string
  questions: PendingInputQuestion[]
  tool?: PendingInputTool
}

export function fromQuestionRequest(request: QuestionRequestLike): PendingInput {
  return { ...request, transport: "question" }
}

// Structural subset of the SDK's FormInfo the mappers actually read. Field
// entries stay unknown — each is validated defensively while mapping.
export interface QuestionFormWire {
  id: string
  sessionID: string
  title?: string
  metadata?: Record<string, unknown>
  fields: unknown[]
}

export function isQuestionFormMetadata(metadata: unknown): boolean {
  return Boolean(metadata && typeof metadata === "object" && (metadata as { kind?: unknown }).kind === "question")
}

// Only forms created by the question tool are question prompts; other form
// kinds (e.g. integrations) must not surface as pending questions.
export function isQuestionForm(form: unknown): form is QuestionFormWire {
  if (!form || typeof form !== "object") return false
  const candidate = form as { id?: unknown; sessionID?: unknown; fields?: unknown; metadata?: unknown }
  if (typeof candidate.id !== "string" || typeof candidate.sessionID !== "string") return false
  if (!Array.isArray(candidate.fields)) return false
  return isQuestionFormMetadata(candidate.metadata)
}

interface FormFieldEntry {
  key: string
  type: string
  title?: string
  description?: string
  custom?: boolean
  options: Array<{ label: string; description?: string }>
}

const FIELD_KINDS: ReadonlySet<string> = new Set(["string", "multiselect", "number", "integer", "boolean", "external"])

function formField(entry: unknown): FormFieldEntry | undefined {
  if (!entry || typeof entry !== "object") return undefined
  const candidate = entry as {
    key?: unknown
    type?: unknown
    title?: unknown
    description?: unknown
    custom?: unknown
    options?: unknown
  }
  if (typeof candidate.key !== "string" || typeof candidate.type !== "string") return undefined
  const options: FormFieldEntry["options"] = []
  if (Array.isArray(candidate.options)) {
    for (const raw of candidate.options) {
      if (!raw || typeof raw !== "object") continue
      const option = raw as { value?: unknown; label?: unknown; description?: unknown }
      const label = typeof option.label === "string" ? option.label : typeof option.value === "string" ? option.value : undefined
      if (!label) continue
      options.push({ label, ...(typeof option.description === "string" ? { description: option.description } : {}) })
    }
  }
  return {
    key: candidate.key,
    type: candidate.type,
    ...(typeof candidate.title === "string" ? { title: candidate.title } : {}),
    ...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
    ...(candidate.custom === true ? { custom: true } : {}),
    options,
  }
}

function formQuestionTool(metadata: Record<string, unknown> | undefined): { tool?: PendingInputTool } {
  const tool = metadata?.tool
  if (!tool || typeof tool !== "object") return {}
  const source = tool as { messageID?: unknown; id?: unknown }
  if (typeof source.messageID !== "string" || typeof source.id !== "string") return {}
  return { tool: { messageID: source.messageID, callID: source.id } }
}

export function fromQuestionForm(form: QuestionFormWire): PendingInput {
  const fieldKeys: string[] = []
  const fieldTypes: FormFieldKind[] = []
  const questions: PendingInputQuestion[] = []
  const seenKeys = new Set<string>()
  for (const entry of form.fields) {
    const field = formField(entry)
    if (!field || seenKeys.has(field.key)) continue
    seenKeys.add(field.key)
    // Unknown types encode like a string field (scalar answer) but render as
    // the defensive free-text question below.
    const type = (FIELD_KINDS.has(field.type) ? field.type : "string") as FormFieldKind
    fieldKeys.push(field.key)
    fieldTypes.push(type)
    const header = field.title ?? field.key
    const question = field.description ?? header
    if (field.type === "string" || field.type === "multiselect") {
      questions.push({
        header,
        question,
        options: field.options,
        ...(type === "multiselect" ? { multiple: true } : {}),
        custom: field.custom === true,
      })
    } else {
      // The question tool only emits string/multiselect fields; anything else
      // degrades to a plain free-text question so the prompt stays answerable.
      questions.push({ header, question, options: [], custom: true })
    }
  }
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions,
    ...formQuestionTool(form.metadata),
    transport: "form",
    formID: form.id,
    fieldKeys,
    fieldTypes,
  }
}

// Encodes UI answers (one selection list per question) into the form reply
// payload: multiselect fields keep the whole selection (custom entries
// included), every other field takes the first selected value or "".
export function toFormAnswer(view: PendingInput, answers: string[][]): Record<string, string | string[]> {
  const fieldKeys = view.fieldKeys ?? []
  const fieldTypes = view.fieldTypes ?? []
  const answer: Record<string, string | string[]> = {}
  for (const [index, key] of fieldKeys.entries()) {
    const selected = answers[index] ?? []
    answer[key] = fieldTypes[index] === "multiselect" ? selected : selected[0] ?? ""
  }
  return answer
}

// Merges both transports' pending inputs, dropping duplicate ids so a request
// recovered via both the question and form APIs only renders once.
export function dedupePendingInputs(inputs: readonly PendingInput[]): PendingInput[] {
  const seen = new Set<string>()
  const merged: PendingInput[] = []
  for (const input of inputs) {
    if (seen.has(input.id)) continue
    seen.add(input.id)
    merged.push(input)
  }
  return merged
}
