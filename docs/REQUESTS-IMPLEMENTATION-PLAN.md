# OpenCode Mobile Requests Implementation Plan

Date: 2026-08-14
Source: `requests.md`

## Goal

Implement every request in `requests.md` without regressing the OpenCode v2 migration, real-time SSE behavior, directory scoping, or server-default agent/model semantics. The order below fixes state and protocol defects before building hierarchy and then redesigning the UI on top of stable behavior.

## Confirmed Findings

- The microphone bug is caused by `expo-image-picker` removing `RECORD_AUDIO` from the generated Android manifest while `expo-speech-recognition` expects it.
- The first-message flash is caused by one global `isLoading` flag being shared by the sessions list and the session transcript. A background title/list refresh temporarily replaces the open transcript with a spinner.
- The leading diagnosis for the sent-message visibility bug is a scroll/layout race: the busy indicator changes the list viewport after the optimistic message is inserted, while scrolling only reacts to content-size changes. Phase 0 must verify this on-device before the fix is finalized.
- The reconnect banner is not an accurate readiness indicator. The first retry is delayed, and the banner remains tied to a 10-second stability timer even after the stream is usable.
- Question API support already exists for the open session: pending-list recovery, SSE events, multi-question prompts, single/multiple choice, custom answers, reply, and reject. The missing areas are complete validation, better UX, and discovery of questions owned by child sessions.
- OpenCode v2 supports questions in subagent sessions. A child question is keyed by the child `sessionID`; the mobile app currently stores it correctly but does not expose it while the parent is open.
- Session hierarchy is available through `Session.parentID` and `session.list({ parentID })`, but the app currently requests all sessions and renders children as roots.
- Task/subagent tool metadata can identify a child session, but the mobile protocol adapter currently discards tool metadata.
- The diamond percentage is estimated context-window utilization for the latest assistant response. The icon has no label, action, or accessibility explanation.
- Standalone v2 shell messages are flattened into ordinary assistant text. They need protocol-level classification and a dedicated renderer; string matching for `<shell ...>` is not an acceptable fix.
- “Auto” agent and “default” model are not actual catalog entries. They mean “omit the explicit selection and let the server use `default_agent` and its resolved default model.” The app can fetch and display those effective defaults.
- Sentry and PostHog are already integrated and consent-gated, but Sentry still contains upstream organization/project assumptions and neither service is provisioned for this fork.

## Product Decisions

These defaults should be followed unless the user changes them during implementation.

1. **Server defaults remain authoritative.** Do not create a global mobile-only agent/model default that silently diverges from the TUI. Show the resolved server values instead of ambiguous `Auto`/`default` labels.
2. **Selections apply to the current session on the next prompt.** Preserve the current safe switch-before-prompt behavior unless immediate switching is explicitly requested later.
3. **Subagent questions remain owned by the child session.** The parent shows an “Input needed” badge/link on the relevant subagent card; opening the child displays the full question UI and sends replies with the correct child `sessionID`.
4. **The sessions screen shows root sessions by default.** Direct children appear nested under their parent, collapsed initially when appropriate. Nested subagents can recursively expose their own children.
5. **Telemetry stays opt-in and content-free.** No prompt, code, path, hostname, server URL, credential, or raw error may be sent.

## Design Skills

Use these during the visual-design phase, after behavior and special message types are stable:

- `vercel-react-native-skills`: React Native/Expo performance and native UI practices; about 187K installs, 30K GitHub stars, official Vercel source. Install with `bunx skills add https://github.com/vercel-labs/agent-skills --skill vercel-react-native-skills`.
- `frontend-design`: deliberate, non-generic visual direction; about 775K installs, 169K GitHub stars, official Anthropic source. Install with `bunx skills add https://github.com/anthropics/skills --skill frontend-design`.
- `anti-ui-slop`: optional final critique/finish gate; about 279K installs. Install with `bunx skills add https://uizze.com --skill anti-ui-slop`. Treat it as a review aid, not the primary React Native implementation guide.

Use `bunx skills add ...`, not npm/npx, if the orchestrator needs to install them. Inspect each skill before installation and do not add generated skill files to this repository unless intentionally requested.

