import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'

export default async function userRoutes(fastify: FastifyInstance) {
  fastify.get('/', async () => {
    return db.select().from(users).limit(100)
  })

  fastify.post<{ Body: { email: string; name: string } }>('/', async (request, reply) => {
    const [user] = await db.insert(users).values(request.body).returning()
    return reply.code(201).send(user)
  })

  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const [user] = await db.select().from(users).where(eq(users.id, Number(request.params.id)))
    if (!user) return reply.code(404).send({ error: 'Not found' })
    return user
  })

  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    await db.delete(users).where(eq(users.id, Number(request.params.id)))
    return reply.code(204).send()
  })
}
