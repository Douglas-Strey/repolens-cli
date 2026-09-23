/**
 * Snapshot of the terminal output for every fixture: the whole pipeline
 * (walker → detectors → doctor → renderer) as a user sees it. Review snapshot
 * diffs carefully; update intentional changes with `pnpm vitest run -u`.
 */
import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { copyFixture, FIXTURES_DIR, runCli } from '../helpers.ts'

const fixtures = (await fs.readdir(FIXTURES_DIR, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

describe('terminal output per fixture', () => {
  it.each(fixtures)('%s', async (fixture) => {
    const dir = await copyFixture(fixture)
    const scan = await runCli([dir])
    const doctor = await runCli(['doctor', dir])
    expect(scan.code).toBe(0)
    expect(scan.stderr).toBe('')
    expect([0, 1]).toContain(doctor.code)
    expect(`${scan.stdout}\n${'─'.repeat(40)}\n\n${doctor.stdout}`).toMatchSnapshot()
  })
})
