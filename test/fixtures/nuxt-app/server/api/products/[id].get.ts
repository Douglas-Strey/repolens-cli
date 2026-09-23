export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  const products = await $fetch('/api/products')
  const product = products.find((p) => p.id === id)

  if (!product) {
    throw createError({ statusCode: 404, statusMessage: 'Product not found' })
  }

  return product
})
