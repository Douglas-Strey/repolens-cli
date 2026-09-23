const { Pool } = require('pg')
const { createClient } = require('redis')

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const redis = createClient({ url: process.env.REDIS_URL })

async function main() {
  await redis.connect()
  console.log('worker waiting for jobs')
  for (;;) {
    const job = await redis.blPop('jobs', 0)
    if (!job) continue
    await pool.query('INSERT INTO job_log (payload) VALUES ($1)', [job.element])
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
