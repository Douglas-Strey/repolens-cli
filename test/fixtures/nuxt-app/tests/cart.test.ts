import { describe, expect, it } from 'vitest'

function cartTotal(items: { price: number; quantity: number }[]) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}

describe('cart', () => {
  it('sums line items', () => {
    expect(cartTotal([{ price: 18, quantity: 2 }, { price: 12, quantity: 1 }])).toBe(48)
  })

  it('is zero when empty', () => {
    expect(cartTotal([])).toBe(0)
  })
})