## Phase 0: Baseline and Reproduction Harness

### Work Package 0.1: Establish measurable regressions

Before changing behavior:

- Record current screenshots/video for the session list, transcript, selectors, question prompt, tool cards, reconnect banner, and context indicator in light and dark themes.
- Create deterministic real-server reproductions for first-message title generation, long-running responses, standalone shell messages, task/subagent creation, and child questions.
- Add test fixtures or pure helpers where store/component behavior cannot be tested directly.
- Keep the existing server and real user sessions untouched; create and remove named temporary sessions.

Acceptance:

- Each bug has a reproduction that would fail if its fix were removed.
- `bun run typecheck`, `bun test`, and `git diff --check` are clean before implementation begins.

## Phase 1: Correctness and Lifecycle Bugs

### Work Package 1.1: Remove the first-message transcript flash

Requests covered:

- “After creating a session and sending the first message, everything flashes like it reloads after the agent answers.”

Implementation:

- Split sessions-list loading from session-detail loading in `src/stores/sessions.ts`.
- Make `loadSessions()` update only list loading state.
- Make `selectSession()` update only transcript/cold-selection state.
- Ensure `session.created`, automatic title/rename events, reconnect resync, and list refreshes never unmount a visible transcript.
- Update `app/(tabs)/index.tsx` and `app/session/[id].tsx` to consume the correct flags.

Acceptance:

- Automatic first-message title generation updates the header/list without showing a blocking transcript spinner.
- A background sessions-list refresh cannot hide an open conversation.
- Cold-opening a session still shows an appropriate loading state.

### Work Package 1.2: Keep sent and streaming content visible

Requests covered:

- “After sending a message ... it stays behind the ... running indicator.”

Implementation:

- Define and test an explicit inverted-list bottom-pinning policy.
- Always pin to offset zero after a local optimistic send commits.
- Continue following assistant streaming only if the user was already near the bottom.
- Re-pin on busy-indicator, keyboard, and list-layout height changes only when the user was at the bottom.
- Never force-scroll a user who is reading older history.
- Consider reserving stable status height or moving status into the list footer if it simplifies layout without wasting space.

Acceptance:

- A newly sent message remains fully visible when status changes to busy/running.
- Streaming follows naturally at the bottom.
- Scrolling upward disables forced autoscroll and exposes the existing return-to-bottom control.
- Behavior passes with keyboard open/closed and on a narrow Android screen.

### Work Package 1.3: Fix microphone permission and error handling

Requests covered:

- “The mic button ... says check permissions, but the app does not ask for mic permission.”

Implementation:

- Remove the conflicting `microphonePermission: false` image-picker configuration.
- Regenerate/synchronize native Android configuration and confirm the merged manifest declares `RECORD_AUDIO` normally.
- Harden `src/lib/speech.ts`: clear stale errors, check recognizer availability, catch permission/start failures, and expose typed failure reasons.
- Distinguish denied, permanently blocked, unavailable recognizer, and start/runtime errors in the UI.
- Offer “Open Settings” after permanent denial.

Acceptance:

- A fresh install displays the Android microphone permission prompt.
- Allow starts dictation and appends transcript text.
- Deny, “don’t ask again,” revoked permission, and unavailable recognizer each show accurate recovery UI.
- Verify the release manifest, not only `app.json`.

### Work Package 1.4: Preserve and render standalone shell messages

Requests covered:

- The `<shell id=...>` message rendered as ordinary assistant text.

Implementation:

- Extend normalized messages with an explicit presentation kind instead of assigning every non-user message the assistant role visually.
- Preserve standalone shell ID, command, status, output, exit code, truncation, and timing in `src/lib/protocol-v2.ts`.
- Add a dedicated compact terminal/system renderer, sharing low-level command/output styles with `ToolCallCard` where useful.
- Audit other projected v2 message variants such as agent/model switch, location switch, compaction, synthetic, skill, and system messages; give each an intentional system-row treatment.
- Do not detect shell messages by parsing XML-looking text.

Acceptance:

- Standalone shell running, completed, failed, timed-out, killed, truncated, and long-output states render intentionally.
- Normal shell tool calls continue to use tool cards.
- No standalone protocol message is mislabeled as an ordinary Assistant response.

