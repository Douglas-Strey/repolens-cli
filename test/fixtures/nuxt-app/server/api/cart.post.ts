interface CartItem {
  productId: string
  quantity: number
}

export default defineEventHandler(async (event) => {
  const body = await readBody<CartItem>(event)
  const stripeKey = process.env.STRIPE_SECRET_KEY

  if (!stripeKey) {
    throw createError({ statusCode: 500, statusMessage: 'Payments are not configured' })
  }

  return { ok: true, item: body }
})
