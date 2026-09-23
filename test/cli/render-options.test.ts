/**
 * What the CLI hands the terminal renderers. The renderers are wrapped so each
 * test can inspect the RenderOptions main() built, while output stays real.
 */
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderOptions } from '../../src/output/style.ts'
import { makeProject, makeTempDir, runCli } from '../helpers.ts'

const seen = vi.hoisted(() => ({ options: [] as RenderOptions[] }))

vi.mock('../../src/output/terminal.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/output/terminal.ts')>()
  return {
    ...actual,
    renderScan: (...args: Parameters<typeof actual.renderScan>) => {
      seen.options.push(args[1])
      return actual.renderScan(...args)
    },
    renderDoctor: (...args: Parameters<typeof actual.renderDoctor>) => {
      seen.options.push(args[1])
      return actual.renderDoctor(...args)
    },
  }
})

async function optionsFor(argv: string[], options: Parameters<typeof runCli>[1] = {}): Promise<RenderOptions> {
  seen.options.length = 0
  const run = await runCli(argv, options)
  expect(run.stderr).toBe('')
  expect(seen.options).toHaveLength(1)
  return seen.options[0] as RenderOptions
}

describe('render options built by the CLI', () => {
  beforeEach(() => {
    seen.options.length = 0
  })

  it('uses COLUMNS when stdout is not a terminal, with a minimum of 40', async () => {
    const cwd = await makeProject({ 'package.json': '{}' })
    // runCli's stdout is not a TTY: COLUMNS wins over the stream's own value.
    expect((await optionsFor([], { cwd, env: { COLUMNS: '72' } })).width).toBe(72)
    expect((await optionsFor([], { cwd, env: { COLUMNS: '12' } })).width).toBe(40)
    expect((await optionsFor([], { cwd, columns: 45 })).width).toBe(45)
    expect((await optionsFor([], { cwd, columns: 0 })).width).toBe(100)
  })

  it('renders --output files at a fixed width, without colors, with Unicode unless REPOLENS_ASCII=1', async () => {
    const cwd = await makeProject({ 'package.json': '{}' })
    const file = await optionsFor(['doctor', '--color', '--fail-on', 'never', '-o', 'out.txt'], { cwd, columns: 60 })
    expect(file.width).toBe(100)
    expect(file.style.color).toBe(false)
    expect(file.style.unicode).toBe(true)
    const ascii = await optionsFor(['-o', 'out.txt'], { cwd, env: { REPOLENS_ASCII: '1' } })
    expect(ascii.style.unicode).toBe(false)
  })

  it('passes the scanned path for suggested commands only when it is not the current directory', async () => {
    const parent = await makeTempDir()
    const root = await makeProject({ 'package.json': '{}' })
    expect((await optionsFor([], { cwd: root })).commandPath).toBeUndefined()
    expect((await optionsFor(['.'], { cwd: root })).commandPath).toBeUndefined()
    expect((await optionsFor(['--cwd', root], { cwd: root })).commandPath).toBeUndefined()
    // Absolute paths never reach the output, so the hint stays generic for them.
    expect((await optionsFor([root], { cwd: parent })).commandPath).toBeUndefined()
    const relative = path.relative(parent, root)
    expect((await optionsFor(['doctor', '--fail-on', 'never', '-C', relative], { cwd: parent })).commandPath).toBe(
      relative,
    )
  })
})
