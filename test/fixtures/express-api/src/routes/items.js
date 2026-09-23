const express = require('express')
const { Item } = require('../db')

const router = express.Router()

router.get('/', async (req, res) => {
  const items = await Item.find().limit(100)
  res.json(items)
})

router.post('/', async (req, res) => {
  const item = await Item.create(req.body)
  res.status(201).json(item)
})

router.put('/:id', async (req, res) => {
  const item = await Item.findByIdAndUpdate(req.params.id, req.body, { new: true })
  if (!item) return res.status(404).json({ error: 'Not found' })
  res.json(item)
})

router.delete('/:id', async (req, res) => {
  await Item.findByIdAndDelete(req.params.id)
  res.status(204).end()
})

module.exports = router
