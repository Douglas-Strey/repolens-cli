import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pathCandidates, searchPath, spawnSpec } from '../../src/setup/host.ts'
import { canSymlink, makeTempDir } from '../helpers.ts'

const posixOnly = process.platform === 'win32' ? it.skip : it
const symlinkOnly = process.platform !== 'win32' && canSymlink ? it : it.skip

async function executable(dir: string, name: string, mode = 0o755): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await fs.writeFile(file, '#!/bin/sh\n', { mode })
  return file
}

describe('pathCandidates', () => {
  it('skips relative PATH entries and directories inside the project', () => {
    const env = { PATH: '/usr/bin:bin:.::/repo/node_modules/.bin:/repo:/opt/tools' }
    expect(pathCandidates('pnpm', { env, platform: 'linux', exclude: ['/repo'] })).toEqual([
      '/usr/bin/pnpm',
      '/opt/tools/pnpm',
    ])
  })

  it('reads Path and PATHEXT case-insensitively on Windows', () => {
    const env = { Path: 'C:\\Program Files\\nodejs;"C:\\Tools";.\\bin;C:\\repo\\bin', PathExt: '.EXE;.CMD' }
    expect(pathCandidates('pnpm', { env, platform: 'win32', exclude: ['C:\\Repo'] })).toEqual([
      'C:\\Program Files\\nodejs\\pnpm.exe',
      'C:\\Program Files\\nodejs\\pnpm.cmd',
      'C:\\Tools\\pnpm.exe',
      'C:\\Tools\\pnpm.cmd',
    ])
  })
})

describe('searchPath', () => {
  posixOnly('finds an executable file and ignores one without the execute bit', async () => {
    const tmp = await makeTempDir()
    await executable(path.join(tmp, 'a'), 'tool', 0o644)
    const found = await executable(path.join(tmp, 'b'), 'tool')
    const env = { PATH: [path.join(tmp, 'a'), path.join(tmp, 'b')].join(':') }
    expect(await searchPath('tool', { env, platform: process.platform, exclude: [] })).toBe(found)
    expect(await searchPath('missing', { env, platform: process.platform, exclude: [] })).toBeNull()
  })

  posixOnly('never returns a program inside the project', async () => {
    const tmp = await makeTempDir()
    const project = path.join(tmp, 'project')
    await executable(path.join(project, 'node_modules', '.bin'), 'pnpm')
    const env = { PATH: path.join(project, 'node_modules', '.bin') }
    expect(await searchPath('pnpm', { env, platform: process.platform, exclude: [project] })).toBeNull()
  })

  symlinkOnly('never follows a PATH link into the project', async () => {
    const tmp = await makeTempDir()
    const project = path.join(tmp, 'project')
    const planted = await executable(project, 'pnpm')
    await fs.mkdir(path.join(tmp, 'bin'))
    await fs.symlink(planted, path.join(tmp, 'bin', 'pnpm'))
    const env = { PATH: path.join(tmp, 'bin') }
    expect(await searchPath('pnpm', { env, platform: process.platform, exclude: [project] })).toBeNull()
  })
})

describe('spawnSpec', () => {
  it('runs programs directly, without a shell', () => {
    expect(spawnSpec('/usr/bin/pnpm', ['install'], 'linux')).toEqual({
      file: '/usr/bin/pnpm',
      args: ['install'],
      verbatim: false,
    })
    expect(spawnSpec('C:\\Program Files\\Docker\\docker.exe', ['compose', 'up', '-d'], 'win32')).toEqual({
      file: 'C:\\Program Files\\Docker\\docker.exe',
      args: ['compose', 'up', '-d'],
      verbatim: false,
    })
  })

  it('starts Windows .cmd shims through cmd.exe with arguments it cannot reinterpret', () => {
    expect(
      spawnSpec('C:\\Program Files\\nodejs\\pnpm.cmd', ['install', '--ignore-scripts'], 'win32', 'C:\\cmd.exe'),
    ).toEqual({
      file: 'C:\\cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\pnpm.cmd" install --ignore-scripts"'],
      verbatim: true,
    })
    for (const arg of ['a&b', '%PATH%', 'x|y', 'a b', '"q"', '^', '!x!']) {
      expect(spawnSpec('C:\\nodejs\\npm.cmd', ['install', arg], 'win32')).toBeNull()
    }
    expect(spawnSpec('C:\\100%\\npm.cmd', ['install'], 'win32')).toBeNull()
  })
})
