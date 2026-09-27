// Project-scoped durable "allow" rules saved by replying "Always" to a
// permission request. Shape mirrors the server's PermissionSavedInfo.
export interface SavedPermission {
  id: string
  projectID: string
  action: string
  resource: string
}

/**
 * Keep only approvals belonging to `projectID`.
 *
 * The server's list route filters by projectID, but older or non-conforming
 * servers may ignore the query parameter and return every project's grants.
 * The settings review list must never present — or let the user delete — an
 * approval from another project, so the scope is enforced on the response as
 * well as on the request.
 */
export function savedPermissionsForProject<T extends { projectID: string }>(
  items: readonly T[],
  projectID: string,
): T[] {
  return items.filter((item) => item.projectID === projectID)
}
