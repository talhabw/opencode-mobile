# Agent Development Environment

This environment lets agents build and test OpenCode Mobile without a physical
phone, private server data, provider credentials, or external services.

## Components

- Headless Pixel 6 AVD: `opencode-mobile-api36`
- Android API 36 Google APIs x86_64 image
- Local fixture server: `http://10.0.2.2:4100` from the emulator
- Fixture Basic auth: `opencode` / `devpassword`
- Metro on `http://127.0.0.1:8081`
- `agent-device` for selector-based Android automation

The fixture is in-memory and makes no external network or model calls. It seeds a
root session, a child/subagent session, a task tool linked to the child,
standalone shell output, model variants, pending permissions, a pending
question owned by the child, and project-scoped saved approvals (including one
belonging to a different project that the app must not show). Prompt responses
stream deterministic v2 lifecycle events. Idle SSE subscriptions stay open
between events; the fixture disables Bun's default 10-second idle timeout so
reconnect churn does not hide missed events during emulator tests. It also
serves a deterministic synthetic filesystem for the directory browser and
never lists or reads host files.

## Protocol Parity

The fixture speaks the released v2.0.x contract that the released generated
client (`@opencode/client` 2.0.x) is built from. The app's connection test calls
`GET /api/info`; the fixture answers with `ServerInfo` and all operations use
the documented routes (linked from https://opencode.ai/v2/docs/api/, raw
OpenAPI at https://opencode.ai/v2/openapi.json, verified 2026-09-27). The
removed beta surfaces are absent:

| Surface | Released fixture |
| --- | --- |
| Server identity | `GET /api/info` → `ServerInfo`; `/api/health` is 404 |
| Current project | removed (404); the app derives it from `GET /api/location` |
| Session rename | `PATCH /api/session/:id` `{title}` → 204 |
| Clear revert | `DELETE /api/session/:id/revert` → 204 |
| Pending forms | `GET /api/form?location[directory]` → `{location: {directory}, data}` |
| Cancel form | `DELETE /api/session/:id/form/:formID` → 204 |
| Slash command body | `{name, text, files?}` (missing `name` → 400) |
| Permission reply body | `{decision}` (missing `decision` → 400) |
| Saved permissions | `GET /api/permission/saved?projectID` → `{data}`; `DELETE /api/permission/saved/:id` → 204 (idempotent) |
| Always approvals | reply `always` persists the request's `save` patterns as project-scoped grants (no `save` → nothing) |
| Interrupt query | `?resume=true\|false` (other values → 400) |
| Prompt echo | `Session.Inbox.User` with `time: {created}` |
| File listing | `GET /api/fs/list` → `{location, data}` over the synthetic tree |
| File search | `GET /api/fs/find` (`query`, `type`, `limit`) over the same tree |
| File read | `GET /api/fs/read/*` → bytes; missing file → 404 `FileNotFoundError` |

The released contract is the only fixture contract:

- IDs use the official schema brands (`ses_`, `msg_`, `evt_`, `frm_`, `per_`,
  `sh_`) so payloads decode against `@opencode/schema`.
- SSE event durability and versions are read from
  `@opencode/schema/event-manifest`, so the fixture cannot drift from the
  released event contract. Events carry the required data fields, including the
  official `session.status` / `session.idle` lifecycle next to the
  `session.execution.*` and streaming events the app's event adapter consumes.
- `tests/fixtures/opencode-v2-server.test.ts` decodes every HTTP payload and
  every emitted event with the released schemas and event union, drives the
  fixture with the released generated client, and runs the app's own
  `createClient` from `src/lib/sdk.ts` end to end.

The fixture intentionally implements only the surfaces the app calls. The
filesystem routes (`/api/fs/list`, `/api/fs/find`, `/api/fs/read`) serve a
fixed synthetic tree and never touch host files; filesystem write
(`/api/experimental/fs/write`), integration, MCP, PTY, worktree/workspace,
session stats/import/export, fork/move/context/inbox/instructions,
skill/synthetic/shell/compact/wait/background/environment/view, and message
get/update are not implemented. Add them only when a screen starts using them.

The locally installed `opencode` CLI can be newer than the app's client.
Audit fixture changes against `@opencode/client` and
its `@opencode/protocol` / `@opencode/schema` dependencies in `node_modules`,
and against the official OpenAPI, not against the CLI alone.

## Start

```bash
bun run dev:env
```

This starts the fixture, emulator, and Metro; builds an x86_64 debug APK;
installs it; and launches the app. Runtime logs and PID files for all three
components use a checkout-specific directory,
`${XDG_RUNTIME_DIR:-/tmp}/opencode-mobile-dev-$UID-<checkout hash>`.

`start` preserves existing emulator and fixture state. Use `bun run
dev:env:reset` first when a test requires a clean launch. In the app, add this
connection:

```text
URL:      http://10.0.2.2:4100
Username: opencode
Password: devpassword
```

`10.0.2.2` is the Android emulator's stable gateway to the host. Metro's port
is reversed automatically by the environment script.

The fixture listens on `0.0.0.0` so the emulator gateway can reach it. It
contains only synthetic in-memory data and requires the known development
credentials above. Set `OPENCODE_MOBILE_FIXTURE_HOST=127.0.0.1` if local
network exposure is unacceptable: the environment script then adds
`adb reverse tcp:4100 tcp:4100` and the app connects to
`http://127.0.0.1:4100` instead.

## Automate

```bash
agent-device open cc.agentlabs.opencode \
  --platform android \
  --device opencode-mobile-api36 \
  --foreground
```

Use the normal `snapshot -i`, selector/ref interaction, wait, and close
workflow. Read `agent-device help workflow` before automation. Prefer app
`testID` selectors such as `id="connect-ip-input"` over coordinates.

## Reset and Stop

Reset fixture state and wipe all emulator/app data:

```bash
bun run dev:env:reset
```

Stop only the managed fixture, Metro process, and `emulator-5554`:

```bash
bun run dev:env:stop
```

Inspect component status:

```bash
scripts/dev-env.sh status
```

Do not try `bun run dev:env -- status`: the package script hardcodes `start`,
so the extra argument is ignored and the environment starts instead of
reporting status.

Rebuild and reinstall without wiping state:

```bash
scripts/dev-env.sh reinstall
```

Set `OPENCODE_MOBILE_SKIP_BUILD=1` to reuse the existing debug APK.

## Fixture Controls

Run the fixture contract test (released payloads, events, and app client):

```bash
bun run dev:fixture:test
```

Start the fixture on its own:

```bash
bun tests/fixtures/opencode-v2-server.ts --port 4100
```

Deterministic prompt triggers (send them as normal messages):

- `fixture:stream-stress` — 1,200 chunks at 100 Hz for streaming
  responsiveness checks.
- `fixture:tool-stress` — ~2,000 tool-input deltas plus a progress burst for
  busy-run rendering checks.
- `fixture:form-question` — raises a question-kind form and emits
  `form.created`; answer it through the forms API.
- `fixture:permission` — emits `permission.asked` and adds a pending
  permission request. The request carries `save: ["git status"]`, so replying
  **Always** persists a `shell` / `git status` approval for the fixture
  project, exactly like the released server.
- `fixture:permission-save` — same, with `resources: ["git status", "git log"]`
  and `save: ["git status", "git diff"]`. **Always** persists only the save
  patterns, proving `resources` are not what gets remembered.

Saved approvals (review and remove them in **Settings → Saved Approvals**, or
via the API):

- `psv_fixture_1` — `webfetch` on `https://example.com` (fixture project).
- `psv_fixture_2` — `shell` on `git log` (fixture project).
- `psv_fixture_3` — `edit` on `/fixture/other/notes.md` (`fixture-other-project`).
  It must never appear in the app: the settings list passes the current
  project ID and filters the response client-side.

`GET /api/permission/saved` without `projectID` returns every project's
grants; `DELETE /api/permission/saved/:id` answers 204 even for unknown IDs.
Approvals created by an **Always** reply are appended to the same list and are
deduplicated per project/action/resource.

Synthetic filesystem (browse it in the directory browser):

- `/fixture/workspace` — `src/` (with `src/lib/`, an empty `src/lib/deep/`,
  and `src/index.ts`), `docs/guide.md`, an empty `empty/`, `README.md`, and
  `opencode.json`.
- `/fixture/other` — a second fixture location with `notes.md`.
- `/` and `/fixture` are synthetic parents so the browser's up-navigation
  stays inside the fixture instead of failing.

Entry paths are relative to the requested location with a trailing `/` on
directories, matching the released server. The tree is fixed: paths outside it
return `InvalidRequestError` (`/api/fs/list`, `/api/fs/find`) or
`FileNotFoundError` (`/api/fs/read`), and no host file is ever listed or read.

Test hooks (same Basic auth, intended only for localhost development):

- `POST /fixture/reset` — reseed all in-memory state and emit
  `server.connected`.
- `POST /fixture/silent-session` — create a session without SSE events, for
  pull-to-refresh checks.
- `POST /fixture/reconnect-silent` — close current event streams and arm a
  one-shot silent SSE reconnect.
- `GET /fixture/status` — readiness counters (sessions, pending permissions,
  saved approvals, forms, running sessions).

Reset only server state:

```bash
scripts/dev-server.sh reset
```

## Validation Expectations

Before claiming a change works:

1. Run `bun run typecheck` and `bun test`.
2. Run `bun run dev:fixture:test`.
3. Reset to known state when the behavior depends on seeded sessions.
4. Verify the named UI result with `agent-device wait`, `is`, or `get`. For
   saved approvals, open **Settings → Saved Approvals**, confirm the seeded
   fixture-project grants render (and the `fixture-other-project` grant does
   not), then remove one and confirm it disappears.
5. Check JavaScript and Android logs for errors.

Use a real OpenCode v2 server only for behavior the fixture cannot model. Do
not point automated tests at the user's normal service or sessions.
