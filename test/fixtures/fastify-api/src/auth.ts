import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'

const JWT_SECRET = process.env.JWT_SECRET

function verify(token: string): boolean {
  if (!JWT_SECRET) return false
  const [header, payload, signature] = token.split('.')
  if (!header || !payload || !signature) return false
  const expected = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url')
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const token = request.headers.authorization?.replace(/^Bearer /, '')
  if (!token || !verify(token)) {
    return reply.code(401).send({ error: 'Unauthorized' })
  }
}
