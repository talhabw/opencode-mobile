export interface PageCursor {
  previous?: string | null
  next?: string | null
}

export interface CursorPage<T> {
  data: T[]
  cursor: PageCursor
}

export function chronologicalPage<T>(page: CursorPage<T>): T[] {
  return page.data.slice().reverse()
}

function mergeByID<T extends { id: string }>(first: T[], second: T[]): T[] {
  const result = first.slice()
  const indexes = new Map(result.map((item, index) => [item.id, index]))

  for (const item of second) {
    const index = indexes.get(item.id)
    if (index === undefined) {
      indexes.set(item.id, result.length)
      result.push(item)
      continue
    }
    result[index] = item
  }

  return result
}

/** Merge an older descending page before the chronological items already shown. */
export function prependCursorPage<T extends { id: string }>(existing: T[], page: CursorPage<T>): T[] {
  return mergeByID(chronologicalPage(page), existing)
}

/** Append a page that uses the same display order as the existing list. */
export function appendCursorPage<T extends { id: string }>(existing: T[], page: CursorPage<T>): T[] {
  return mergeByID(existing, page.data)
}

/** Merge a refreshed first descending page without discarding previously loaded history. */
export function mergeCursorRefresh<T extends { id: string }>(existing: T[], page: CursorPage<T>): T[] {
  const canonical = chronologicalPage(page)
  const canonicalIDs = new Set(canonical.map((item) => item.id))
  // The refreshed first page is authoritative for its own order and values.
  // Anything already loaded but absent from it is older history.
  return mergeByID(existing.filter((item) => !canonicalIDs.has(item.id)), canonical)
}

/**
 * Merge a refreshed first descending page against a snapshot of the items
 * that existed when the request began.
 *
 * The canonical response repairs/reorders what existed at request start:
 * canonical order wins for overlaps, while post-request object updates win,
 * previously loaded older
 * history stays before the canonical page, and optimistic temps present
 * before the request are reconciled away as before. Anything added or
 * replaced live after the request began — an optimistic send or a real SSE
 * message the stale response cannot know about — is retained after the
 * canonical data instead of being misread as older history. A post-request
 * item the canonical page does cover is placed canonically without being
 * duplicated.
 */
export function mergeCursorRefreshSnapshot<T extends { id: string }>(
  existing: T[],
  snapshot: T[],
  page: CursorPage<T>,
  isOptimistic = (item: T) => item.id.startsWith("temp-"),
): T[] {
  const canonical = chronologicalPage(page)
  const canonicalIDs = new Set(canonical.map((item) => item.id))
  const snapshotByID = new Map(snapshot.map((item) => [item.id, item]))
  const currentByID = new Map(existing.map((item) => [item.id, item]))
  const older: T[] = []
  const canonicalResult: T[] = []
  const postRequest: T[] = []

  for (const item of canonical) {
    const current = currentByID.get(item.id)
    const snapshotItem = snapshotByID.get(item.id)
    if (!current) {
      // An item present when the request started and now absent was removed
      // while the request was in flight; do not resurrect it.
      if (!snapshotItem) canonicalResult.push(item)
      continue
    }
    // Object identity is the event/update boundary in the store. Preserve a
    // replacement, but use the canonical position for that message.
    canonicalResult.push(snapshotItem && current === snapshotItem ? item : current)
  }

  for (const item of existing) {
    if (canonicalIDs.has(item.id)) continue
    if (snapshotByID.has(item.id)) {
      // Predated the request and absent from the canonical page: older
      // history stays before it; optimistic temps are reconciled/dropped.
      if (snapshotByID.get(item.id) === item && !isOptimistic(item)) older.push(item)
      else if (snapshotByID.get(item.id) !== item) postRequest.push(item)
      continue
    }
    postRequest.push(item)
  }
  return [...older, ...canonicalResult, ...postRequest]
}

/** Preserve parts changed after a canonical page request started. */
export function mergePartsRefreshSnapshot<T>(
  messages: Array<{ id: string }>,
  existing: Record<string, T[]>,
  snapshot: Record<string, T[]>,
  canonical: Record<string, T[]>,
): Record<string, T[]> {
  const messageIDs = new Set(messages.map((message) => message.id))
  const result: Record<string, T[]> = {}
  for (const messageID of messageIDs) {
    const current = existing[messageID]
    const before = snapshot[messageID]
    if (current !== before) {
      if (current) result[messageID] = current
      continue
    }
    if (canonical[messageID]) result[messageID] = canonical[messageID]
    else if (current) result[messageID] = current
  }
  // Keep only orphan parts that appeared while this request was in flight.
  // Their message event can follow on the stream; older unrelated orphans are
  // intentionally not carried forward.
  for (const [messageID, current] of Object.entries(existing)) {
    if (!messageIDs.has(messageID) && current !== snapshot[messageID]) result[messageID] = current
  }
  return result
}

export function dedupePage<T extends { id: string }>(page: CursorPage<T>): T[] {
  return mergeByID([], page.data)
}

/** Keep messages before a committed revert point plus optimistic sends. */
export function truncateCommittedRevert<T extends { id: string }>(items: T[], messageID: string): T[] {
  const index = items.findIndex((item) => item.id === messageID)
  if (index < 0) return items
  return items.filter((item, itemIndex) => item.id.startsWith("temp-") || itemIndex < index)
}
