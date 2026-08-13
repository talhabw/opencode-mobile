# Delegator Prompt — Migrate `opencode-mobile` to OpenCode v2 and Build for Nothing Phone (1)

You are the **delegator/integration agent**. Your job is not merely to produce a plan: delegate tightly scoped implementation tasks to build agents, review their work, integrate it, fix cross-task issues, and finish with a working Android build.

The repository has already been cloned locally:

`https://github.com/ncend/opencode-mobile`

The target protocol/product is OpenCode v2:

`https://opencode.ai/v2/docs`

Use **DeepSeek-v4-flash build agents** for implementation/recon tasks. You are responsible for architecture, task boundaries, sequencing, review, integration, and final verification.

## Goal

Convert this application from an OpenCode v1 mobile client into an **OpenCode v2-only mobile client**, while preserving the current UI and feature set wherever v2 supports equivalent behavior.

Then:

1. build the Android app,
2. install it on the attached **Nothing Phone (1)**,
3. connect it to a real OpenCode v2 server,
4. perform an end-to-end smoke test,
5. leave the repository in a clean, understandable, tested state.

The phone should remain a **thin mobile client**. Do not attempt to embed/run the OpenCode runtime itself on Android unless repository evidence unexpectedly proves that is already the intended architecture.

The initial deliverable is a working **debug/development APK** for the user's own device. Release signing / Play Store packaging is out of scope unless it is trivial after everything else succeeds.

## Existing OpenCode v2 server

A real OpenCode v2 server is **already running** on the development host at:

`http://127.0.0.1:4099`

All agents must use this existing server for real-server integration and compatibility testing.

**Do not start another OpenCode server. Do not stop, restart, kill, replace, or reconfigure the existing server. Do not bind another server to the same or a different port for testing.**

Do not run commands such as `opencode2 serve` for the purpose of launching a server.

It is acceptable to inspect CLI help, installed source, generated types, `/openapi.json`, and other read-only evidence, but testing must target the already-running server at `http://127.0.0.1:4099`.

## Non-negotiable working rules

Before editing anything:

* Inspect the full repository and current git status.
* Read the repository's `AGENTS.md`.
* Read relevant entries in `.agents/retro.md` if present, as instructed by `AGENTS.md`.
* Do not overwrite or reset pre-existing user changes.
* Run the existing test/typecheck baseline before migration and record failures that already existed.
* Treat the **currently installed OpenCode v2 package, generated TypeScript types, official v2 docs, and v2 source code** as the source of truth. V2 is beta and this prompt may become stale.
* Do not guess an endpoint or request shape when it can be verified.
* Do not preserve v1 compatibility unless it materially simplifies an intermediate commit. The finished runtime must be v2-only.
* Prefer incremental, reviewable changes over one giant rewrite.
* Keep commits/tasks scoped. Do not allow parallel agents to modify the same major files unless they are isolated in separate worktrees/branches and you explicitly reconcile them afterward.
* Use the already-running OpenCode v2 server at `http://127.0.0.1:4099` for all real-server tests. Never launch or terminate an OpenCode server yourself.

Official sources to consult:

`https://opencode.ai/v2/docs`

`https://opencode.ai/v2/docs/client`

`https://opencode.ai/v2/docs/api`

`https://opencode.ai/v2/docs/migration`

If documentation and generated client types disagree, investigate the current v2 implementation/source and prefer the actual version being run in integration tests.

## Existing architecture to preserve where sensible

The app is an Expo/React Native thin client.

Important current areas include approximately:

* `src/lib/sdk.ts` — hand-written v1 HTTP/SSE API
* `src/stores/sessions.ts` — session/message state
* `src/stores/events.ts` — streaming events and pending actions
* `src/stores/connections.ts` — server connection, directory and credentials
* session/composer screens — prompts, commands, attachments, model/agent choices
* Android native project under `android/`

Do not redesign the visual application merely because the protocol is changing.

The preferred architecture is:

**UI/stores → app-owned v2 adapter → official OpenCode v2 client**