### Work Package 1.5: Make foreground reconnect immediate and truthful

Requests covered:

- Slow “Reconnecting (attempt 1)” followed by delayed green “connection secured” after foregrounding.

Implementation:

- Separate stream phase/readiness from retry/backoff counters in `src/stores/events.ts`.
- Add non-destructive `pause()`/`resume()` transport lifecycle methods.
- On Android background, stop the physical stream/retry timer without clearing session status, permissions, questions, or messages.
- On foreground, immediately open a fresh stream, bypass stale backoff, and perform authoritative resync once ready.
- Clear reconnect UI on the first confirmed server event, not after the 10-second backoff-stability reset.
- Suppress banners for very fast routine resumes; show green recovery only after a user-visible interruption.
- Preserve auth-error behavior and prolonged-disconnect notifications.

Acceptance:

- Fast foreground resumes do not display a misleading reconnect sequence.
- Genuine network loss shows accurate connecting/reconnecting state and clears immediately when ready.
- Missed status, permission, and question state is recovered after resume.
- Repeated lifecycle transitions cannot create duplicate streams.

## Phase 2: Selection and Context Clarity

### Work Package 2.1: Make catalog loading session-directory aware

This is a prerequisite for trustworthy selectors.

Implementation:

- Load agents, models, configuration, and defaults from the current session’s directory-scoped client.
- Add race protection when switching sessions/directories.
- Validate persisted/current selections against that scoped catalog.
- Never infer a selection from the first provider or agent.

Acceptance:

- Opening sessions from different projects shows each project’s correct agents, models, variants, and defaults.
- Changing directories cannot leave stale selector options on screen.

### Work Package 2.2: Replace agent cycling with a real picker

Requests covered:

- “Make the agent selector similar to model and effort selectors, not click to change.”

Implementation:

- Add an `AgentPicker` bottom sheet matching established model/variant interaction patterns.
- Show canonical primary/all agents with display label, description, color, selected state, and accessibility labels.
- Use `AgentInfo.id` on the wire and `AgentInfo.name` only for display.
- Make `/agent` open the picker instead of silently cycling.
- Remove tap/long-press cycling as the primary interaction.
- Make the selector row horizontally safe on narrow screens.

Acceptance:

- Users can inspect all valid agents and deliberately select one.
- Custom IDs preserve exact casing and display names are never sent to the API.
- Picker state follows the currently open session.

### Work Package 2.3: Replace ambiguous Auto/default labels with resolved server defaults

Requests covered:

- “What is auto agent and default model? ... let’s not have them ... or make defaults configurable.”

Implementation:

- Fetch the effective model with `model.default()` and resolve `default_agent` from location-scoped configuration.
- Verify the ordering of the `ConfigEntry[]` returned by the running pinned server. Apply the documented OpenCode precedence only after confirming that the entries correspond to global config, direct configs from root to current directory, then `.opencode` configs from root to current directory, with later values overriding earlier ones. Do not assume the first entry is effective.
- Keep omission semantics so OpenCode server config remains authoritative.
- In the toolbar, display the effective agent/model names rather than literal `Auto` and `default`. A subtle “server default” annotation may appear inside pickers/details.
- For a new or never-overridden session, offer “Use server default: <resolved value>” and preserve omission semantics.
- The pinned API has no reset endpoint: `switchAgent` and `switchModel` require concrete values. For an already-overridden session, label the action truthfully as “Switch to current server default: <resolved value>”; this is an explicit switch and will not inherit later config changes. Research the running server/OpenAPI again before implementation in case a reset operation has been added.
- Allow a not-yet-applied explicit model choice to be cleared before sending; clearing the model also clears effort/variant. Do not claim an already-persisted session override was cleared unless the server supports it.
- Do not add mobile-only defaults to Settings in the first implementation. The TUI and mobile app should share the same OpenCode config.
- If the server cannot expose a resolved default, show “Server default” with an explanation rather than guessing.

Acceptance:

- The toolbar never shows unexplained `Auto` or `default` text.
- On new/unmodified sessions, choosing server default sends no explicit switch and follows later server-config changes.
- On already-overridden sessions, the UI clearly distinguishes an explicit switch to the current resolved default from true inheritance.
- Existing explicit session selections remain visible and take precedence for that session.

