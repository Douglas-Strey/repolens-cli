/** Concurrency below 1 (or NaN) would stall every task; treat it as 1. */
function normalizeConcurrency(concurrency: number): number {
  return concurrency >= 1 ? Math.floor(concurrency) : 1
}

/** Minimal concurrency limiter: at most `concurrency` tasks run at once. */
export function createLimiter(concurrency: number) {
  const max = normalizeConcurrency(concurrency)
  let active = 0
  const queue: Array<() => void> = []

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) {
      // The finishing task hands its slot over directly, so `active` stays accurate.
      await new Promise<void>((resolve) => queue.push(resolve))
    } else {
      active++
    }
    try {
      return await task()
    } finally {
      const waiter = queue.shift()
      if (waiter) waiter()
      else active--
    }
  }
}

/**
 * Map over items with bounded concurrency, preserving order. If `fn` throws,
 * the returned promise rejects and no further items are started.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  let failed = false
  const workers = Array.from({ length: Math.min(normalizeConcurrency(concurrency), items.length) }, async () => {
    while (!failed && cursor < items.length) {
      const index = cursor++
      try {
        results[index] = await fn(items[index] as T, index)
      } catch (error) {
        failed = true
        throw error
      }
    }
  })
  await Promise.all(workers)
  return results
}
