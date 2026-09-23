import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src')

describe('deterministic ordering', () => {
  it('never compares strings with the machine locale (use compareText from src/utils/compare.ts)', async () => {
    const offenders: string[] = []
    for (const entry of await fs.readdir(SRC, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
      const file = path.join(entry.parentPath, entry.name)
      const text = await fs.readFile(file, 'utf8')
      if (/\.localeCompare\(|\bIntl\.Collator\b/.test(text)) offenders.push(path.relative(SRC, file))
    }
    expect(offenders).toEqual([])
  })
})