### Work Package 2.4: Explain context-window usage

Requests covered:

- “There is a diamond icon with a percentage; it is not understandable.”

Implementation:

- Verify the context-utilization formula against pinned v2 token semantics before changing it.
- Replace the diamond with a recognizable context/gauge indicator and a short label such as `Context 42%` where space permits.
- Make it pressable and open the existing detailed `SessionInfo` usage view.
- Add accessibility text such as “Context window used, 42 percent.”
- Handle unknown, zero, and over-100 values deliberately.

Acceptance:

- A user can understand the metric without prior knowledge and open its detailed breakdown.
- Unit tests cover model lookup, missing limits, rounding, latest eligible assistant message, and the approved token formula.

## Phase 3: Session Hierarchy, Subagents, and Questions

### Work Package 3.1: Model root and child sessions correctly

Requests covered:

- “Show main sessions first and subs in a nested collapsible way.”

Implementation:

- Extend SDK session list/page wrappers with `parentID?: string | null`.
- Load the main screen with `parentID: null` so only roots are paginated as roots.
- Preserve `parentID`, agent, model, and location in `session.created` normalization.
- Add a separate direct-children cache and pagination/loading state keyed by parent ID.
- Route child `session.created` events into the parent’s child cache, never the root array.
- Build nested/collapsible rows within existing directory grouping. Keep immediate children under their parent and support recursive expansion for nested subagents.
- Decide deletion behavior from server semantics: removing a parent must not leave stale visible children.

Acceptance:

- Root sessions appear first and child sessions never appear as unrelated roots.
- Expanding a root shows only its direct children; deeper levels nest under their immediate parent.
- Pagination, pull-to-refresh, rename, delete, live creation, and multiple directories preserve hierarchy.

### Work Package 3.2: Turn task calls into subagent cards with navigation

Requests covered:

- “Subagent creations look like a basic tool call ... improve this ... ability to go to subagent session.”

Implementation:

- Preserve tool metadata in canonical normalization and tool lifecycle SSE events.
- Extract a validated child session ID from task metadata; verify the exact key against the pinned running server. Use hierarchy lookup as fallback rather than unreliable title matching.
- Create a dedicated subagent/task presentation showing agent, task summary, state, result summary, and an explicit “Open subagent” action.
- Keep expand/collapse independent from navigation.
- Navigate to `/session/[id]` with the child’s directory; rely on focus reload when returning to the parent.
- Support resumed tasks pointing to an existing child and nested subagents.

Acceptance:

- Every task card with a known child opens the exact child session.
- Multiple sibling tasks and resumed tasks cannot navigate to the wrong child.
- Returning to the parent restores the parent transcript and scroll state reasonably.

### Work Package 3.3: Complete and redesign question support

Requests covered:

- “Do we support questions? ... fully support the questions API.”

Implementation:

- Keep the existing pending-list recovery, SSE asked/replied/rejected handling, and explicit session ownership.
- Audit all pinned fields: multiple question pages, single/multiple choice, descriptions, custom-answer allowed/disabled, empty options where valid, reply, reject, tool association, reconnect recovery, and duplicate-submit protection.
- Redesign `QuestionPrompt` to fit the final chat language: clear progress for multi-question requests, obvious selected states, validation before Next/Submit, keyboard-safe custom input, submitting/error states, and accessible controls.
- Ensure optimistic removal rolls back on reply/reject failure without duplicate submission.
- Add pending-question visibility when the composer or keyboard is open.

Acceptance:

- Every pinned question request shape can be answered or rejected correctly.
- Reconnect restores unanswered requests exactly once.
- Multi-select cannot submit accidentally empty answers unless the API permits it.
- Failures preserve the request and the user’s draft/selection.

### Work Package 3.4: Surface questions asked by subagents

Requests covered:

- “Does OpenCode support questions in subagents? ... if we don’t support it, support it.”

Implementation:

