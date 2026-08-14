# OpenCode Mobile Requests Implementation Status

Date: 2026-08-14
Source: `requests.md`, plan: `docs/REQUESTS-IMPLEMENTATION-PLAN.md`

Work-package status tracking for the requests implementation plan. This
document records what is done, what is deliberately deferred, and why.

## Phase 0 — Baseline and Reproduction Harness

### Latest update — 2026-08-14 (streaming responsiveness)

- Reproduced the reported "UI unresponsive while a message streams" issue on
  the API 36 emulator with a deterministic 100 Hz / 1,200-chunk fixture stream
  (`fixture:stream-stress`): a follow-up input automation waited 12.8 s for the
  stream to finish.
- Fixed by coalescing text/reasoning part updates to at most 10 visual commits
  per second, rendering the active assistant row as a bounded 2 KB plain-text
  preview while streaming (full Markdown returns when the run ends), and using
  a stable empty-array selector in `ToolCallCard` (removes React's
  `getSnapshot should be cached` warning). Details under WP 1.2.
- Re-verified on the emulator: direct Android text input completed in about
  1.0 s during the same stream and stayed in the composer. No React errors.
- Current gate: `bun run typecheck` clean, `bun test` 285 pass / 0 fail across
  47 files, `bun run dev:fixture:test` pass, `git diff --check` clean.
- Release artifact: rebuilt arm64 release APK at
  `android/app/build/outputs/apk/release/app-release.apk` (38,300,392 bytes,
  SHA-256 `d1dc0b2a318dfcf563a7c6c76a904382db91326b37112e82e49e3c0aad8e96de`)
  with `SENTRY_DISABLE_AUTO_UPLOAD=true`; sent to the user via Telegram.
- Development environment (`bun run dev:env:stop`) was stopped.

### Done

- The WP 0.1 validation gate is green on the current worktree:
  `bun run typecheck` (clean), `bun test` (245 pass / 0 fail across 36
  files), `bun run dev:fixture:test` (fixture matches the generated v2 client
  protocol), and `git diff --check` (clean).
- The phone-free harness from `docs/DEVELOPMENT-ENVIRONMENT.md`
  (`bun run dev:env`) provides deterministic fixture-server state, covered by
  `tests/fixtures/opencode-v2-server.test.ts`.
- Deterministic fixture reproductions exist for the Phase 1 bugs: standalone
  shell messages, sent-message visibility, and transport background/foreground
  behavior. Real-server reproductions and the WP 0.1 screenshot/video record
  are not part of this worktree's evidence.

## Phase 1 — Correctness and Lifecycle Bugs

### WP 1.1 — Remove the first-message transcript flash

Done:

- `src/stores/sessions.ts` splits the single `isLoading` flag into
  `isSessionsLoading` (list) and `isSessionLoading` (transcript/cold
  selection). `loadSessions()` updates only list loading state;
  `selectSession()` only transcript loading state.
- `app/(tabs)/index.tsx` consumes `isSessionsLoading` and
  `app/session/[id].tsx` consumes `isSessionLoading`, so a background
  title/list refresh can no longer replace an open transcript with a spinner.

### WP 1.2 — Keep sent and streaming content visible

Done:

- Explicit inverted-list bottom-pinning policy in `src/lib/session-scroll.ts`:
  `shouldPinToBottom({ trigger, nearBottom })` always pins after an
  `optimistic-send` and pins on content/layout changes only when the user is
  already near the bottom.
- `app/session/[id].tsx` pins to offset zero immediately after a send commits
  and applies the policy to content-size and layout changes; a user reading
  older history is never force-scrolled.
- Streaming text/reasoning events are coalesced by part to at most 10 visual
  updates per second, and the active assistant row uses a bounded 2 KB plain
  text preview instead of reparsing and laying out the entire growing Markdown
  response. The complete response remains in state and renders as Markdown
  when streaming ends. The fixture command `fixture:stream-stress` emits 1,200
  chunks at 100 Hz for deterministic regression checks. On the API 36 emulator,
  direct Android text input completed in about 1.0 seconds during that stream;
  before mitigation, an equivalent automation action waited 12.8 seconds for
  the stream to finish.
- `ToolCallCard` uses a stable empty question-array selector result. This removes
  React's `getSnapshot should be cached` warning and prevents unrelated event
  updates from repeatedly rerendering task cards.

### WP 1.3 — Fix microphone permission and error handling

Done:

- Removed `microphonePermission: false` from the `expo-image-picker` config in
  `app.json` and removed the `tools:node="remove"` suppression of
  `RECORD_AUDIO` in `android/app/src/main/AndroidManifest.xml`; the manifest
  now declares the permission normally.
