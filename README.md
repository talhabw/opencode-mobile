# OpenCode Mobile

Personal React Native / Expo Android client for an OpenCode v2 server.

This fork is maintained for local use and device builds. It is not affiliated
with or endorsed by the OpenCode project.

## Features

- Multiple OpenCode server connections
- Session browsing, creation, and streaming chat
- Agent, model, and reasoning-variant selection
- Tool calls, diffs, permissions, and questions
- Image attachments and speech-to-text input
- Biometric app and message-send protection
- Optional consent-gated diagnostics and analytics

## Requirements

- Bun
- Android Studio and Android SDK
- A physical Android device with USB debugging, or an emulator
- An OpenCode v2 server reachable from the device

## Setup

```bash
bun install
bun run typecheck
bun test
```

Start Expo and open the Android development build:

```bash
bun run android
```

Or start Metro separately:

```bash
bun run start
```

Native modules used by this app may not work in Expo Go. Prefer an Android
development build.

## OpenCode Server

Start a server reachable from the Android device:

```bash
OPENCODE_SERVER_PASSWORD=devpassword opencode serve --hostname 0.0.0.0 --port 4096
```

Common connection addresses:

- Physical device on the same network: `http://<computer-lan-ip>:4096`
- Standard Android emulator: `http://10.0.2.2:4096`
- ADB reverse: run `adb reverse tcp:4096 tcp:4096`, then use `http://127.0.0.1:4096`

## Release APK

Local release builds can disable optional Sentry source-map upload:

```bash
cd android
NODE_ENV=production SENTRY_DISABLE_AUTO_UPLOAD=true \
  ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

The APK is written to:

```text
android/app/build/outputs/apk/release/app-release.apk
```

Install it on a connected device:

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

When no release keystore is configured, the local release build uses the
checked-in development keystore. Do not use that key for public distribution.

## Project Structure

```text
app/                     Expo Router screens
src/components/          Reusable UI and chat rendering
src/lib/sdk.ts           OpenCode v2 HTTP/SSE client adapter
src/lib/protocol-v2.ts   Protocol normalization
src/stores/              Zustand application state
android/                 Native Android project
docs/                    Current implementation plans and QA notes
```

See `AGENTS.md` for architecture, code conventions, validation requirements,
and environment-specific guidance.

For phone-free agent testing, see `docs/DEVELOPMENT-ENVIRONMENT.md`.

## License

MIT. See `LICENSE`.
