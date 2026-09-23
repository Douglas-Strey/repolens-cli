import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/server.js'

describe('GET /health', () => {
  const app = buildApp()

  afterAll(() => app.close())

  it('returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })
})