- `src/lib/speech-errors.ts` defines typed failure reasons (denied, blocked,
  recognizer unavailable, audio capture, network, busy, language, runtime);
  `classifySpeechPermission` distinguishes deny from permanently blocked via
  `canAskAgain`, and `mapSpeechError` maps native error codes.
- `src/lib/speech.ts` clears stale errors, checks recognizer availability,
  catches permission/start failures, and surfaces typed reasons instead of
  raw strings.
- `app/session/[id].tsx` shows a per-reason alert and offers an "Open
  Settings" action (`Linking.openSettings`) after permanent block.

### WP 1.4 — Preserve and render standalone shell messages

Requests covered:

- The `<shell id=...>` message rendered as ordinary assistant text.

### Done

- Canonical persisted standalone shell messages are preserved end-to-end:
  `SessionMessageShell` (with its own `messageID`/`shellID` pair) is
  normalized in `src/lib/protocol-v2.ts` (`baseMessage` → `presentation:
  "shell"` keeping id, shellID, command, status, exit, output, and timing) and
  rendered by the dedicated `ShellMessage` component.
- Non-shell projected variants (agent/model switch, location switch,
  compaction, synthetic, skill, system) receive intentional system-row
  treatment; no standalone protocol message is labeled as a plain Assistant
  response.
- Live SSE `session.shell.started`/`session.shell.ended` events no longer
  fabricate a `message.updated`. Previously the live row used the shell id as
  the message id, which cannot be reconciled with the canonical page (keyed by
  the separate persisted message id); the refresh merge retained the SSE-only
  row and produced duplicates.
- Canonical refresh policy still triggers: `session.shell.ended` passes
  through with `canonicalRefresh: true` (supported by
  `shouldRefreshCanonicalMessages` in `src/lib/event-reconcile.ts`), so the
  debounced authoritative `refreshMessages()` runs and the canonical page
  remains the source of truth. No message is fabricated.

### Pending

- **Live-only shell lifecycle rows** (showing a running shell card as it
  starts, streams output, and finishes — without waiting for the canonical
  page) remain unimplemented until a shellID → messageID reconciliation
  exists between `session.shell.*` events and persisted `SessionMessageShell`
  rows. Until then, live shell lifecycle events are not rendered from the SSE
  stream; the canonical page refresh remains authoritative.

### WP 1.5 — Make foreground reconnect immediate and truthful

Done:

- `src/lib/transport-lifecycle.ts` separates transport phase from retry
  counters: `TransportPhase` (`stopped` | `paused` | `connecting` |
  `reconnecting` | `ready` | `auth-error`), `canAutoResume`, and
  `transportBannerState` (reconnect banner only while visibly retrying; green
  recovery flash only after a user-visible interruption).
- `src/stores/events.ts` adds non-destructive `pause()`/`resume()` and
  generation-guarded timers/callbacks so stale streams cannot write or
  duplicate; reconnect UI clears on the first parsed server event rather than
  the 10-second stability timer.
- `app/_layout.tsx` pauses the stream on Android background and resumes on
  foreground; a cold start while already backgrounded pauses instead of
  connecting. Pause keeps session status, permissions, questions, and
  messages intact.
- `resume()` auto-reconnects from `paused`/`stopped`/`reconnecting` but
  deliberately not from `auth-error` (resuming would replay failing
  credentials; recovery is a manual `connect()` after credential changes).

## Automated Verification

- `bun test`: 260 pass, 0 fail across 39 files (new coverage includes
  `session-scroll`, `speech-errors`, `transport-lifecycle`, extended
  `event-reconcile` and `protocol-v2` suites, and fixture protocol parity).
- `bun run typecheck`: clean.
- `bun run dev:fixture:test`: passes.
- `git diff --check`: clean.

## Phase 3 — Subagent Interaction

### WP 3.4 — Child-owned pending input and hierarchy navigation

Done:

- Pending questions remain grouped by their owning child `sessionID`; own and
  recursively loaded descendant counts are calculated without copying requests
  into parent buckets.
- Task cards read validated `state.metadata.sessionId` and expose a localized,
  accessible input-needed count that opens the exact child session and directory.
- Hierarchy rows distinguish own requests from descendant requests, including
  nested grandchildren. Parent sessions show an exact child/title/ID fallback
  only when no task metadata association is available.
- Notification payloads carry a known directory without entering telemetry, and
  notification taps resolve the cached or fetched child before routing.
- Pure hierarchy tests cover own/descendant totals, nested descendants, and
  exact unassociated fallback requests.

