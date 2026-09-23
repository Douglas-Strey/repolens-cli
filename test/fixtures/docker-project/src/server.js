const express = require('express')
const { Pool } = require('pg')
const { createClient } = require('redis')

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const redis = createClient({ url: process.env.REDIS_URL })
const sessionSecret = process.env.SESSION_SECRET

const app = express()

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1')
    await redis.ping()
    res.json({ status: 'ok' })
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: err.message })
  }
})

app.get('/', (req, res) => {
  res.send(sessionSecret ? 'ready' : 'missing session secret')
})

redis.connect().then(() => {
  app.listen(3000, () => console.log('listening on :3000'))
})