- Keep pending questions keyed by their owning child `sessionID`.
- Derive an “Input needed” badge/count for the corresponding parent subagent card.
- Show the same pending-question badge/count on the child row in the nested sessions hierarchy.
- Tapping the badge/card opens the child, where the normal question UI replies with the child owner ID.
- Ensure notification taps also open the child with correct directory scope.
- If exact task-to-child metadata is unavailable, show a parent-level “Subagent needs input” entry linked by child session, but do not guess a tool-call association.
- Apply the same approach recursively to grandchildren.

Acceptance:

- A child question is discoverable while viewing its parent and from the sessions hierarchy.
- Reply/reject targets the child session, resumes the child, clears the badge, and does not mutate parent-owned question state.
- Foreground, background notification, reconnect, and nested-subagent cases work.

## Phase 4: Cohesive Messaging UI Redesign

### Work Package 4.1: Define a product-specific chat visual contract

Requests covered:

- “The assistant icon and purple boxed messages seem like AI slop design.”

Before coding:

- Use the selected design skills to inspect the real transcript states now supported: user/assistant prose, reasoning, tool calls, shell/system rows, subagent cards, permissions, questions, errors, images, code, and streaming.
- Choose one restrained visual direction appropriate for a developer tool, not a generic consumer chatbot.
- Write a short design contract covering hierarchy, surfaces, typography, spacing, icon use, color roles, interaction states, light/dark themes, and accessibility.
- Use existing accent palettes intentionally; remove the hardcoded light-purple assistant surface.

### Work Package 4.2: Implement and verify the redesigned transcript

Implementation:

- Refactor `MessageBubble` so role identity does not depend on a generic sparkle avatar plus a large purple box.
- Prefer transcript rhythm, typography, alignment, and restrained dividers/surfaces over decorating every assistant response as a card.
- Keep special content visually distinct without producing a stack of interchangeable rounded cards.
- Preserve Markdown readability, horizontal code/diff scrolling, long-press user actions, streaming performance, and list virtualization.
- Translate visible role labels instead of hardcoding `You`/`Assistant` if labels remain.
- Audit narrow-screen overflow and dynamic font scaling.

Acceptance:

- The transcript is recognizably OpenCode Mobile and not a generic chatbot UI.
- All important loading, empty, streaming, success, error, permission, question, shell, and subagent states have intentional designs.
- Light/dark themes and every accent palette pass visual and contrast review.
- On-device screenshots are reviewed against the design contract and anti-slop finish gate.

## Phase 5: Fork-Owned Crash Reporting and Analytics

### Work Package 5.1: Remove upstream assumptions and harden privacy boundaries

Requests covered:

- “Set crash reports and usage analytics up for ourselves ... create a guide for credentials.”

Implementation:

- Replace hardcoded upstream Sentry organization/project values in `app.json` and `android/sentry.properties` with fork-owned configuration or build-time variables.
- Keep missing DSN/key as a strict no-op and missing source-map token as a supported local-build mode.
- Recursively scrub Sentry event messages, breadcrumbs, extras, contexts, tags, spans, paths, hosts, IPs, URLs, auth values, prompts, and code-like content before enabling ingestion.
- Reconcile README, consent text, privacy policy, store disclosures, and analytics documentation; the README currently claims no analytics SDK is bundled.
- Preserve explicit opt-in and verify revocation drops buffered analytics without sending them.
- Do not add credentials to tracked files.

Acceptance:

- Synthetic secret/content fixtures are removed by scrubber tests.
- Builds with no telemetry configuration make no telemetry requests.
- Consent denied/revoked makes no network requests.
- Local release builds succeed with Sentry upload disabled.

### Work Package 5.2: Provision fork-owned services and write operator guide

Create a guide that walks the user through:

1. Creating a Sentry organization/project and obtaining the public DSN.
2. Creating a minimally scoped source-map upload token.
3. Creating an EU PostHog project and obtaining its public ingest key/host.
4. Setting local untracked environment values and configured CI/build secret storage, such as GitHub or EAS if those services are actually used.
5. Configuring Sentry releases, alerts, retention, rate limits, and source-map verification.
6. Configuring the documented PostHog activation funnel and retention dashboard.
7. Verifying every event payload contains only allowlisted primitive properties.
8. Testing allow, decline, revoke, re-enable, offline buffering, and no-key behavior on a release build.

