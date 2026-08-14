const config = require("./app.json")

module.exports = () => {
  const expo = { ...config.expo, plugins: [...config.expo.plugins] }
  const organization = process.env.SENTRY_ORG
  const project = process.env.SENTRY_PROJECT

  // Source-map integration is opt-in for fork operators. Runtime Sentry uses
  // EXPO_PUBLIC_SENTRY_DSN independently and does not require these values.
  if (organization && project) {
    expo.plugins.push([
      "@sentry/react-native/expo",
      {
        organization,
        project,
        ...(process.env.SENTRY_URL ? { url: process.env.SENTRY_URL } : {}),
      },
    ])
  }

  return { expo }
}