Do not spread generated-client response types directly throughout all UI components.

Create a small normalization layer with app-facing concepts such as:

* app session
* app message
* app content/part
* model selection
* agent
* command
* pending permission
* pending question
* location

This is particularly important because v2 messages and sessions are structurally different from v1.

## Phase 0 — Recon and compatibility spike

Delegate one focused recon agent before broad implementation.

Its task is to produce concrete answers, not general research.

It must:

1. Record:

   * Node version
   * npm version
   * Expo version
   * React Native version
   * current Android Gradle configuration
   * baseline `npm test`
   * baseline `npm run typecheck`

2. Install the current v2 client in a controlled way:

   `npm install --save-exact @opencode-ai/client@next`

   If the package name/version has changed, verify the official current replacement rather than guessing.

3. Inspect the package's actual exported React Native/browser entrypoints and TypeScript types.

4. Verify whether the generated client can work in Expo/React Native using the app's existing `expo/fetch` implementation as custom `fetch`.

5. Create the smallest possible test/spike proving:

   * `OpenCode.make(...)` or its current equivalent initializes,
   * health can be queried,
   * sessions can be queried,
   * an event subscription can be constructed,
   * Metro/Hermes does not immediately fail due to Node-only dependencies.

   Use the **already-running server at `http://127.0.0.1:4099`** for any real invocation. Do not launch another server.

6. Do **not** import any Node-only service-management/server-spawning entrypoint into the mobile bundle.

7. Inspect the exact event union exported by the current v2 client. Do not assume v1 event names such as `session.status` remain unchanged.

8. Verify the current OpenCode v2 server authentication mechanism from:

   * `opencode2 serve --help`,
   * official docs,
   * current v2 server source,
   * and read-only behavior of the already-running server at `http://127.0.0.1:4099`.

   Do not assume the old `OPENCODE_SERVER_PASSWORD` / Basic Auth behavior is still valid.

   Do not launch, restart, stop, or reconfigure the server while investigating authentication.

### Gate

If the official generated network client works correctly under React Native/Hermes, use it.

If it does not work after a reasonable compatibility attempt, implement a minimal app-owned HTTP/SSE transport against `/api`, using `expo/fetch`, but preserve exactly the same adapter interface so the rest of the app is not coupled to the fallback.

Do not waste the whole migration trying to force an incompatible generated client.

After this spike succeeds, pin the exact client dependency version in `package.json`/lockfile. Do not leave a floating beta dependency as the implicit contract.

## Phase 1 — Build the v2 adapter

Have one agent own the core adapter so downstream agents have a stable contract.

Suggested location:

`src/lib/opencode-v2/`

or an equally clear repository-consistent structure.

The adapter should centralize:

* base URL normalization
* authentication headers
* explicit v2 location/directory scoping
* health/version detection
* sessions
* messages
* prompt submission
* commands
* models
* agents
* files
* permissions
* questions
* event subscription
* session actions
* cursor pagination
* error normalization
* abort/cancellation handling

Keep compatibility helpers out of UI components.

### Candidate v1 → v2 migration map

Verify every mapping against the actual current v2 client/schema before implementing it.

