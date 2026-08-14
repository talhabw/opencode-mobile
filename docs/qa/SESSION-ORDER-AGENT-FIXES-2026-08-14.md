# Session Ordering and Agent Selection Fixes

Date: 2026-08-14

## Summary

Two regressions appeared after the OpenCode v2 migration:

1. In a new session, a user message could move below the assistant response after the response arrived. Reopening the session sometimes repaired the order and sometimes did not.
2. Selecting a non-Auto agent, such as Build, added an `Agent switched to Build` timeline entry but produced no user message or assistant response.

Both failures were specific to the mobile client's v2 state adaptation. The same sessions behaved correctly in the TUI.

## Message Ordering

### Root Cause

The server returns the first message page in descending order. The mobile client reverses that page for chronological display, but its refresh merge preserved the positions of messages already received over SSE.

A typical race was:

1. The optimistic user message was added.
2. An assistant message arrived over SSE.
3. The temporary user message was reconciled.
4. The canonical page returned in correct user/assistant order.
5. The merge retained the assistant's existing index and appended the newly discovered user message, producing assistant/user order.

Warm reopens reused the malformed local ordering, which explained why reopening only sometimes repaired the conversation.

Review also found related stale-response races. A canonical request started before an SSE update could overwrite an in-flight message or part update, resurrect a removed message, discard a new optimistic message, or let an older concurrent refresh win.

### Solution

- Treat the refreshed first page as authoritative for canonical ordering.
- Reconcile it against message and parts snapshots captured when the request starts.
- Preserve messages and parts added, replaced, or removed while the request is in flight.
- Keep previously loaded older history before the refreshed first page.
- Remove reconciled pre-request optimistic placeholders without dropping new sends.
- Sequence canonical page requests so an older response cannot overwrite a newer one.
- Update parts with the same snapshot semantics, including streamed updates, deletions, and parts that arrive before their message.

Regression tests cover assistant-first repair, loaded history, optimistic sends, new SSE messages, same-ID streaming updates, removals, parts updates and deletions, orphan parts, and canonical deduplication.

## Agent Selection

### Root Cause

The v2 agent catalog separates an agent's wire ID from its display name. For example:

```json
{
  "id": "build",
  "name": "Build"
}
```

The mobile client used the display name as the selected wire value and called the agent switch endpoint with `Build`. Agent resolution is case-sensitive, so the server recorded the switch timeline item but then failed the run with `AgentNotFoundError: Agent not found: "Build"`. No prompt or assistant response was created.

### Solution

- Store and send `AgentInfo.id` as the canonical selection value.
- Keep `AgentInfo.name` only as the human-readable UI label.
- Preserve custom agent IDs exactly instead of applying broad case conversion.
- Map older persisted display-name selections, such as `Build`, back to the catalog ID, such as `build`, so the next send performs a corrective switch.
- Apply `session.agent.selected` and `session.model.selected` events to local session state.
- Skip agent and model switch calls only when the session already has the exact requested selection.
- Continue omitting an agent selection in Auto mode so the server chooses its configured default.

## Verification

- TypeScript typecheck passed.
- All 252 tests passed.
- `git diff --check` passed.
- A physical Android device test selected `build`, sent two prompts, and received both assistant responses.
- Only one agent-switch event was created; the second prompt reused the persisted selection.
- User messages remained above their assistant responses both live and after reopening the session.
- Temporary test sessions were removed.
- An arm64 release APK was built with optional Sentry upload disabled, installed over the existing app while preserving data, and launched successfully without Metro.

Release artifact:

```text
android/app/build/outputs/apk/release/app-release.apk
SHA-256: dbe097b8d40bc21e04cc1d3ea3d66143b4b95a70ac5675f37c9f13caea91c7c5
```
