// Legacy analytics bootstrap, still bundled for the old checkout page.
const { API_URL, ANALYTICS_KEY } = process.env

const token = process.env["LEGACY_TOKEN"]

export function initLegacyAnalytics() {
  if (!ANALYTICS_KEY) return
  window.__analytics = { endpoint: `${API_URL}/collect`, key: ANALYTICS_KEY, token }
}
