# Bug Fix Round 2 - Device Test Findings

> Historical plan for the August beta build. API and compatibility notes below are not the current released-v2 implementation; see [the current review](V2-REVIEW-2026-09-27.md).

Date: 2026-08-14
Inputs: user device test against a real OpenCode v2 server (`opencode2 v0.0.0-next-17444`,
client SDK in tree: `next-17403`), plus code inspection of this checkout.

Scope: six defects reported after on-device testing of the Phase 1-4 work.

## Findings And Fixes

### 1. UI unresponsive during tool calls / thinking blocks

Evidence gathered:

- Text/reasoning part updates are coalesced (`LatestValueBuffer`, 10/sec) but tool part
  updates are NOT: `session.tool.input.delta` and `session.tool.progress` call
  `useSessions.handleEvent` once per SSE event, each one a full zustand `set`.
- `V2EventAdapter` runs `JSON.parse` on the accumulated raw tool-input JSON on every
  delta (O(n^2) for large `write`/`edit`/`apply_patch` inputs).
- Mid-run canonical refreshes: `session.tool.called/success/failed`,
  `session.step.ended/failed`, `session.text.ended`, `session.reasoning.ended` all
  schedule a debounced full `refreshMessages()` (`CANONICAL_REFRESH_EVENTS`). During an
  agentic run this fires nearly continuously: full message-page fetch + parse + merge,
  replacing every part object (memo comparators fail, all visible rows re-render,
  Markdown re-parses).

Fix plan:

- Route tool part updates through the coalescing buffer; flush immediately on state
  transitions (input.started, called, success, failed).
- Defer `JSON.parse` of streamed tool input to flush points; keep raw accumulation
  between them.
- While the current session is busy, skip mid-run canonical refreshes (they are
  redundant: live terminal events carry final output/text). Keep the refresh on idle
  transitions (`session.execution.*`, `session.error`) and on reconnect resync.
- Add a fixture stress scenario (high-frequency tool input deltas, progress spam, rapid
  tool completions) and measure input latency on the emulator like WP 1.2 did, before
  and after.

### 2. Questions render as a stuck tool call; no question UI

Root cause (confirmed in the server binary): since the server version in use, the
`question` tool surfaces requests through the forms API, not `question.asked`:

- The tool calls `form ask` with `title: "Questions"`,
  `metadata: { kind: "question", tool: { messageID, id } }` and one field per question
  (`key: "q0"..., type: "string" | "multiselect", options, custom: true`).
- Clients receive `form.created` / `form.replied` / `form.cancelled` events and use
  `form.list`, `form.reply({ sessionID, formID, answer })`, `form.cancel`.
- The app only implements the legacy `question.asked` path, so the tool call hangs as
  "running" with no way to answer.
- Default agents auto-allow the `question` permission, so no permission prompt is
  involved.

Fix plan:

- Add `form.*` wrappers to `src/lib/sdk.ts` (typed, no `any`).
- Map `kind: "question"` forms into the existing pending-question store shape (a
  canonical internal view type with a `transport: "question" | "form"` tag) so the WP
  3.3/3.4 UX (prompt, badges, child-session navigation, notifications) keeps working
  unchanged.
- Keep legacy `question.asked` handling for the fixture and older servers.
- Recovery: include pending forms in `refreshPending` and the reconnect resync
  (`form.request.list` is location-scoped; `form.list` is per-session).
- Reply: `form.reply` with `{ qN: value | values[] }`; reject maps to `form.cancel`.
- Reuse existing `chat.questionPrompt.*` i18n keys.

### 3. `read` tool call content is empty

`ReadDetail` in `ToolCallCard.tsx` renders only the file path; the tool output (file
content, already normalized through `contentOutput`) is never displayed. Fix: render
the output like `BashDetail` (monospace block, bounded lines).

### 4. Subagent rows show a chevron that disappears when empty

`canExpand` is `!childrenLoaded || children.length > 0`, so every row shows a chevron
until its children are fetched. `SessionInfo` has no child count, so:

- Prefetch the directory's sessions once per refresh (`session.list` without
  `parentID` returns roots AND children) and derive `childCountByParent`.
- Maintain counts from `session.created` / `session.deleted` events; once real children
  are loaded for a parent, the loaded list is authoritative.
- Show the chevron only when the count is known to be > 0 (or loaded non-empty).
  Subagents with their own subagents keep the chevron; leaf subagents never show it.

### 5. `<shell ...>` / `<subagent ...>` rendered as info text

The server injects synthetic messages whose `text` is exactly
`<shell id="call_..." state="completed|error|cancelled" command="...">` (background
shell completion) and
`<subagent id="ses_..." state="..." description="...">` (subagent completion).
`normalizeMessage` currently dumps that raw text into a system row.

Fix plan:

- Parse the two known tag shapes in `protocol-v2.ts` into structured data:
  - shell tag -> the existing `presentation: "shell"` row (command + state, no output).
  - subagent tag -> a new dedicated row with state + description + an "Open subagent"
    action navigating to the exact child session id from the tag (reusing task-card
    navigation); recursively works because it relies only on the id.
- Unparseable synthetic text keeps the plain system-row fallback (no string matching
  beyond the two documented tag shapes).
- Handle the live `session.synthetic` event as a canonical refresh trigger (it carries
  no message id, so fabricating a live row would duplicate on refresh - same reasoning
  as WP 1.4 for shell events).

### 6. Expanding a tool call moves the tapped header up

Inverted list + bottom pinning: when a row grows, offset stays 0 and everything above
the growth point (including the tapped header) slides up by the height delta. Fix:

- Expandable rows report toggles to the session screen (callback through
  `MessageBubble` -> `ToolCallCard`/`TaskSubagentCard`).
- On the next content-size change, suppress bottom pinning and adjust the scroll offset
  by the height delta (`offset += delta` on expand, `-= ` on collapse) so the tapped
  header stays under the finger and the card opens downward.
- Extend `session-scroll.ts` with a unit-tested policy for this case.

## Verification Strategy

- Unit/fixture: extend `tests/fixtures/opencode-v2-server.ts` (form events, synthetic
  messages, tool streaming stress) plus pure helper tests; `bun run typecheck`,
  `bun test`, `bun run dev:fixture:test`, `git diff --check`.
- Emulator: `bun run dev:env` + `agent-device` regression checks per fix.
- Physical device (now available, debug-signed builds install over the existing app
  with data preserved): drive real flows against the user's server in temporary
  sessions only - form question ask/answer/reject, read output, synthetic rows,
  chevron behavior, typing latency during a live run, expansion anchor. Rebuild and
  reinstall the release APK afterwards.

## Orchestration

- Wave 1 (parallel, disjoint files): forms/questions; protocol rendering (synthetics +
  read output); hierarchy chevron.
- Wave 2 (parallel): streaming responsiveness (coalescing + refresh gating) and
  expansion scroll anchor (both depend on Wave 1 files).
- Wave 3: integration, emulator + physical-device validation, release rebuild, status
  doc update.