User checkpoint:

- The user creates the external projects and supplies only the minimum required values through approved local/CI secret storage.
- Public DSN/ingest keys may be embedded in builds; auth tokens remain secret and never use `EXPO_PUBLIC_` names.

Acceptance:

- A controlled release exception appears symbolicated in the fork-owned Sentry project.
- The documented activation events appear in PostHog with no prompt, code, path, hostname, URL, credential, or raw error content.
- Store/privacy disclosures match actual behavior before distribution.

## Cross-Cutting Validation

Every work package must include the smallest relevant automated tests and finish with:

```bash
bun run typecheck
bun test
git diff --check
```

Device/release validation should include:

- Use the phone-free environment in `docs/DEVELOPMENT-ENVIRONMENT.md` whenever the
  user's physical phone is unavailable. Emulator validation is required in that
  case; do not pause a work package or skip device checks merely because the phone
  cannot be accessed.
- Use a physical Android device when it is available. For hardware-only behavior,
  complete all practical emulator checks and explicitly record the remaining
  physical-device validation rather than claiming it passed.
- Fresh install and upgrade-over-existing-data paths.
- Light/dark themes, all accents, 50%/100%/150% message font scale, keyboard open/closed, and narrow screen.
- Real OpenCode v2 server state pre-created before assertions; an empty screen is not a passing session-list test.
- Background/foreground, offline/online, auth failure, SSE reconnect, and missed-event resync.
- Root, child, sibling, resumed, and nested subagent sessions.
- Current-session and child-session permissions/questions.
- Release build without Metro and without optional Sentry upload credentials.

## Suggested Delegation and Commit Boundaries

Keep each work package independently reviewable. A sensible orchestrator split is:

1. State/load and scroll specialist: 1.1-1.2.
2. Native/lifecycle specialist: 1.3 and 1.5.
3. Protocol/rendering specialist: 1.4.
4. Catalog/settings specialist: 2.1-2.4.
5. Session hierarchy specialist: 3.1-3.2.
6. Question API/UI specialist: 3.3-3.4, coordinated with hierarchy work.
7. Design specialist: 4.1-4.2 after Phases 1-3 land.
8. Privacy/telemetry specialist: 5.1; external provisioning guide and verification in 5.2.

Do not let parallel agents edit the same central files without coordination. High-conflict files include:

- `app/session/[id].tsx`
- `src/stores/sessions.ts`
- `src/stores/events.ts`
- `src/lib/protocol-v2.ts`
- `src/components/chat/MessageBubble.tsx`
- `src/components/chat/ToolCallCard.tsx`

Preferred commit sequence:

1. Split list/detail loading.
2. Fix transcript bottom-pinning.
3. Fix native microphone permission and speech errors.
4. Preserve/render standalone protocol messages.
5. Fix SSE lifecycle/readiness.
6. Scope catalog and expose resolved server defaults.
7. Add AgentPicker and a server-default-aware ModelPicker with truthful reset limitations.
8. Clarify context usage.
9. Add root/child session data model and nested list.
10. Add subagent cards/navigation.
11. Complete current-session question UX.
12. Add child-question discovery/navigation.
13. Apply the cohesive messaging redesign.
14. Harden and provision fork-owned telemetry with documentation.

## Request Coverage Matrix

| Original request | Planned work |
|---|---|
| Agent selector should be a picker | 2.1-2.2 |
| Diamond percentage is unclear | 2.4 |
| Microphone does not request permission | 1.3 |
| Assistant icon/purple boxes feel generic | 4.1-4.2 |
| Foreground reconnect is slow/misleading | 1.5 |
| Configure crash reporting and analytics for this fork | 5.1-5.2 |
| Nest subagents under main sessions | 3.1 |
| Improve subagent tool calls and open child session | 3.2 |
| Fully support questions API | 3.3 |
| Support questions asked by subagents | 3.4 |
| Sent message hidden by running state/autoscroll | 1.2 |
| First-message session flash/reload | 1.1 |
| Standalone shell rendered as normal message | 1.4 |
| Remove ambiguity around Auto/default | 2.1-2.3 |

All 14 requests are represented above.
