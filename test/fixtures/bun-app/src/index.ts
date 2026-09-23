import { createHmac, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'

const app = new Hono()

const port = Number(process.env.PORT ?? 3000)
const webhookSecret = Bun.env.WEBHOOK_SECRET

app.get('/', (c) => c.json({ name: 'bun-app', port }))

app.post('/webhooks/:id', async (c) => {
  if (!webhookSecret) return c.json({ error: 'webhooks disabled' }, 503)

  const body = await c.req.text()
  const signature = c.req.header('x-signature') ?? ''
  const expected = createHmac('sha256', webhookSecret).update(body).digest('hex')

  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return c.json({ error: 'invalid signature' }, 401)
  }

  return c.json({ received: c.req.param('id') }, 202)
})

export default app
