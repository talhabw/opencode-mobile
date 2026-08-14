# Privacy And Store Disclosures

This document describes the current optional telemetry behavior and the minimum
facts that privacy notices and store forms must match before distribution. It is
not legal advice.

## Behavior

- Crash reporting and activation analytics are disabled by default pending an
  explicit first-launch choice.
- One consent controls both Sentry and PostHog. The user can decline, allow,
  revoke, or re-enable it in Settings.
- Missing Sentry DSN or PostHog project key disables that service even after
  consent.
- Revocation blocks new transport before SDK shutdown. Analytics queues are
  memory-only and are discarded on revoke; they cannot survive an app restart.
- Sentry receives coarse crash type/severity, release information, numeric stack
  coordinates with normalized bundle identity, and content-free diagnostics.
- PostHog receives the explicit events and primitive custom properties listed in
  `docs/TELEMETRY-OPERATIONS.md`, plus SDK delivery metadata required for
  anonymous ingestion such as the public project key and random in-memory SDK
  identifier. That identifier rotates when the app process restarts.
- PostHog person profiles, geolocation, autocapture, session replay, and implicit
  lifecycle events are disabled.
- The app sanitizer removes messages, exception values, source context, prompts,
  code, file paths, server URLs/hosts/IPs, request headers/cookies/query/body,
  authentication values, user fields, and arbitrary raw errors before Sentry
  submission. Console breadcrumbs are dropped.
- Telemetry does not intentionally include prompt/message text, generated code,
  file content, project paths, server addresses, credentials, account names,
  email addresses, or raw connection errors.

The OpenCode servers a user configures are separate destinations needed for the
app's core function. Their data flow is not optional telemetry and must be
described separately in a complete privacy policy.

## Store Form Checklist

Before distribution, reconcile the exact current Apple App Privacy and Google
Play Data safety taxonomies with provider behavior and legal guidance. At minimum:

- Disclose optional diagnostics/crash data sent to the configured Sentry project.
- Disclose optional product-interaction/usage data sent to the configured EU
  PostHog project.
- State that collection is opt-in, can be revoked in-app, is not used for
  advertising, and is not sold.
- State whether the provider treats the random anonymous SDK identifier
  or network-layer IP handling as an identifier under the applicable store
  taxonomy. Do not call data anonymous if the final provider configuration makes
  it linkable.
- Link the published privacy policy from the store listing and in-app location
  required by the target store.
- Name the actual fork operator as controller/developer and list the actual
  support/privacy contact. Do not reuse upstream organization details.
- Record configured regions, retention periods, deletion process, subprocessors,
  access controls, and incident contact.

Do not mark these disclosures complete based only on repository tests. Complete
the provider-side payload audit and release matrix in
`docs/TELEMETRY-OPERATIONS.md`, then update the public policy and store forms to
the observed behavior before publishing.