## Phase 2 — Selection and Context Clarity

### WP 2.1 — Directory-scoped catalog loading

Done:

- Catalog loading is session-directory-scoped: `src/stores/catalog.ts` resolves
  the directory-scoped client from `connections.clientForDirectory()` and
  fetches agents, commands, providers, config, and the effective model
  (`client.model.default()`) together for that exact scope.
- Race protection is explicit: a monotonic `requestSequence` plus the active
  connection identity (`isCurrentRequest`) guards every completion, so a stale
  response for a previous directory or connection can never write state.
- Stale options are cleared at load start, not on success:
  `beginCatalogLoad` in `src/lib/catalog-load.ts` resets agents, commands,
  providers, defaults, and the default resolution immediately so prior-directory
  options are never considered loaded or selectable for the new scope; a failed
  load (`failCatalogLoad`) leaves the requested scope unloaded with no stale
  prior options behind.
- Explicit pending selections (agent/model/variant) are preserved across a scope
  change and re-validated against the fresh catalog on success — kept only when
  still present and selectable in the scoped catalog; the effective model is
  exposed separately from the explicit model selection.
- Session focus and session-directory changes trigger the reload; pickers remain
  disabled and empty until that exact scope is loaded.

### WP 2.2 — Agent picker instead of cycling

Done:

- `src/components/chat/AgentPicker.tsx` is a searchable bottom sheet listing
  visible primary/all agents with display label, description, color, selected
  state, and accessibility labels; selection uses the canonical `AgentInfo.id`
  (`src/stores/catalog.ts` `setAgent`), never the display name.
- A default row is offered: "Use server default: <resolved name>" for new or
  never-overridden sessions (omission), or "Switch to current server default:
  <resolved name>" when a persisted override exists.
- The picker opens from the toolbar agent chip and from the `/agent` slash
  command in the composer; tap/long-press cycling is no longer a UI interaction.

### WP 2.3 — Resolved server-default labels

Done:

- `selectorLabel` in `src/lib/selection-ui.ts` shows an explicit selection
  as-is; otherwise it shows the resolved effective model label annotated with
  "· Server default", falling back to a bare "Server default" when the server
  default cannot be resolved — literal `Auto`/`default` text is never shown.
- `defaultActionDecision` truthfully distinguishes the three cases: no persisted
  override → "inherit" (the generic server-default row is always offered so a
  pending explicit choice can be cleared); persisted override with a resolved
  default → "concrete" (an explicit switch to the current default, which will
  not inherit later config changes); persisted override with unresolved default
  → "unavailable" (the row is hidden rather than misrepresented).
- Pending model choices (not yet applied) can be cleared for the next prompt;
  clearing the model also clears effort/variant. Default actions preserve
  omission semantics for new sessions.

Pending / blockers:

- **`default_agent` remains unresolved.** The pinned `ConfigEntry[]` API and
  the current fixture do not prove the required precedence/order, and
  `resolveDefaultAgent` (`src/lib/model-selection.ts`) requires an explicit
  ordering guarantee before treating any entry as effective. The catalog
  deliberately does not provide one, so no unsafe inference is made.
- **No reset endpoint.** The pinned API has no reset operation:
  `switchAgent`/`switchModel` require concrete values, so an already-overridden
  session is labeled truthfully as "Switch to current server default" (an
  explicit switch) and we never claim a persisted override was cleared.

### WP 2.4 — Context usage clarity

Done:

- The toolbar now uses a recognizable speedometer indicator, always shows a
  localized `Context N%`/unknown label, and opens the existing `SessionInfo`
  detail panel when pressed. The panel shows the context bar and the token
  breakdown pills (in/out/think/cache) for the same computation.
- Accessibility role (button), label ("Context window used, N percent"),
  hint, and expanded state are provided on the chip.
- Unknown limits are distinct from zero, zero and over-100 percentages are
  displayed deliberately, and only the latest eligible assistant response is
  used (`computeSessionUsage` in `src/lib/session-usage.ts`); system
  projections are excluded even though they use the assistant wire role.

Pending / blocker:

- The token-utilization formula remains the current unverified
  `input + output + reasoning + cache.read + cache.write` sum. No pinned V2
  documentation/schema statement was found to establish whether reasoning or
  cache values are additive or subcategories, so the arithmetic is
  intentionally unchanged until semantics are confirmed.

### WP 3.1 — Preserve and browse the session hierarchy

Done:

- The normalized SDK session page/list wrappers accept `parentID?: string | null`;
  root list loads and root pagination explicitly send `parentID: null`, while
  child pages send the exact parent id.
