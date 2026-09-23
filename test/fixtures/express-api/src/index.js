require('dotenv').config()

const express = require('express')
const { connect } = require('./db')
const itemsRouter = require('./routes/items')
const healthRouter = require('./routes/health')

const app = express()

app.use(express.json())

app.get('/', (req, res) => {
  res.json({ name: 'express-api', version: '1.0.0' })
})

app.use('/api/items', itemsRouter)
app.use(healthRouter)

connect()
  .then(() => {
    app.listen(process.env.PORT || 8080, () => {
      console.log('express-api listening')
    })
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB', err)
    process.exit(1)
  })

module.exports = app
