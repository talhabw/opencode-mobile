# Telemetry Operations

This fork includes optional Sentry crash reporting and PostHog activation
analytics. Both are disabled until the user explicitly opts in. Each service is
also a strict runtime no-op when its public runtime value is absent.

## Value Types

Public ingest values may be embedded in an application binary:

- `EXPO_PUBLIC_SENTRY_DSN`: Sentry public DSN used only to submit events.
- `EXPO_PUBLIC_POSTHOG_KEY`: PostHog project ingest key.
- `EXPO_PUBLIC_POSTHOG_HOST`: PostHog EU ingest host, normally
  `https://eu.i.posthog.com`.

Build-only values:

- `SENTRY_URL`: Sentry service URL, normally `https://sentry.io/`.
- `SENTRY_ORG`: fork-owned organization slug.
- `SENTRY_PROJECT`: fork-owned project slug.
- `SENTRY_AUTH_TOKEN`: secret source-map upload token.

The DSN and PostHog project key are public ingestion identifiers, not account
credentials. `SENTRY_AUTH_TOKEN` is a secret account authorization token. Never
give it an `EXPO_PUBLIC_` name, put it in a tracked file, print it in build logs,
or ship it in an APK.

## User Checkpoint: External Projects

The repository cannot create or inspect external accounts. Before activating
telemetry, the user must:

1. Create a fork-owned Sentry organization and React Native project, then copy
   its public DSN.
2. Create a source-map token restricted to the minimum project/release upload
   scopes offered by Sentry. Do not grant organization administration scopes.
3. Create an EU PostHog project and copy its public project key and EU ingest
   host.
4. Review each provider's data processing terms and choose retention appropriate
   for the intended distribution.

This checkpoint is intentionally pending until the user completes it. No
organization, project, event, symbolication, alert, retention, rate-limit,
dashboard, or provider-side payload check is claimed by this repository.

## Local And Build Configuration

Use an untracked `.env.local` for runtime public values when testing locally:

```dotenv
EXPO_PUBLIC_SENTRY_DSN=https://PUBLIC_KEY@o0.ingest.sentry.io/0
EXPO_PUBLIC_POSTHOG_KEY=phc_PUBLIC_PROJECT_KEY
EXPO_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com
```

`.env*` is ignored. Confirm with `git status --short` before building. Use shell
environment variables for source-map upload configuration:

```bash
SENTRY_URL=https://sentry.io/ \
SENTRY_ORG=FORK_ORG \
SENTRY_PROJECT=FORK_PROJECT \
SENTRY_AUTH_TOKEN=SECRET_TOKEN \
NODE_ENV=production bun run android
```

For a local release with no upload and no telemetry runtime configuration:

```bash
cd android
env -u EXPO_PUBLIC_SENTRY_DSN -u EXPO_PUBLIC_POSTHOG_KEY \
  -u EXPO_PUBLIC_POSTHOG_HOST -u SENTRY_AUTH_TOKEN -u SENTRY_ORG \
  -u SENTRY_PROJECT -u SENTRY_URL NODE_ENV=production \
  SENTRY_DISABLE_AUTO_UPLOAD=true \
  ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

Only configure CI or EAS secrets if that service is actually adopted. Store the
auth token in its encrypted secret store, expose it only to trusted release jobs,
and conditionally run upload only when `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and
`SENTRY_PROJECT` are all present. Pull requests and local builds must continue to
work with `SENTRY_DISABLE_AUTO_UPLOAD=true` and no telemetry values.

## Sentry Setup

Set the release to `opencode-mobile@<app version>` and dist to the app version,
matching `src/lib/sentry.ts`. Configure conservative project retention and rate
limits, and alerts for new regressions or elevated fatal-event rates rather than
every event. Keep performance tracing disabled unless a separate privacy review
adds a narrow span schema.

To verify source maps, upload release artifacts in one controlled release build,
trigger a deliberate exception containing no user/server content, and confirm the
stack resolves to expected source locations. Inspect the provider payload and
confirm paths and source context remain redacted. Remove the test trigger before
distribution. A local successful build does not prove provider-side
symbolication.

## PostHog Setup

Use the EU project and EU ingest endpoint, disable person profiles, IP geolocation,
autocapture, session replay, and implicit lifecycle capture. The app emits only:

| Event | Allowed custom properties |
| --- | --- |
| `app_opened` | `is_first_open` boolean |
| `connection_form_submitted` | `mode`: `quick` or `advanced` |
| `connection_attempted` | `source`: `onboarding`, `edit_test`, or `sse` |
| `connection_succeeded` | `source`: `onboarding`, `edit_test`, or `sse` |
| `connection_failed` | allowed `source`; coarse `error_class` |
| `message_sent` | none |
| `response_received` | none |
| `demo_started` | none |
| `demo_step_advanced` | step 1, `permission_replied`, coarse reply enum |
| `demo_completed` | `outcome`: `completed` or `denied` |
| `demo_exited_to_connect` | `reached_completion` boolean |

Create an activation funnel and dashboard from `app_opened` through onboarding
`connection_form_submitted`, `connection_succeeded`, `message_sent`, and
`response_received`. Keep the offline demo funnel separate. A retention dashboard
may show same-process/session conversion only. Cross-launch user retention is
deliberately unavailable because memory-only persistence rotates the anonymous
SDK identifier on restart; do not label it installation retention. Persisting an
identifier would require a separate privacy decision, disclosure update, revoke
deletion implementation, and tests. Do not add identity, URL, host, path, prompt,
code, or raw error properties to make retention possible.

## Release Test Matrix

Run these checks on a release build while inspecting device traffic and provider
payloads:

1. No-key: remove both public values; allowing consent produces no Sentry or
   PostHog requests.
2. Decline: with values present, decline first-launch consent; neither SDK sends.
3. Allow: allow consent; only the documented events and coarse crash payload are
   sent.
4. Revoke: create queued analytics while offline, revoke in Settings, restore the
   network, and verify zero delivery. The app blocks transport before shutdown
   and uses memory-only analytics persistence.
5. Re-enable: allow again; only events produced after re-enable are delivered.
6. Offline: allow, go offline, produce events, reconnect without revoking, and
   verify only the current process's allowlisted events flush.
7. Payload audit: inject synthetic prompt, code, path, host, URL, IP, credential,
   and raw-error markers across exception, stack, breadcrumb, request, user,
   span, tag, context, and extra fields; none may reach either provider.
8. Source maps: verify one content-free controlled exception is symbolicated in
   the fork-owned project.

Record release version, device/OS, consent transitions, network evidence, payload
samples with public keys removed, and provider-side results. Provider acceptance
remains unverified until this matrix is completed against user-owned projects.