- `sessions` remains roots-only. `childrenByParent` holds direct children with
  independent loading, loaded, cursor, has-more, and generation state per
  parent. Child requests are guarded against deletion, connection changes, and
  directory changes; root refresh/pagination does not discard loaded hierarchy.
- Session create/update/rename/move/delete events route to the correct cache.
  Moving an update between root/child caches removes its prior placement, and
  deletion recursively purges cached descendants while incrementing request
  generations so in-flight pages cannot resurrect them.
- The sessions screen keeps root directory grouping and recursively renders only
  loaded descendants of independently expanded rows. Rows are collapsed by
  default, direct expansion is lazy, nested depth is visible, and per-parent
  loading/load-more controls are localized and accessible. Navigation,
  rename, and deletion use each row's own directory.

### WP 3.2 — Dedicated task/subagent cards and exact navigation

Done:

- Canonical and live tool parts preserve `state.metadata`; metadata is merged
  through input, called, progress, success, and failure lifecycle events.
- Task navigation uses only the validated canonical key
  `state.metadata.sessionId` and only when `tool === "task"`.
  `parentSessionId` is retained as advisory metadata; titles and tool output are
  never guessed as session ids.
- Task calls have a dedicated subagent presentation for agent/subagent type,
  summary, lifecycle state, and result. The explicit localized "Open subagent"
  action is independent of detail expansion and is absent when exact metadata
  is missing.
- Opening resolves the exact id from roots, any loaded hierarchy level, or an
  exact `session.get` through the current session's directory-scoped client,
  then navigates with the resolved child's directory. This avoids sibling,
  resumed-task, and nested-subagent ambiguity.

Verified:

- Pure tests cover recursive flattening/depth, root/child/update routing,
  recursive purge, and valid/invalid exact task metadata extraction.
- Protocol tests cover complete `session.created` normalization, canonical tool
  metadata, and metadata merge across live lifecycle events.
- The synthetic V2 fixture asserts wrapper root/child filtering and canonical
  task metadata. No external server data or credentials were used.
- `bun run typecheck`, full `bun test` (269 pass / 0 fail across 42 files),
  `bun run dev:fixture:test` (1 pass / 0 fail), and `git diff --check` pass.

Pending:

- No emulator or physical-device checks were run for WP 3.1/WP 3.2 in this
  slice. Visual expansion, deep indentation, and touch-target behavior remain
  device-validation items.
- Child-session question badges remain WP 3.4 and were not implemented. The
  hierarchy cache is keyed by exact session/parent ids so that work can consume
  it without changing the WP 3.1 data model.

### WP 3.3 — Complete current-session question UX

Done:

- Current-session questions now support per-page progress, back/next navigation,
  required validation, single/multiple selection, per-page custom drafts, and
  explicit handling for empty option lists with custom answers disabled.
- The prompt owns submitting/error state. Requests remain visible until reply or
  reject succeeds, so failed requests preserve all selections and drafts for retry;
  duplicate submissions are blocked while in flight.
- Reply and reject use the request's owning `sessionID`, and pure validation/draft
  helpers are covered by focused tests. English and Simplified Chinese strings,
  accessibility roles, labels, and test IDs were added.

Deferred:

- Child-session discovery and badges remain WP 3.4 and are intentionally unchanged.

## Emulator Evidence

Phone-free environment (`bun run dev:env`) on AVD `opencode-mobile-api36`,
driven via `agent-device` against the fixture server:

- Clean install displayed the Android microphone permission prompt.
- Denying the permission produced the specific permission-denied recovery UI.
- A fixture standalone shell message rendered as the dedicated Shell row with
  command, output, and exit code.
- Fast background/foreground transitions showed no reconnect banner.
- A sent fixture prompt and its reply remained visible (no hiding behind the
  running indicator).
