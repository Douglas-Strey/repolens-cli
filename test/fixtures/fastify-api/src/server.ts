import cors from '@fastify/cors'
import Fastify from 'fastify'
import orderRoutes from './routes/orders.js'
import userRoutes from './routes/users.js'

export function buildApp() {
  const app = Fastify({ logger: true })

  app.register(cors, { origin: true })

  app.get('/health', async () => ({ ok: true }))

  app.register(userRoutes, { prefix: '/users' })
  app.register(orderRoutes)

  return app
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildApp()
  const port = Number(process.env.PORT ?? 3000)

  app.listen({ port, host: '0.0.0.0' }).catch((err) => {
    app.log.error(err)
    process.exit(1)
  })
}
