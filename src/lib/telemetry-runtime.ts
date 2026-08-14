export type TelemetryRuntime = {
  sentryEnabled: () => boolean
  analyticsEnabled: () => boolean
  initSentry: () => void
  initAnalytics: () => void
  trackAppOpened: () => void
  disableSentry: () => Promise<void>
  shutdownAnalytics: () => Promise<void>
}

/** Injectable consent transition boundary. SDK modules provide the production
 * runtime; tests use counters so no native module or network is required. */
export async function transitionTelemetryRuntime(granted: boolean, runtime: TelemetryRuntime): Promise<void> {
  if (granted) {
    if (!runtime.sentryEnabled()) runtime.initSentry()
    if (!runtime.analyticsEnabled()) runtime.initAnalytics()
    runtime.trackAppOpened()
    return
  }

  await runtime.disableSentry()
  await runtime.shutdownAnalytics()
}
