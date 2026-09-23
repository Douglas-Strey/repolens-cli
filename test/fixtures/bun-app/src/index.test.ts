import { describe, expect, it } from 'bun:test'
import app from './index'

describe('bun-app', () => {
  it('GET / responds with app info', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ name: 'bun-app' })
  })

  it('rejects unsigned webhooks', async () => {
    const res = await app.request('/webhooks/abc', { method: 'POST', body: '{}' })
    expect([401, 503]).toContain(res.status)
  })
})
