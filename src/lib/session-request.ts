export interface PromptPartText {
  type: "text"
  text: string
}

export interface PromptPartFile {
  type: "file"
  mime: string
  url: string
  filename?: string
}

export type PromptPartInput = PromptPartText | PromptPartFile

export interface ModelSelectionInput {
  providerID: string
  modelID: string
}

export function promptRequest(parts: PromptPartInput[]) {
  return {
    text: parts
      .filter((part): part is PromptPartText => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
    files: parts
      .filter((part): part is PromptPartFile => part.type === "file")
      .map((part) => ({ uri: part.url, name: part.filename })),
  }
}

export function selectedModel(model: ModelSelectionInput | undefined, variant?: string) {
  if (!model) return undefined
  return { providerID: model.providerID, id: model.modelID, variant }
}

export function attachmentUri(attachment: { uri: string; mime: string; base64?: string }) {
  return attachment.base64 ? `data:${attachment.mime};base64,${attachment.base64}` : attachment.uri
}

export function inlineFileUri(file: { data: string; mime: string }) {
  if (file.data.startsWith("data:")) return file.data
  return `data:${file.mime};base64,${file.data}`
}

export function parseServerCommand(input: string, commands: ReadonlyArray<{ name: string }>) {
  const match = /^\/([^\s]+)(?:\s([\s\S]*))?$/.exec(input)
  if (!match || !commands.some((command) => command.name === match[1])) return null
  return { command: match[1], arguments: match[2] ?? "" }
}
