import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { requireAuth } from '../auth.js'
import { cache } from '../cache.js'
import { db } from '../db/client.js'
import { orders } from '../db/schema.js'

export default async function orderRoutes(fastify: FastifyInstance) {
  fastify.route<{ Body: { userId: number; totalCents: number } }>({
    method: 'POST',
    url: '/orders',
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const [order] = await db.insert(orders).values(request.body).returning()
      return reply.code(201).send(order)
    },
  })

  fastify.route<{ Params: { id: string } }>({
    method: ['GET', 'HEAD'],
    url: '/orders/:id',
    handler: async (request, reply) => {
      const cacheKey = `order:${request.params.id}`
      const cached = await cache.get(cacheKey)
      if (cached) return JSON.parse(cached)

      const [order] = await db.select().from(orders).where(eq(orders.id, Number(request.params.id)))
      if (!order) return reply.code(404).send({ error: 'Not found' })

      await cache.set(cacheKey, JSON.stringify(order), 'EX', 60)
      return order
    },
  })
}
