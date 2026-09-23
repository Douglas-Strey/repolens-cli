import type { Confidence, ScanResult } from '../types.ts'

const RANK: Record<Confidence, number> = { high: 2, medium: 1, low: 0 }

function keep<T extends { confidence: Confidence }>(items: readonly T[], min: Confidence): T[] {
  return items.filter((item) => RANK[item.confidence] >= RANK[min])
}

/**
 * Drop findings below `min` confidence. By default RepoLens only shows
 * medium- and high-confidence findings; --verbose shows everything.
 */
export function filterByConfidence(result: ScanResult, min: Confidence = 'medium'): ScanResult {
  if (min === 'low') return result
  return {
    ...result,
    frameworks: keep(result.frameworks, min),
    build: { ...result.build, tools: keep(result.build.tools, min) },
    testing: { ...result.testing, tools: keep(result.testing.tools, min) },
    linting: { ...result.linting, tools: keep(result.linting.tools, min) },
    databases: {
      databases: keep(result.databases.databases, min),
      orms: keep(result.databases.orms, min),
    },
    routes: { ...result.routes, routes: keep(result.routes.routes, min) },
  }
}
