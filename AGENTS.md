# OpenCode Mobile - Agent Guide

## Scope

This repository is a personal fork of OpenCode Mobile used for local changes and
Android device builds. Do not assume access to the upstream developer's machines,
accounts, secrets, private servers, browser sessions, CI runners, or publishing
infrastructure.

- Work against the current checkout and its configured Git remote.
- Do not push, publish, create releases, or modify store listings unless explicitly
  requested.
- Never search for or use credentials belonging to the upstream developer.
- Use only tools, devices, environment variables, and credentials available in the
  current environment. Ask the user when access is genuinely required.
- Treat `context.md`, `HANDOFF.md`, `.agents/`, `.autopilot/`, `.supervisor/`, and
  `.tasks/` as historical upstream material unless the user explicitly asks to use
  them. Verify any claim in those files against the current code and environment.

## Overview

OpenCode Mobile is a React Native / Expo Android client for an OpenCode server. It
connects over HTTP and SSE for sessions, messages, streaming updates, permissions,
and questions.

- Package: `cc.agentlabs.opencode`
- Routing: Expo Router
- State: Zustand
- Server API: HTTP + SSE

## Architecture

```text
app/                    # Expo Router screens and navigation
src/components/         # Reusable UI components
src/components/markdown/# Markdown rendering
src/lib/sdk.ts          # OpenCode HTTP/SSE client
src/lib/types.ts        # Shared and re-exported types
src/stores/sessions.ts  # Sessions, messages, and parts
src/stores/connections.ts # Connections and client lifecycle
src/stores/events.ts    # SSE events, permissions, and questions
src/stores/auth.ts      # Biometric authentication
scripts/                # Build, validation, and utility scripts
android/                # Native Android project
```

## Key Patterns

- SSE events are the source of truth for real-time UI updates.
- Message sends are fire-and-forget; event updates drive response rendering.
- Session status combines `session.status` events with the latest message part.
- Markdown rendering is wrapped by the local `Markdown` component.
- Preserve the same server directory scope when listing, creating, opening, and
  sending messages in a session.
- When no model was explicitly selected by the user, let the server choose rather
  than inferring a model from provider registry defaults.

## Code Style

- Follow the style already used in the file being changed.
- Prefer `const` over `let`.
- Prefer early returns over `else` branches.
- Avoid `any`; keep TypeScript types explicit at system boundaries.
- Keep API access in `src/lib/` and shared state in `src/stores/`.
- Keep changes small and focused. Do not add compatibility code without a concrete
  requirement.
- Use Bun for JavaScript and TypeScript package management and commands.

## Setup

Prerequisites:

- Bun
- Android Studio and Android SDK
- A physical Android device with USB debugging, or an Android emulator
- OpenCode CLI for end-to-end testing against a real server

```bash
bun install
bun run typecheck
bun run android
```

To start Expo separately:

```bash
bun run start
# or
bunx expo start --android
```

Native modules may not work in Expo Go. Prefer an Android development build for
device testing.

Use the Android SDK paths already configured in the local environment. Do not assume
a particular SDK, AVD, Gradle cache path, operating system, or disk layout, and do
not install or relocate SDK components without the user's approval.

## Connecting To OpenCode

Start a local server that is reachable from the Android device:

```bash
OPENCODE_SERVER_PASSWORD=devpassword opencode serve --hostname 0.0.0.0 --port 4096
```

Connection addresses:

- Physical device on the same network: `http://<computer-lan-ip>:4096`
- Standard Android emulator: `http://10.0.2.2:4096`
- iOS simulator, when applicable: `http://localhost:4096`

Do not assume an upstream Tailscale address or preconfigured development server is
reachable. Do not expose a local server through a tunnel unless the user requests it.

## Validation

Run the smallest relevant checks first, then broaden validation when practical:

```bash
bun run typecheck
bun test
```

For Android behavior, build and test on the connected local device or emulator. Use
the automation tools available in the current environment when appropriate; do not
assume access to upstream Azure OpenAI deployments or CUA credentials.

Before claiming a bug is fixed, ensure the validation would fail if the bug were
still present. For session-list regressions, pre-create known server state and verify
that specific state appears rather than accepting an empty screen as success.

## Secrets And External Services

- Keep secrets out of committed files.
- Local `.env` files must remain untracked.
- Do not assume access to Bitwarden, Sentry, Azure, Google Play, Firebase, GCP,
  Cloudflare, GitHub Actions secrets, or upstream organization accounts.
- Do not copy account names, service-account addresses, endpoints, tokens, or local
  credential paths from historical project files into commands or new documentation.
- If a task needs an external service, first inspect what is actually configured in
  this environment, then ask the user for the minimum missing access.

## Git And Upstream

- Treat the configured remote as authoritative; do not hardcode an upstream username
  or repository URL into operational commands.
- Do not assume issue, pull-request, workflow, or release permissions.
- Do not alter unrelated worktree changes.
- Do not rewrite history or use destructive Git commands unless explicitly requested.
