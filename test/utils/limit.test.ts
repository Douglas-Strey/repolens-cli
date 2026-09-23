import { describe, expect, it } from 'vitest'
import { createLimiter, mapLimit } from '../../src/utils/limit.ts'

const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms))

describe('createLimiter', () => {
  it('never runs more than `concurrency` tasks at once', async () => {
    const limit = createLimiter(3)
    let active = 0
    let peak = 0
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        limit(async () => {
          active++
          peak = Math.max(peak, active)
          await tick(i % 3)
          active--
          return i
        }),
      ),
    )
    expect(peak).toBe(3)
    expect(results).toEqual(Array.from({ length: 25 }, (_, i) => i))
  })

  it('frees the slot when a task throws', async () => {
    const limit = createLimiter(1)
    await expect(limit(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await limit(async () => 'next')).toBe('next')
  })

  it('treats a concurrency below 1 as 1 instead of stalling', async () => {
    for (const concurrency of [0, -5, Number.NaN]) {
      const limit = createLimiter(concurrency)
      let active = 0
      let peak = 0
      await Promise.all(
        [1, 2, 3].map(() =>
          limit(async () => {
            active++
            peak = Math.max(peak, active)
            await tick()
            active--
          }),
        ),
      )
      expect(peak).toBe(1)
    }
  })
})

describe('mapLimit', () => {
  it('preserves order and bounds concurrency', async () => {
    let active = 0
    let peak = 0
    const items = Array.from({ length: 40 }, (_, i) => i)
    const results = await mapLimit(items, 4, async (item, index) => {
      active++
      peak = Math.max(peak, active)
      await tick((40 - item) % 5)
      active--
      return `${item}:${index}`
    })
    expect(results).toEqual(items.map((i) => `${i}:${i}`))
    expect(peak).toBeLessThanOrEqual(4)
  })

  it('handles empty input and concurrency larger than the input', async () => {
    expect(await mapLimit([], 8, async () => 1)).toEqual([])
    expect(await mapLimit([1, 2], 100, async (x) => x * 2)).toEqual([2, 4])
  })

  it('still processes every item with a concurrency of 0', async () => {
    expect(await mapLimit([1, 2, 3], 0, async (x) => x + 1)).toEqual([2, 3, 4])
  })

  it('rejects on the first error and stops starting new items', async () => {
    const started: number[] = []
    const promise = mapLimit([0, 1, 2, 3, 4, 5, 6, 7], 1, async (item) => {
      started.push(item)
      if (item === 2) throw new Error('fail')
      return item
    })
    await expect(promise).rejects.toThrow('fail')
    expect(started).toEqual([0, 1, 2])
  })
})
