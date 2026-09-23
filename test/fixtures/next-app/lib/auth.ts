import { createHmac, timingSafeEqual } from 'node:crypto'

const secret = process.env.AUTH_SECRET

export function signSession(userId: string): string {
  if (!secret) throw new Error('AUTH_SECRET is not set')
  const signature = createHmac('sha256', secret).update(userId).digest('hex')
  return `${userId}.${signature}`
}

export function verifySession(token: string): string | null {
  if (!secret) return null
  const [userId, signature] = token.split('.')
  if (!userId || !signature) return null
  const expected = createHmac('sha256', secret).update(userId).digest('hex')
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) ? userId : null
}