| Concern                   | Current v1 behavior                         | V2 target to verify/use                                      |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| Health                    | `/global/health`                            | `/api/health`                                                |
| Global events             | `/global/event`                             | generated `event.subscribe()` / `/api/event`                 |
| Directory                 | directory-specific client/header            | explicit v2 `location`, typically `{ directory }`            |
| Session list              | `/experimental/session` fallback `/session` | `/api/session`, paginated `{ data, cursor }`                 |
| Session create/get/delete | `/session/...`                              | `/api/session/...`                                           |
| Rename                    | PATCH session                               | v2 session rename operation                                  |
| Messages                  | `{ info, parts }[]`                         | paginated v2 `Session.Message.Info` union                    |
| Prompt                    | `prompt_async` with `parts`                 | v2 prompt operation with text/files/current supported inputs |
| Abort                     | `/abort`                                    | v2 interrupt operation                                       |
| Permission list           | `/permission`                               | `/api/permission/request`                                    |
| Permission reply          | request-only URL                            | session-scoped v2 permission reply                           |
| Question list             | `/question`                                 | `/api/question/request`                                      |
| Question reply/reject     | request-only URL                            | session-scoped v2 reply/reject                               |
| Model catalog             | v1 provider/model structure                 | `/api/model` and current `Model.Info`                        |
| Agents                    | `/agent`                                    | `/api/agent`                                                 |
| Commands                  | `/command`                                  | `/api/command`                                               |
| File browser              | `/file`                                     | `/api/fs/list`                                               |
| Project/path discovery    | v1 project/path APIs                        | v2 location/project APIs                                     |
| Revert/unrevert           | old revert endpoints                        | inspect v2 stage/clear/commit/revert semantics               |
| Diff                      | old session diff                            | determine correct v2 VCS/session/file equivalent             |

Remove obsolete v1 routes from production runtime when migration is complete.

A grep for old runtime endpoints should be part of final verification.

## Session and message normalization

This is one of the highest-risk parts.

The current app expects roughly:

`Message + Part[]`

V2 exposes a richer typed timeline/message structure.

Create one explicit projector/normalizer from v2 message entries to the app's renderable model.

It must deliberately handle at least:

* user text
* user file/image attachments
* assistant text
* reasoning content if exposed
* tool invocation/output
* shell/command output if represented separately
* errors
* agent changes
* model changes
* other non-chat timeline entries

For v2 timeline types that the UI does not render, either:

* map them to an intentional lightweight system/event row, or
* intentionally ignore them with a documented reason.

Never crash because an unknown union member arrived. Prefer exhaustive TypeScript handling with a safe future-compatible fallback.

Map the v2 session's `location.directory` into the app's normalized session-directory field instead of preserving old header-based directory behavior.

## Pagination

Do not fake pagination using `results.length === limit`.

Use v2 cursor values.

Implement cursor-aware pagination for:

* session list
* session messages

Preserve the current UX where possible.

Tests must include:

* first page
* next page
* no-next-page
* duplicate protection during refresh/pagination
* refresh after a live event

## Model and agent selection

The old app sends model/agent information along with prompts.

V2 may represent session model/agent selection separately.

Inspect the exact current client API and types.

If v2 requires model or agent switching before a prompt:

1. compare desired selection to current session selection,
2. switch it explicitly,
3. wait for successful API completion,
4. then submit the prompt.

For commands, use the v2 command request's supported model/agent fields if available.

Do not invent a request field merely to preserve the old call shape.

Pay particular attention to current model references. Verify how the old `{ providerID, modelID, variant }` selection maps to current v2 `Model.Ref`.

## Events and reconnect behavior

Do not port the old event switch statement mechanically.

Inspect the v2 generated event union/schema first.

The v2 event stream should be treated as **volatile**, not an authoritative replay log.

Build the event layer so that:

* live events update the UI quickly,
* disconnect/reconnect is expected,
* reconnect performs authoritative refetch/resync.

After reconnect, resync at least the state required to prevent stale UI:

* active/open session
* recent messages
* pending permissions
* pending questions
* relevant session status/state
* session list if events may have been missed

Use the v2 stream's real envelope/parser rather than assuming the existing v1 JSON `payload` shape.

Avoid a reconnection loop that can duplicate subscriptions.

Add focused unit tests around event normalization and reconnect/resync.

## Permissions and questions

Port these as first-class v2 features rather than treating them as incidental event payloads.

Verify and implement:

* list pending permissions
* permission reply: once / always / reject as supported
* list pending questions
* question answer
* question reject

Replies are session-scoped in v2. Handle HTTP 204/no-content responses correctly.

Ensure an answered/rejected request disappears from the UI immediately and remains gone after resync.

## Session actions

Audit every existing session action.

At minimum verify:

* create
* open/get
* list
* delete
* rename
* interrupt/stop generation
* message edit/revert UX
* undo/unrevert UX if present
* diff viewing

Do not silently remove a working v1 feature.

### Revert/edit and diff special investigation

Assign this to an agent after the core adapter exists.

The old semantics should not be guessed onto v2.

Trace exactly what the current UI expects from:

* edit previous message
* revert/stage
* undo/unrevert
* session diff viewer

Then inspect the current v2 session/VCS APIs and design the closest semantically correct mapping.

If there is no exact v2 equivalent for a v1 feature:

1. implement the best supported v2 behavior,
2. keep the UX coherent,
3. add tests,
4. document the behavioral difference in the final handoff.

Do not emulate server-side semantics locally unless absolutely necessary.

## Connections, locations, and authentication

The existing app creates directory-specific clients and stores credentials.

Replace the protocol-specific portion while preserving the user-facing connection concept.

A connection should normalize:

* base server URL
* authentication mode/credential if required
* selected directory/location

Use v2 explicit location rather than an old directory header.

Keep credentials in `expo-secure-store`.

Investigate the actual current v2 remote-server auth method. If the UI currently assumes username/password but v2 uses something different, migrate the connection editor appropriately.

Old saved v1 connections must not crash the app. Since the target is v2-only, it is acceptable to mark incompatible saved connections as needing reconfiguration.

### V2-only detection

Use the v2 health endpoint during connection testing.

If the server is clearly v1 or lacks the required v2 API, present a useful error such as:

“OpenCode v2 server required.”

Do not silently fall back to v1 production endpoints.

## Slash commands and attachments

Preserve the current composer behavior.

Verify:

* normal text prompt
* empty/whitespace protection
* image/file attachment handling
* attachment MIME/name/URI conversion
* slash command list
* slash command execution
* selected model
* selected agent
* variant
* interrupt button during generation

Test these on the **already-running server at `http://127.0.0.1:4099`**, not only with mocked responses.

Do not launch another OpenCode server for these tests.

## File/location browser

Migrate repository/directory browsing to the v2 filesystem/location API.

Do not assume paths from the development computer are valid on the Android device. They refer to the OpenCode server's filesystem.

Verify:

* root/location discovery
* directory navigation
* hidden/error states
* reconnecting to a previously selected project directory

## Suggested delegation waves

Use branches/worktrees if available.

### Wave A — sequential gate

**Agent A1: v2 client compatibility + contract recon**

No broad app rewrite.

Deliver:

* exact installed v2 client version
* generated API/type notes
* exact current authentication findings
* Expo/Hermes compatibility result
* event union notes
* baseline tests
* recommendation: generated client vs custom transport

Use the existing OpenCode server at `http://127.0.0.1:4099`. Do not start, stop, restart, or reconfigure any OpenCode server.

Review this yourself before proceeding.

### Wave B — foundation

**Agent B1: v2 transport/adapter**

Own the core v2 adapter and its unit tests.

Avoid editing stores/screens beyond minimal compilation shims.

Use `http://127.0.0.1:4099` for any real-server checks. Do not launch another server.

**Agent B2: Android/toolchain preflight**

Can run in parallel because it should initially avoid shared application files.

Verify:

* Java/JDK
* Android SDK
* Gradle
* adb
* attached device detection
* current native build baseline

Record exact failures; fix environment-independent repository issues where appropriate.

### Wave C — store migration

After B1's adapter contract is stable:

**Agent C1: sessions/messages/pagination**

Own session normalization, message projection, session fetching and prompt flow.

**Agent C2: events/permissions/questions**

Own event subscription, reconnect/resync and pending-action logic.

**Agent C3: connections/location/catalog APIs**

Own connection handling, v2 health/location/auth, models, agents, commands and filesystem catalog integration where file ownership allows.

If any of these need the same file, serialize those edits instead of creating merge-conflict soup.

All real-server checks in this wave must use `http://127.0.0.1:4099`. Agents must not launch their own OpenCode servers.

### Wave D — UX parity