- A pending question owned by a child session survived app resume.
- The session toolbar showed the resolved fixture labels: the agent chip read
  "Build" and the model chip read "Fixture Model · Server default" (the
  fixture's `/api/model/default` response), never literal `Auto`/`default`.
- The agent picker opened from the toolbar chip, listed the searchable
  primary/all agents "Build" and "Plan" with descriptions, and filtering by
  name narrowed the rows; selecting a row closed the sheet.
- The context chip on the fixture transcript read "Context 0%" (10 of 32768
  tokens, rounded down); pressing it opened the `SessionInfo` detail panel with
  the context bar and the token breakdown pills.

## Remaining Checks (Not Yet Verified)

- Physical-device validation: end-to-end dictation and the
  blocked-permission "Open Settings" behavior (permission-dialog and settings
  flows are device-dependent).
- Genuine offline / prolonged-disconnect / auth-error scenarios over a real
  network, including recovery UI and notification behavior after extended
  outages.
- Live-only shell lifecycle identity (WP 1.4 pending note): shellID →
  messageID reconciliation is unimplemented; the canonical page refresh
  remains authoritative.

## Phase 4 — Transcript Visual System

### WP 4.1-4.2 — Design contract and role/state treatment

Done:

- `docs/REQUESTS-DESIGN-CONTRACT.md` defines the concrete OpenCode Mobile
  developer-transcript subject, restrained code-review/terminal direction,
  compact hierarchy/surface/type/spacing/icon/color/interaction/light-dark/a11y
  tokens, and a self-critique of generic developer-tool choices.
- The selected signature element is a two-point assistant execution rail tied
  to the current accent palette. Assistant responses now sit directly on the
  transcript canvas rather than a hardcoded lavender rounded card, and generic
  person/sparkle role avatars were removed.
- User requests use a compact, offset neutral request block with a restrained
  rule rather than an oversized chat bubble. Role labels, shell identity, and
  shell lifecycle labels are localized in English and Simplified Chinese.
- Message-level failures have a color-independent label and alert semantics.
  Existing Markdown rendering, wide code/diff scrolling, tool/task expansion,
  exact subagent navigation, pending-question badges, question/permission
  semantics, user long-press actions, and `MessageBubble` memoization remain
  unchanged.
- Focused source regression tests guard against restoring the sparkle/lavender
  treatment and ensure Markdown, tool calls, long-press, memo comparison, and
  error visibility remain wired.

Verified:

- `bun run typecheck`, full `bun test` (274 pass / 0 fail across 43 files),
  `bun run dev:fixture:test` (1 pass / 0 fail), and `git diff --check` pass on
  the combined Phase 1-4 worktree.

Remaining visual evidence:

- Capture fixture transcript screenshots for all four accent palettes in light
  and dark themes.
- Capture narrow-screen screenshots at the default and largest supported system
  font scale, including long localized role/model metadata, a wide code block,
  a diff, shell output, task input badge/navigation, question, permission, and
  message/tool error states.

## Phase 5 — Fork-Owned Crash Reporting And Analytics

### WP 5.1 — Local implementation complete

- Removed the upstream Sentry organization/project assumptions. Expo applies
  the Sentry config plugin only when fork-owned `SENTRY_ORG` and
  `SENTRY_PROJECT` build variables exist; `android/sentry.properties` contains
  no organization, project, URL, or credential.
- Missing public DSN/key is a strict runtime no-op. Sentry and PostHog initialize
  only after explicit consent. Revocation blocks transport before shutdown, and
  PostHog buffering is memory-only so a later re-enable cannot resurrect a
  persisted pre-revoke queue.
- A canonical recursive Sentry boundary removes user/request/auth/content fields,
  free-form messages, exception values/source, arbitrary breadcrumbs, paths,
  URLs, hosts, IPs, tags, contexts, extras, and span content while preserving
  only content-free crash and normalized bundle-coordinate data.
- Every analytics event now has an exact runtime primitive-property allowlist;
  unknown keys, nested values, invalid enum values, and raw errors are dropped.
- Operator and disclosure checkpoints are documented in
  `docs/TELEMETRY-OPERATIONS.md` and
  `docs/PRIVACY-AND-STORE-DISCLOSURES.md`.

Verified locally with no telemetry configuration:

- `bun run typecheck`, full `bun test` (283 pass / 0 fail across 46 files),
  `bun run dev:fixture:test`, and `git diff --check` pass.
- Expo public config contains no Sentry plugin or upstream slug without
  `SENTRY_ORG`/`SENTRY_PROJECT`.
- The production arm64 release APK built with
  `SENTRY_DISABLE_AUTO_UPLOAD=true`; the upload task was skipped. APK inspection
  found only `arm64-v8a`, no source map/module manifest, no embedded DSN,
  PostHog project key, or upstream organization slug.

### WP 5.2 — Documentation complete; external checkpoint pending

The user must create the fork-owned Sentry and EU PostHog projects and provide
only the documented minimum values through untracked local or actual CI/EAS
secret storage. No external account or credential was available during this
work, so no provider project, alert, retention, rate-limit, dashboard, ingest,
payload, or source-map setting has been inspected or accepted.

The controlled release exception remains unverified in a fork-owned Sentry
project. PostHog project acceptance of the activation events and provider-side
payload audit also remain unverified. These are explicit user checkpoints, not
claims of completion; follow the release matrix in
`docs/TELEMETRY-OPERATIONS.md` after provisioning.
