import { describe, expect, it } from 'vitest'
import { filterByConfidence } from '../../src/core/confidence.ts'
import type { Confidence, Framework, Route, Tool } from '../../src/types.ts'
import { makeResult } from '../factories.ts'

const framework = (id: string, confidence: Confidence): Framework => ({
  id,
  name: id,
  category: 'frontend',
  ecosystem: 'node',
  packages: ['.'],
  confidence,
  evidence: [],
})
const tool = (id: string, confidence: Confidence): Tool => ({
  id,
  name: id,
  kind: 'other',
  configFiles: [],
  packages: [],
  confidence,
  evidence: [],
})
const route = (path: string, confidence: Confidence): Route => ({
  method: 'GET',
  path,
  kind: 'api',
  framework: 'x',
  file: 'x.ts',
  confidence,
})

describe('filterByConfidence', () => {
  const result = makeResult({
    frameworks: [framework('a', 'high'), framework('b', 'medium'), framework('c', 'low')],
    build: { tools: [tool('vite', 'low'), tool('tsc', 'high')] },
    testing: { tools: [tool('jest', 'low')], testFiles: 3 },
    linting: { tools: [tool('eslint', 'medium')] },
    databases: {
      databases: [{ id: 'pg', name: 'PostgreSQL', kind: 'relational', sources: [], confidence: 'low', evidence: [] }],
      orms: [tool('prisma', 'high')],
    },
    routes: { routes: [route('/a', 'high'), route('/b', 'low')], truncated: true },
  })

  it('hides low-confidence findings by default', () => {
    const filtered = filterByConfidence(result)
    expect(filtered.frameworks.map((f) => f.id)).toEqual(['a', 'b'])
    expect(filtered.build.tools.map((t) => t.id)).toEqual(['tsc'])
    expect(filtered.testing).toEqual({ tools: [], testFiles: 3 })
    expect(filtered.linting.tools.map((t) => t.id)).toEqual(['eslint'])
    expect(filtered.databases).toEqual({ databases: [], orms: [tool('prisma', 'high')] })
    expect(filtered.routes).toEqual({ routes: [route('/a', 'high')], truncated: true })
  })

  it('keeps only high-confidence findings at "high"', () => {
    expect(filterByConfidence(result, 'high').frameworks.map((f) => f.id)).toEqual(['a'])
  })

  it('returns the input untouched at "low"', () => {
    expect(filterByConfidence(result, 'low')).toBe(result)
  })

  it('does not mutate the input', () => {
    filterByConfidence(result)
    expect(result.frameworks).toHaveLength(3)
  })
})
