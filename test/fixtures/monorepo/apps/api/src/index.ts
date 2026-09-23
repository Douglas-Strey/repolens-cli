import { PrismaClient } from '@prisma/client'
import { type LoginRequest, formatCents } from '@acme/shared'
import Fastify from 'fastify'

const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })

const redisUrl = process.env.REDIS_URL
const publicUrl = process.env.API_URL ?? 'http://localhost:4000'
const stripeKey = process.env.STRIPE_SECRET_KEY

const app = Fastify({ logger: true })

app.get('/api/users', async () => {
  return prisma.user.findMany({ take: 100 })
})

app.post<{ Body: LoginRequest }>('/api/auth/login', async (request, reply) => {
  const user = await prisma.user.findUnique({ where: { email: request.body.email } })
  if (!user) return reply.code(401).send({ error: 'Invalid credentials' })
  return { token: `session-${user.id}` }
})

app.post<{ Body: { userId: string; totalCents: number } }>('/api/orders', async (request, reply) => {
  if (!stripeKey) return reply.code(503).send({ error: 'Payments disabled' })
  const order = await prisma.order.create({ data: request.body })
  return reply.code(201).send({ ...order, total: formatCents(order.totalCents) })
})

app.log.info({ redisUrl: Boolean(redisUrl), publicUrl }, 'starting api')

await app.listen({ port: 4000, host: '0.0.0.0' })
