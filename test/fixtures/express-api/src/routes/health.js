const express = require('express')
const mongoose = require('mongoose')

const router = express.Router()

router
  .route('/health')
  .get((req, res) => {
    res.json({ status: 'ok', db: mongoose.connection.readyState === 1 ? 'up' : 'down' })
  })
  .post((req, res) => {
    res.status(202).json({ status: 'accepted' })
  })

module.exports = router
