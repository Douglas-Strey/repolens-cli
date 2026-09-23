import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './api'

const apiUrl = import.meta.env.VITE_API_URL
const sentryDsn = import.meta.env.VITE_SENTRY_DSN

if (import.meta.env.DEV) {
  console.info(`[${import.meta.env.MODE}] talking to ${apiUrl}`)
}

if (sentryDsn) {
  console.info('error reporting enabled')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
