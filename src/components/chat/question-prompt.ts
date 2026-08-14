export interface QuestionAnswerInput {
  options: readonly unknown[]
  custom?: boolean
}

export function isQuestionAnswerValid(question: QuestionAnswerInput, answer: string[] | undefined): boolean {
  return Boolean(answer?.some((value) => value.trim().length > 0))
}

export function questionValidationMessage(question: QuestionAnswerInput, answer: string[] | undefined): "required" | "unanswerable" | null {
  if (isQuestionAnswerValid(question, answer)) return null
  return question.options.length === 0 && question.custom === false ? "unanswerable" : "required"
}

export function updateQuestionAnswer(
  answers: string[][],
  index: number,
  value: string,
  multiple: boolean,
): string[][] {
  const next = answers.map((answer) => [...answer])
  const current = next[index] ?? []
  next[index] = multiple
    ? current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
    : [value]
  return next
}

export function updateQuestionDraft(drafts: string[], index: number, value: string): string[] {
  const next = [...drafts]
  next[index] = value
  return next
}
