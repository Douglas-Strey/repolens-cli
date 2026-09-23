import fs from 'node:fs/promises'
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { copyFixture, FIXTURES_DIR, runCli } from '../helpers.ts'

const fixtures = (await fs.readdir(FIXTURES_DIR, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

/** Collect every string in a JSON value. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) strings(item, out)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, out)
  return out
}

describe('deterministic, portable JSON', () => {
  it.each(fixtures)('%s', async (fixture) => {
    const dir = await copyFixture(fixture)
    const first = (await runCli(['--json', '--verbose', dir])).stdout
    const second = (await runCli(['--json', '--verbose', dir])).stdout
    expect(second).toBe(first)

    const json = JSON.parse(first)
    expect(json.schemaVersion).toBe(1)
    for (const text of strings(json)) {
      expect(text).not.toContain(dir)
      expect(text).not.toContain(os.tmpdir())
    }
    // Every path-like field uses forward slashes, whatever the OS.
    const paths = strings([
      json.configFiles.map((f: { path: string }) => f.path),
      json.routes.routes.map((r: { file: string }) => r.file),
      json.environment.files.map((f: { path: string }) => f.path),
      json.scripts.scripts.map((s: { source: string }) => s.source),
      json.services.composeFiles,
    ])
    for (const p of paths) {
      expect(p).not.toContain('\\')
      expect(p.startsWith('/')).toBe(false)
    }
  })
})
