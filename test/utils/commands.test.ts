import { describe, expect, it } from 'vitest'
import { installCommand, runScriptCommand, scriptRunner } from '../../src/utils/commands.ts'

describe('runScriptCommand', () => {
  it.each([
    ['pnpm', 'dev', 'pnpm dev'],
    ['yarn', 'build', 'yarn build'],
    ['bun', 'dev', 'bun run dev'],
    ['npm', 'dev', 'npm run dev'],
    ['npm', 'test', 'npm test'],
    ['npm', 'start', 'npm start'],
    [null, 'lint', 'npm run lint'],
    [undefined, 'stop', 'npm stop'],
    ['go', 'build', 'npm run build'],
  ] as const)('%s %s → %s', (manager, script, expected) => {
    expect(runScriptCommand(manager, script)).toBe(expected)
  })
})

describe('scriptRunner / installCommand', () => {
  it('maps each package manager', () => {
    expect(scriptRunner('pnpm')).toBe('pnpm')
    expect(scriptRunner('yarn')).toBe('yarn')
    expect(scriptRunner('bun')).toBe('bun run')
    expect(scriptRunner(null)).toBe('npm run')
    expect(installCommand('pnpm')).toBe('pnpm install')
    expect(installCommand('yarn')).toBe('yarn install')
    expect(installCommand('bun')).toBe('bun install')
    expect(installCommand('go')).toBe('go mod download')
    expect(installCommand(undefined)).toBe('npm install')
  })
})
