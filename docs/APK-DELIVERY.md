# Building The Release APK And Sending It Over Telegram

Workflow for producing a release APK from this checkout and delivering it to a
user over Telegram, including the local Bot API server needed to exceed the
50 MB public Bot API upload limit.

## Building The Release APK

Before every release build, bump the version metadata. The user needs to tell
new deliveries apart from previously installed builds, and Android needs a
strictly increasing `versionCode` to accept upgrades. Bump all three files
together so they stay in sync:

- `app.json` → `expo.version` and `expo.android.versionCode` (increment the
  integer code)
- `package.json` → `version` (same as `expo.version`)
- `android/app/build.gradle` → `versionName` and `versionCode` (same as
  `app.json`)

`bun run check:versions` verifies the parity and fails when any value is out of
sync.

```bash
export ANDROID_HOME=/home/tbw/Android/Sdk
export ANDROID_SDK_ROOT=/home/tbw/Android/Sdk
# Gradle needs a full JDK. The default java reports 21, but its install
# directory is JRE-only (no javac) and using it fails toolchain resolution.
# Point JAVA_HOME at the JDK 17 install; no extra Gradle flags are needed.
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH="$JAVA_HOME/bin:$PATH"
# Skip Sentry source-map upload; no Sentry org/auth is configured here and the
# upload step fails the build otherwise.
export SENTRY_DISABLE_AUTO_UPLOAD=true
export SENTRY_DISABLE_NATIVE_DEBUG_UPLOAD=true
cd android && ./gradlew assembleRelease
```

The APK lands at `android/app/build/outputs/apk/release/app-release.apk`
(currently ~90 MB, over the public Bot API's 50 MB file limit).

Signing: the release build falls back to the debug keystore when the
`RELEASE_STORE_FILE`/`RELEASE_STORE_PASSWORD`/`RELEASE_KEY_ALIAS`/
`RELEASE_KEY_PASSWORD` environment variables are not set, which is fine for
sideloading.

Notes:

- `ANDROID_HOME` is not set in a fresh shell; the SDK lives at
  `/home/tbw/Android/Sdk`.
- `JAVA_HOME` is not set in a fresh shell either. Without it, Gradle resolves
  the toolchain to the JRE-only JDK 21 install
  (`/usr/lib/jvm/java-21-openjdk-amd64`) and the build fails before compiling
  with `Toolchain installation ... does not provide the required
  capabilities: [JAVA_COMPILER]`. Set `JAVA_HOME` to the JDK 17 install as
  shown above (observed 2026-09-28).
- If the JS bundle is unchanged since the last build, Gradle reports the
  packaging tasks UP-TO-DATE and the APK file keeps its old mtime — the APK
  still contains the current code (the bundler rebuilds the bundle and
  content hashes match).

## Sending Over Telegram

The public Bot API caps uploads at 50 MB. Run the official local Bot API
server (`aiogram/telegram-bot-api` image) with `--local`, which raises the
limit to 2 GB. The local server requires the account `api_id`/`api_hash` from
my.telegram.org (ask the user for them) and the bot token.

Secrets live in the untracked `.env` file at the repo root (`.env` is already
gitignored): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`,
`TELEGRAM_CHAT_ID`.

```bash
set -a && . ./.env && set +a
docker run -d --name telegram-bot-api \
  -e TELEGRAM_API_ID="$TELEGRAM_API_ID" \
  -e TELEGRAM_API_HASH="$TELEGRAM_API_HASH" \
  -v telegram-bot-api-data:/var/lib/telegram-bot-api \
  -p 8081:8081 \
  aiogram/telegram-bot-api:latest --local
```

Verify the server is up:

```bash
curl -s "http://127.0.0.1:8081/bot${TELEGRAM_BOT_TOKEN}/getMe"
```

Send the APK to the chat:

```bash
curl -s \
  -F "chat_id=$TELEGRAM_CHAT_ID" \
  -F document=@android/app/build/outputs/apk/release/app-release.apk \
  "http://127.0.0.1:8081/bot${TELEGRAM_BOT_TOKEN}/sendDocument"
```

Stop the server afterwards:

```bash
docker rm -f telegram-bot-api
```

Notes:

- The local Bot API server publishes host port 8081, which Metro also uses
  while the phone-free dev environment is running. Starting the container then
  fails with `failed to bind host port 0.0.0.0:8081/tcp: address already in
  use` and can leave a created `telegram-bot-api` container behind. Stop the
  dev environment first (`bun run dev:env:stop`) or publish a different host
  port, e.g. `-p 8082:8081`, and use that port in the `curl` URLs.
- If a container named `telegram-bot-api` already exists (left over from a
  failed start or an earlier send), `docker run` fails with a name conflict;
  remove it first with `docker rm -f telegram-bot-api`.
- Bots cannot start a private conversation with a user who has never opened
  the bot chat and pressed Start; if sendDocument fails with a "can't initiate
  conversation" error, ask the user to message the bot first.
- Treat the bot token and api_id/api_hash as secrets: keep them out of
  committed files and out of shell history where possible. The `.env` file
  must remain untracked.
