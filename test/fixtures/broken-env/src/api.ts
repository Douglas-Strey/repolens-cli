import { createElement } from 'react'

const flags = (import.meta.env['VITE_FEATURE_FLAGS'] ?? '').split(',').filter(Boolean)

export function isEnabled(flag: string): boolean {
  return flags.includes(flag)
}

export async function fetchStatus(): Promise<string> {
  const res = await fetch('/api/status')
  return res.ok ? 'online' : 'offline'
}

export function App() {
  return createElement('h1', null, isEnabled('new-header') ? 'Hello (beta)' : 'Hello')
}
