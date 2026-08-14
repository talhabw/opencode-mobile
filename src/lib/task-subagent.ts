import type { Part } from "./sdk"

export interface TaskSubagentLink {
  sessionID: string
  parentSessionID?: string
}

export function taskSubagentLink(part: Part): TaskSubagentLink | null {
  if (part.type !== "tool" || part.tool !== "task") return null
  const metadata = part.state?.metadata
  if (!metadata || typeof metadata !== "object") return null
  const sessionID = (metadata as Record<string, unknown>).sessionId
  if (typeof sessionID !== "string" || sessionID.trim().length === 0) return null
  const parentSessionID = (metadata as Record<string, unknown>).parentSessionId
  return {
    sessionID,
    ...(typeof parentSessionID === "string" && parentSessionID.length > 0 ? { parentSessionID } : {}),
  }
}
