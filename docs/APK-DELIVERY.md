# Building The Release APK And Sending It Over Telegram

Workflow for producing a release APK from this checkout and delivering it to a
user over Telegram, including the local Bot API server needed to exceed the
50 MB public Bot API upload limit.

## Building The Release APK

```bash
export ANDROID_HOME=/home/tbw/Android/Sdk
export ANDROID_SDK_ROOT=/home/tbw/Android/Sdk
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

- Bots cannot start a private conversation with a user who has never opened
  the bot chat and pressed Start; if sendDocument fails with a "can't initiate
  conversation" error, ask the user to message the bot first.
- Treat the bot token and api_id/api_hash as secrets: keep them out of
  committed files and out of shell history where possible. The `.env` file
  must remain untracked.