**Agent D1: composer/model/agent/command/attachment parity**

Test the screens against the migrated stores.

**Agent D2: session actions/diff/revert investigation**

Handle rename, interrupt, edit/revert/undo and diff behavior.

Sequence D1/D2 if they overlap heavily in the session screen.

### Wave E — integration and cleanup

**Agent E1: v1 removal + regression tests**

Search for and remove obsolete v1 runtime assumptions/endpoints.

Update tests and documentation.

Then you, the delegator, perform integration review rather than trusting each agent independently.

### Wave F — real Android E2E

Build, install and test on the actual Nothing Phone (1).

Fix failures found here, then repeat tests.

Use the existing server at `http://127.0.0.1:4099` through adb reverse for the physical-device test. Do not start another OpenCode server.

## Android / Nothing Phone (1) workflow

Do not hardcode the device ABI or Android version. Inspect the actual connected device.

Run:

```bash
adb devices
adb shell getprop ro.product.manufacturer
adb shell getprop ro.product.model
adb shell getprop ro.product.cpu.abi
adb shell getprop ro.build.version.release
adb shell getprop ro.build.version.sdk
```

If multiple devices are connected, use `ANDROID_SERIAL`.

The repository already has a native Android project, so validate both the Expo entrypoint and deterministic Gradle build.

At minimum:

```bash
npm install
npm run typecheck
npm test
npm run android
```

Then produce a debug APK explicitly:

```bash
cd android
./gradlew assembleDebug
```

Locate the actual APK generated by Gradle rather than assuming a path without checking.

Install it with:

```bash
adb install -r <actual-debug-apk-path>
```

Verify the installed package using the actual application ID from Gradle/manifest.

Launch it through adb using the actual launcher activity, or another reliable adb launch mechanism.

Do not require Expo Go; this project has native dependencies and should be validated as a native development/debug build.

## Preferred physical-device server test

The OpenCode v2 server is already running on the development computer at:

`http://127.0.0.1:4099`

**Do not start, stop, restart, kill, or reconfigure it.**

For the Nothing Phone (1), prefer USB port forwarding:

```bash
adb reverse tcp:4099 tcp:4099
```

Then configure the mobile application to connect to:

`http://127.0.0.1:4099`

From the Android app, this localhost connection works through the adb reverse tunnel to the already-running development-host server.

If adb reverse is not appropriate, use a LAN/Tailscale connection to the same existing server only if its existing bind/auth configuration permits that safely.

Never solve connectivity by launching another OpenCode server or casually exposing an unauthenticated coding agent server to an untrusted network.

## Required automated verification

Before declaring completion:

```bash
npm run typecheck
npm test
```

Also run whatever Expo/Metro bundle validation and Gradle checks are appropriate for this project.

Add tests for the changed protocol layer covering at least:

* v2 health
* v2 session list wrapper
* cursor pagination
* session normalization
* message normalization
* prompt body mapping
* model reference mapping
* event envelope/normalization
* event reconnect resync
* permission list/reply
* question list/reply/reject
* 204 responses
* unknown future message/event variants
* location/directory mapping

Add a final repository search ensuring no active production code still calls obsolete v1 endpoints such as:

* `/global/`
* `/experimental/session`
* old `/session/.../prompt_async`
* old request-only permission/question reply paths

Old route strings are acceptable only inside explicit migration fixtures/docs/tests where intentional.

## Required real-device acceptance test

On the Nothing Phone (1), against the existing real OpenCode v2 server at `http://127.0.0.1:4099`, prove:

1. App launches without native/Metro crash.
2. Connection can be added/tested.
3. V2 server is recognized.
4. V1/non-v2 server is rejected clearly.
5. Projects/directories can be selected.
6. Session list loads.
7. Cursor-based additional sessions can load when available.
8. New session can be created.
9. Existing session can open.
10. Messages load.
11. A prompt can be sent.
12. Assistant output updates live.
13. Tool output does not crash rendering.
14. Reasoning/non-text content does not crash rendering.
15. Model selection works.
16. Agent selection works.
17. Slash commands work.
18. Attachments work.
19. Interrupt/stop generation works.
20. Permission requests can be answered.
21. Question requests can be answered/rejected.
22. Rename works.
23. Delete works.
24. Edit/revert/undo behavior is validated against actual v2 semantics.
25. Diff view either works correctly or its intentionally changed v2 behavior is documented.
26. Disconnecting/reconnecting does not leave sessions permanently “busy”.
27. Missing events during reconnect are repaired through resync.
28. App still works after force-close and relaunch.
29. Debug APK installs via adb and runs independently of Metro if that is the expected debug artifact configuration; otherwise clearly identify when Metro is required and additionally produce the most suitable standalone development artifact possible.

## Quality bar for build agents

Every delegated task must return:

* what it inspected
* design decision made
* exact files changed
* tests added/updated
* commands run
* command results
* known risks
* anything left for another task

Reject agent work that:

* guesses v2 request shapes,
* bypasses TypeScript with broad `any`,
* rewrites unrelated UI,
* leaves both v1 and v2 paths tangled together,
* swallows protocol errors,
* assumes SSE events are replayable,
* ignores cursor pagination,
* marks a feature complete without exercising the existing real v2 server at `http://127.0.0.1:4099`,
* starts/stops/restarts its own OpenCode server,
* or claims Android success without actual Gradle/adb evidence when the device is available.

## Integration responsibilities for you

After each wave:

* review diffs,
* run typecheck/tests yourself,
* resolve architecture drift,
* ensure adapter boundaries remain clean,
* remove duplicate compatibility code,
* inspect error handling,
* keep types explicit.

Do not merely concatenate agent patches.

When an agent reports that an API does not exist, independently verify that claim before dropping a feature.

When an agent gets blocked by a beta client bug, decide whether the narrow custom HTTP/SSE fallback is safer than patching generated dependencies.

Do not start or restart an OpenCode server during integration. Use `http://127.0.0.1:4099`.

## Definition of done

This task is done only when all of the following are true:

* Application runtime targets OpenCode v2 only.
* No required app workflow depends on v1 endpoints.
* V2 protocol details are isolated behind a clear adapter.
* Sessions/messages use correct v2 pagination.
* Live events and reconnect/resync are reliable.
* Permissions/questions work.
* Model/agent/command/file APIs use current v2 contracts.
* Existing core UI remains recognizably intact.
* `npm run typecheck` passes.
* `npm test` passes.
* Android Gradle build passes.
* Debug APK is produced.
* APK is installed on the attached Nothing Phone (1), if device access is available.
* App successfully communicates with the existing real OpenCode v2 server at `http://127.0.0.1:4099`.
* The real-device acceptance smoke test passes or every remaining device-only blocker is documented with exact evidence.

## Final handoff format

Your final response must include:

### Result

Whether the v2 migration is fully working.

### Architecture

Short explanation of the adapter/client choice and why.

### OpenCode versions

Exact:

* `opencode2 --version`
* installed `@opencode-ai/client` version, if used

### Changed areas

Major files/modules changed.

### V1 → V2 behavior changes

Anything the user will notice.

### Verification

Exact results for:

* typecheck
* tests
* Gradle build
* APK installation
* adb/device detection
* real v2 server smoke test

### Android artifact

Exact APK path.

### Device

Actual manufacturer/model/API level/ABI reported by adb.

### Server test configuration

State that testing used the already-running server:

`http://127.0.0.1:4099`

For the physical device, report whether:

`adb reverse tcp:4099 tcp:4099`

was used.

Do not expose secrets.

### Remaining issues

Only genuine unresolved issues, with evidence and suggested next action.

### Useful commands for the user

Keep this short:

* rebuild
* reinstall APK
* reconnect `adb reverse tcp:4099 tcp:4099`

Do not include instructions to launch another OpenCode server.

The final outcome should leave the user able to rebuild and install the v2 app again without reverse-engineering what the agents did.
