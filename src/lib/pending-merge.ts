// Reconciliation helpers for pending requests (tool permissions and question
// forms) in src/stores/events.ts. The events store keeps server-pending
// requests in per-session buckets that are ALSO updated live by SSE events,
// so a refresh fetch (refreshPending / authoritativeResync) must reconcile the
// server's current list into those buckets without fighting the stream. These
// pure helpers make that reconciliation race-safe and failure-isolated:
//   - Fetch failures are per-source: a failed source yields null and the
//     caller leaves that bucket alone, so a permission failure never blocks
//     question forms (and vice versa).
//   - A successful fetch replaces the bucket with the server snapshot minus
//     anything resolved, but never loses a request the SSE stream added while
//     the fetch was in flight — an older snapshot cannot clobber it.
//   - Resolved ids (optimistic replies/rejects, form.replied/cancelled events)
//     stay excluded, so a resolution is never resurrected by a stale snapshot.

export interface PendingItem {
  id: string
  sessionID: string
}

export type PendingBuckets<T extends PendingItem> = Record<string, T[]>

export interface PendingMergeParams<T extends PendingItem> {
  /** The server's current pending list (a successful fetch). */
  snapshot: readonly T[]
  /** Bucket state captured when the fetch started. */
  before: Readonly<Record<string, readonly T[]>>
  /** Bucket state when the fetch resolved; may include mid-fetch SSE updates. */
  current: Readonly<Record<string, readonly T[]>>
  /** Resolved ids; never re-surfaced by a snapshot. */
  resolved: ReadonlySet<string>
}

export function mergePendingBuckets<T extends PendingItem>(params: PendingMergeParams<T>): PendingBuckets<T> {
  const { snapshot, before, current, resolved } = params
  const beforeIDs = new Set<string>()
  for (const items of Object.values(before)) for (const item of items) beforeIDs.add(item.id)

  const buckets: PendingBuckets<T> = {}
  const seen = new Set<string>()
  const add = (item: T) => {
    if (seen.has(item.id) || resolved.has(item.id)) return
    seen.add(item.id)
    ;(buckets[item.sessionID] ??= []).push(item)
  }

  // Authoritative snapshot first: it replaces pre-fetch state for everything
  // it reports and silently drops pre-fetch entries it no longer lists (that
  // is the missed-event recovery a refresh exists for).
  for (const item of snapshot) add(item)

  // Mid-fetch SSE arrivals (in `current`, not in `before`) were not visible
  // to the snapshot: keep them, deduped, so an older snapshot cannot erase a
  // request that arrived while the fetch was in flight. Entries already
  // pending before the fetch are handled by the snapshot path above.
  for (const items of Object.values(current)) for (const item of items) {
    if (beforeIDs.has(item.id)) continue
    add(item)
  }
  return buckets
}

export interface PendingSourceReconcile<T extends PendingItem> {
  /** Server response for this source; null means the fetch failed. */
  fetched: readonly T[] | null
  before: Readonly<Record<string, readonly T[]>>
  current: Readonly<Record<string, readonly T[]>>
  /** Pruned in place to drop ids the server no longer reports. */
  resolved: Set<string>
}

/**
 * Reconcile one source end-to-end. Returns null when the fetch failed so the
 * caller leaves that source's bucket untouched; otherwise the updated buckets.
 * Each source is reconciled independently, so a successful source always
 * produces its own bucket updates even when another source fails.
 */
export function reconcilePendingSource<T extends PendingItem>(params: PendingSourceReconcile<T>): PendingBuckets<T> | null {
  const { fetched, before, current, resolved } = params
  if (fetched === null) return null
  pruneResolved(resolved, fetched)
  return mergePendingBuckets({ snapshot: fetched, before, current, resolved })
}

/**
 * Drop resolved ids the server no longer lists so the exclusion sets don't
 * grow without bound, while keeping ids the server still reports — a request
 * resolved optimistically but still pending server-side must stay excluded
 * until the server settles it.
 */
export function pruneResolved<T extends PendingItem>(resolved: Set<string>, stillPending: readonly T[]): void {
  const stillPendingIDs = new Set(stillPending.map((item) => item.id))
  for (const id of [...resolved]) if (!stillPendingIDs.has(id)) resolved.delete(id)
}

export function replacePendingSessions<T extends PendingItem>(
  current: PendingBuckets<T>,
  reconciled: PendingBuckets<T>,
  sessionIDs: ReadonlySet<string>,
): PendingBuckets<T> {
  const next = { ...current }
  for (const sessionID of sessionIDs) {
    const items = reconciled[sessionID]
    if (items?.length) next[sessionID] = items
    else delete next[sessionID]
  }
  return next
}

/**
 * Session IDs a directory-scoped pending snapshot is authoritative for: the
 * sessions the snapshot itself names, plus `localSessionIDs` (the cached
 * sessions that belong to the same directory). The events store keeps pending
 * buckets globally across directories, but `permission.list`/`form.requestList`
 * only see the client's own directory. Replacing every bucket would wipe
 * another project's prompts, which no later refresh on this screen would
 * recover.
 */
export function pendingSnapshotScope<T extends PendingItem>(
  snapshot: readonly T[] | null,
  localSessionIDs: Iterable<string>,
): Set<string> {
  const ids = new Set(localSessionIDs)
  for (const item of snapshot ?? []) ids.add(item.sessionID)
  return ids
}
