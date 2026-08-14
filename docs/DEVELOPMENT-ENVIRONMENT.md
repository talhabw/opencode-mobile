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
standalone shell output, model variants, and a pending question owned by the
child. Prompt responses stream deterministic v2 lifecycle events.

## Start

```bash
bun run dev:env
```

This starts the fixture, emulator, and Metro; builds an x86_64 debug APK;
installs it; and launches the app. Runtime logs and PID files use a
checkout-specific directory under `${XDG_RUNTIME_DIR:-/tmp}`.

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
network exposure is unacceptable and arrange an `adb reverse` for port 4100.

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

Rebuild and reinstall without wiping state:

```bash
scripts/dev-env.sh reinstall
```

Set `OPENCODE_MOBILE_SKIP_BUILD=1` to reuse the existing debug APK.

## Fixture Controls

Run the fixture contract test:

```bash
bun run dev:fixture:test
```

Reset only server state:

```bash
scripts/dev-server.sh reset
```

The fixture controls require the same known Basic auth and are intended only
for localhost development.

## Validation Expectations

Before claiming a change works:

1. Run `bun run typecheck` and `bun test`.
2. Run the fixture contract test.
3. Reset to known state when the behavior depends on seeded sessions.
4. Verify the named UI result with `agent-device wait`, `is`, or `get`.
5. Check JavaScript and Android logs for errors.

Use a real OpenCode v2 server only for behavior the fixture cannot model. Do
not point automated tests at the user's normal service or sessions.
