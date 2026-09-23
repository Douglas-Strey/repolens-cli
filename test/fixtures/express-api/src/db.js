const mongoose = require('mongoose')

const itemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    quantity: { type: Number, default: 0 },
  },
  { timestamps: true },
)

const Item = mongoose.model('Item', itemSchema)

function connect() {
  return mongoose.connect(process.env.MONGODB_URI)
}

module.exports = { connect, Item }
