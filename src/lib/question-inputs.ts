// Canonical view of a pending agent question. The server surfaces the
// question tool through the forms API — a form whose metadata.kind is
// "question" is the authoritative source of truth, so every pending input
// maps from a question-kind form.

export interface PendingInputOption {
  // Display label. The wire value (what the server validates against) is
  // carried separately — option values and labels are not required to match.
  label: string
  value: string
  description?: string
}

export interface PendingInputQuestion {
  question: string
  header: string
  options: PendingInputOption[]
  multiple?: boolean
  custom?: boolean
  // Explicit `required: false` on the wire field means the form accepts an
  // unanswered value; absent/falsey keeps the question required (the question
  // tool's fields are answers that must be provided).
  required?: boolean
}

export type PendingInputTransport = "form"

export type FormFieldKind = "string" | "multiselect" | "number" | "integer" | "boolean" | "external"

export interface PendingInputTool {
  messageID: string
  callID: string
}

// Structurally compatible with how the store buckets pending questions, so
// bucket consumers keep working regardless of transport.
export interface PendingInput {
  id: string
  sessionID: string
  questions: PendingInputQuestion[]
  tool?: PendingInputTool
  transport: PendingInputTransport
  formID?: string
  fieldKeys?: string[]
  fieldTypes?: FormFieldKind[]
  // Parallel to fieldKeys: whether the form demands a value for the field.
  fieldRequired?: boolean[]
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
  required?: boolean
  options: Array<{ label: string; value: string; description?: string }>
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
    required?: unknown
    options?: unknown
  }
  if (typeof candidate.key !== "string" || typeof candidate.type !== "string") return undefined
  const options: FormFieldEntry["options"] = []
  if (Array.isArray(candidate.options)) {
    for (const raw of candidate.options) {
      if (!raw || typeof raw !== "object") continue
      const option = raw as { value?: unknown; label?: unknown; description?: unknown }
      const wireValue = typeof option.value === "string" && option.value ? option.value : undefined
      const wireLabel = typeof option.label === "string" && option.label ? option.label : undefined
      const value = wireValue ?? wireLabel
      const label = wireLabel ?? wireValue
      if (!value || !label) continue
      options.push({ label, value, ...(typeof option.description === "string" ? { description: option.description } : {}) })
    }
  }
  return {
    key: candidate.key,
    type: candidate.type,
    ...(typeof candidate.title === "string" ? { title: candidate.title } : {}),
    ...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
    ...(candidate.custom === true ? { custom: true } : {}),
    ...(candidate.required === false ? { required: false } : {}),
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
  const fieldRequired: boolean[] = []
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
    fieldRequired.push(field.required !== false)
    const header = field.title ?? field.key
    const question = field.description ?? header
    const required = field.required === false ? { required: false as const } : {}
    if (field.type === "string" || field.type === "multiselect") {
      questions.push({
        header,
        question,
        options: field.options,
        ...(type === "multiselect" ? { multiple: true } : {}),
        custom: field.custom === true,
        ...required,
      })
    } else {
      // The question tool only emits string/multiselect fields; anything else
      // degrades to a plain free-text question so the prompt stays answerable.
      questions.push({ header, question, options: [], custom: true, ...required })
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
    fieldRequired,
  }
}

// Encodes UI answers (one selection list per question) into the form reply
// payload: multiselect fields keep the whole selection (custom entries
// included), every other field takes the first selected value or "". Fields
// the server marked optional are omitted entirely when left unanswered, so an
// empty string never overrides a server-side default or fails a constraint.
export function toFormAnswer(view: PendingInput, answers: string[][]): Record<string, string | string[]> {
  const fieldKeys = view.fieldKeys ?? []
  const fieldTypes = view.fieldTypes ?? []
  const fieldRequired = view.fieldRequired ?? []
  const answer: Record<string, string | string[]> = {}
  for (const [index, key] of fieldKeys.entries()) {
    const selected = answers[index] ?? []
    if (fieldTypes[index] === "multiselect") {
      if (selected.length === 0 && fieldRequired[index] === false) continue
      answer[key] = selected
      continue
    }
    const value = selected[0] ?? ""
    if (value === "" && fieldRequired[index] === false) continue
    answer[key] = value
  }
  return answer
}
