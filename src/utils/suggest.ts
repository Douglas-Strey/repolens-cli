/** Optimal string alignment distance: Levenshtein plus adjacent transpositions ("hlep" to "help" is 1). */
export function editDistance(a: string, b: string): number {
  const rows: number[][] = []
  for (let i = 0; i <= a.length; i++) {
    const row: number[] = [i]
    for (let j = 1; j <= b.length; j++) {
      if (i === 0) {
        row.push(j)
        continue
      }
      const above = rows[i - 1] as number[]
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min((above[j] as number) + 1, (row[j - 1] as number) + 1, (above[j - 1] as number) + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, ((rows[i - 2] as number[])[j - 2] as number) + 1)
      }
      row.push(best)
    }
    rows.push(row)
  }
  return (rows[a.length] as number[])[b.length] as number
}

/**
 * The candidate a bare word was probably meant to be, if any. Words that look
 * like paths (`./doctor`, `apps/web`) never match, and short words only
 * tolerate one edit so that `ep` doesn't become `help`.
 */
export function closestWord(word: string, candidates: readonly string[]): string | undefined {
  if (!/^[A-Za-z][A-Za-z-]*$/.test(word)) return undefined
  const lower = word.toLowerCase()
  let best: string | undefined
  let bestDistance = word.length <= 3 ? 2 : 3
  for (const candidate of candidates) {
    const distance = editDistance(lower, candidate)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/** Longest input worth suggesting for; beyond it, distances cost more than they help. */
const MAX_SUGGEST_LENGTH = 64

/**
 * The candidate closest to `word` ignoring case, when it is within a couple
 * of edits (one for short words): `failon` gives `failOn`,
 * `ENV_UNDOCUMNTED` gives `ENV_UNDOCUMENTED`.
 */
export function closestMatch(word: string, candidates: Iterable<string>): string | undefined {
  if (word.length === 0 || word.length > MAX_SUGGEST_LENGTH) return undefined
  const lower = word.toLowerCase()
  let best: string | undefined
  let bestDistance = word.length <= 4 ? 2 : 3
  for (const candidate of candidates) {
    const distance = editDistance(lower, candidate.toLowerCase())
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}
