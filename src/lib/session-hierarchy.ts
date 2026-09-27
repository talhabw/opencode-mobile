import type { Session } from "./sdk"

export interface HierarchySessionRow {
  session: Session
  depth: number
}

export type PendingBySession = Readonly<Record<string, readonly unknown[]>>

export interface PendingSessionCounts {
  own: number
  descendants: number
  total: number
}

// Combine per-session pending request records. Permissions and questions are
// tracked in separate events-store maps, but counts and fallback navigation
// must treat both kinds uniformly; sessions with no pending entries are
// dropped so empty buckets never surface as zero-count rows.
export function mergePendingRequests(...records: readonly PendingBySession[]): PendingBySession {
  const merged: Record<string, unknown[]> = {}
  for (const record of records) {
    for (const [sessionID, requests] of Object.entries(record)) {
      if (requests.length === 0) continue
      merged[sessionID] = [...(merged[sessionID] ?? []), ...requests]
    }
  }
  return merged
}

export function flattenSessionHierarchy(
  roots: Session[],
  childrenByParent: Record<string, Session[]>,
  expanded: ReadonlySet<string>,
): HierarchySessionRow[] {
  const rows: HierarchySessionRow[] = []
  const visited = new Set<string>()

  const append = (session: Session, depth: number) => {
    if (visited.has(session.id)) return
    visited.add(session.id)
    rows.push({ session, depth })
    if (!expanded.has(session.id)) return
    for (const child of childrenByParent[session.id] ?? []) append(child, depth + 1)
  }

  for (const root of roots) append(root, 0)
  return rows
}

export function findCachedSession(
  sessionID: string,
  roots: Session[],
  childrenByParent: Record<string, Session[]>,
  currentSession?: Session | null,
): Session | undefined {
  if (currentSession?.id === sessionID) return currentSession
  const root = roots.find((session) => session.id === sessionID)
  if (root) return root
  for (const children of Object.values(childrenByParent)) {
    const child = children.find((session) => session.id === sessionID)
    if (child) return child
  }
  return undefined
}

export function descendantIDs(sessionID: string, childrenByParent: Record<string, Session[]>): Set<string> {
  const ids = new Set<string>()
  const visit = (id: string) => {
    if (ids.has(id)) return
    ids.add(id)
    for (const child of childrenByParent[id] ?? []) visit(child.id)
  }
  visit(sessionID)
  return ids
}

export function pendingSessionCounts(
  sessionID: string,
  childrenByParent: Record<string, Session[]>,
  pending: PendingBySession,
): PendingSessionCounts {
  const ids = descendantIDs(sessionID, childrenByParent)
  const own = pending[sessionID]?.length ?? 0
  let total = 0
  for (const id of ids) total += pending[id]?.length ?? 0
  return { own, descendants: Math.max(0, total - own), total }
}

// Directory-wide child counts derived from an unfiltered session list (which
// contains roots and children). Rows without a parentID are roots and never
// count toward any parent; sessions with a parentID each count once for it.
export function childCountsFromSessions(sessions: Session[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const session of sessions) {
    if (!session.parentID) continue
    counts[session.parentID] = (counts[session.parentID] ?? 0) + 1
  }
  return counts
}

export function incrementChildCount(counts: Record<string, number>, parentID?: string | null): Record<string, number> {
  if (!parentID) return counts
  return { ...counts, [parentID]: (counts[parentID] ?? 0) + 1 }
}

// Only decrements parents with a known count — an absent entry means "unknown",
// so nothing is decremented (and no -1 sentinel is created) until a prefetch
// or a create event establishes the count.
export function decrementChildCount(counts: Record<string, number>, parentID?: string | null): Record<string, number> {
  if (!parentID || counts[parentID] === undefined) return counts
  return { ...counts, [parentID]: Math.max(0, counts[parentID] - 1) }
}

export function unassociatedDescendantPending<T extends { sessionID: string }>(
  sessionID: string,
  childrenByParent: Record<string, Session[]>,
  pending: PendingBySession & Record<string, readonly T[]>,
  associatedChildIDs: ReadonlySet<string>,
): T[] {
  const result: T[] = []
  for (const childID of descendantIDs(sessionID, childrenByParent)) {
    if (childID === sessionID || associatedChildIDs.has(childID)) continue
    result.push(...(pending[childID] ?? []))
  }
  return result
}

export function upsertSessionHierarchy(
  roots: Session[],
  childrenByParent: Record<string, Session[]>,
  session: Session,
): { roots: Session[]; childrenByParent: Record<string, Session[]> } {
  const nextRoots = roots.filter((item) => item.id !== session.id)
  const nextChildren = Object.fromEntries(
    Object.entries(childrenByParent).map(([parentID, children]) => [parentID, children.filter((item) => item.id !== session.id)]),
  )
  if (!session.parentID) return { roots: [session, ...nextRoots], childrenByParent: nextChildren }
  nextChildren[session.parentID] = [session, ...(nextChildren[session.parentID] ?? [])]
  return { roots: nextRoots, childrenByParent: nextChildren }
}

export function purgeSessionHierarchy(
  roots: Session[],
  childrenByParent: Record<string, Session[]>,
  sessionID: string,
): { roots: Session[]; childrenByParent: Record<string, Session[]>; removed: Set<string> } {
  const removed = descendantIDs(sessionID, childrenByParent)
  return {
    roots: roots.filter((session) => !removed.has(session.id)),
    childrenByParent: Object.fromEntries(
      Object.entries(childrenByParent)
        .filter(([parentID]) => !removed.has(parentID))
        .map(([parentID, children]) => [parentID, children.filter((session) => !removed.has(session.id))]),
    ),
    removed,
  }
}
