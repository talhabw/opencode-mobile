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
  return mergeByID(existing, chronologicalPage(page))
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
