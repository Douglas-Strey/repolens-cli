import { describe, expect, it } from 'vitest'
import { execArgs, installArgs, nodeRequirement, type SetupPlan, setupPlan } from '../../src/setup/plan.ts'
import type { PackageManagerInfo } from '../../src/types.ts'
import { makeProject, scanDir } from '../helpers.ts'

const COMPOSE = `services:
  app:
    build: .
    ports: ["3000:3000"]
  db:
    image: postgres:17
    ports: ["5432:5432"]
`

async function planFor(files: Record<string, string>, ignoreScripts = false): Promise<SetupPlan> {
  return setupPlan(await scanDir(await makeProject(files)), { ignoreScripts })
}

function manager(overrides: Partial<PackageManagerInfo>): PackageManagerInfo {
  return { id: 'npm', name: 'npm', lockfiles: [], declared: false, evidence: [], ...overrides }
}

describe('setupPlan', () => {
  it('creates the env file, starts the backing services and installs, in that order', async () => {
    const plan = await planFor({
      'package.json': JSON.stringify({
        name: 'web',
        packageManager: 'pnpm@10.17.1',
        scripts: { dev: 'vite', postinstall: 'node scripts/setup.js', prepare: 'husky' },
      }),
      '.env.example': 'DATABASE_URL=postgres://localhost:5432/app\n',
      'compose.yaml': COMPOSE,
    })
    expect(plan.steps.map((step) => [step.kind, step.command])).toEqual([
      ['env', 'cp .env.example .env'],
      ['services', 'docker compose up -d db'],
      ['install', 'pnpm install'],
    ])
    expect(plan.steps.map((step) => step.action)).toEqual([
      { type: 'copy', from: '.env.example', to: '.env' },
      { type: 'exec', program: 'docker', args: ['compose', 'up', '-d', 'db'] },
      { type: 'exec', program: 'pnpm', args: ['install'] },
    ])
    expect(plan.steps[1]?.notes).toEqual(['Pulls images if needed: postgres:17'])
    expect(plan.steps[2]?.notes).toEqual([
      'Runs these scripts from the repository:',
      '  postinstall (package.json): node scripts/setup.js',
      '  prepare (package.json): husky',
      'Dependencies may run install scripts too; --ignore-scripts skips them all.',
    ])
    expect(plan.skipped).toEqual([])
    expect(plan.next).toEqual({ command: 'pnpm dev', reason: 'start the development server' })
  })

  it('says when Compose builds images from the repository', async () => {
    const plan = await planFor({
      'package.json': JSON.stringify({ name: 'web' }),
      'compose.yaml': 'services:\n  worker:\n    build: ./worker\n  db:\n    image: postgres:17\n',
    })
    const services = plan.steps.find((step) => step.kind === 'services')
    expect(services?.command).toBe('docker compose up -d db')
    // Only the backing service is started, so nothing is built.
    expect(services?.notes).toEqual(['Pulls images if needed: postgres:17'])
  })

  it('lists lifecycle scripts as skipped with --ignore-scripts', async () => {
    const plan = await planFor(
      {
        'package.json': JSON.stringify({ name: 'web', scripts: { postinstall: 'node x.js' } }),
        'package-lock.json': '{"lockfileVersion":3}',
      },
      true,
    )
    expect(plan.steps).toEqual([
      expect.objectContaining({
        command: 'npm install --ignore-scripts',
        action: { type: 'exec', program: 'npm', args: ['install', '--ignore-scripts'] },
        notes: [
          'Lifecycle scripts are skipped (--ignore-scripts), including the project’s own:'.replace('’', "'"),
          '  postinstall (package.json): node x.js',
        ],
      }),
    ])
  })

  it('includes workspace members’ lifecycle scripts after the root’s', async () => {
    const plan = await planFor({
      'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
      'package-lock.json': '{"lockfileVersion":3}',
      'packages/a/package.json': JSON.stringify({ name: 'a', scripts: { postinstall: 'node build.js' } }),
    })
    expect(plan.steps[0]?.notes).toContain('  postinstall (packages/a/package.json): node build.js')
  })

  it('leaves project scripts and existing env files alone', async () => {
    const plan = await planFor({
      'package.json': JSON.stringify({ name: 'web', scripts: { 'db:up': 'docker compose up -d' } }),
      'package-lock.json': '{"lockfileVersion":3}',
      'compose.yaml': COMPOSE,
      '.env.example': 'A=1\n',
      '.env': 'A=2\n',
    })
    expect(plan.steps.map((step) => step.command)).toEqual(['npm install'])
    expect(plan.skipped).toEqual([
      { kind: 'env', reason: '.env already exists; setup never changes it' },
      { kind: 'services', reason: 'a project script starts the services', command: 'npm run db:up' },
    ])
  })

  it('never runs a Compose command with an unusual service name', async () => {
    const plan = await planFor({
      'package.json': JSON.stringify({ name: 'web' }),
      'compose.yaml': 'services:\n  app:\n    build: .\n  "-db":\n    image: postgres:17\n',
    })
    expect(plan.steps.some((step) => step.kind === 'services')).toBe(false)
    expect(plan.skipped).toEqual([
      { kind: 'services', reason: 'unusual Compose file or service names', command: 'docker compose up -d ./-db' },
    ])
  })

  it('leaves a setup target to the developer when no package manager installs', async () => {
    const plan = await planFor({ Makefile: 'setup:\n\t./bootstrap.sh\n' })
    expect(plan.steps).toEqual([])
    expect(plan.skipped).toEqual([
      { kind: 'install', reason: 'a project script installs dependencies', command: 'make setup' },
    ])
  })

  it('downloads Go modules', async () => {
    const plan = await planFor({ 'go.mod': 'module example.com/app\n\ngo 1.25\n', 'main.go': 'package main\n' })
    expect(plan.steps).toEqual([
      {
        kind: 'install',
        command: 'go mod download',
        reason: 'download Go modules',
        action: { type: 'exec', program: 'go', args: ['mod', 'download'] },
        notes: [],
      },
    ])
    expect(plan.node).toBeUndefined()
  })

  it('checks the Node.js version only before a JavaScript install', async () => {
    const plan = await planFor({
      'package.json': JSON.stringify({ name: 'web', engines: { node: '>=22' } }),
      'package-lock.json': '{"lockfileVersion":3}',
      '.nvmrc': '24\n',
    })
    expect(plan.node).toEqual({
      required: { range: '>=22', file: 'package.json' },
      pinned: { version: '24', file: '.nvmrc' },
    })
  })
})

describe('nodeRequirement', () => {
  it('is null when nothing declares a version', async () => {
    expect(nodeRequirement(await scanDir(await makeProject({ 'package.json': '{"name":"x"}' })))).toBeNull()
  })
})

describe('installArgs', () => {
  it('skips lifecycle scripts the way each package manager spells it', () => {
    expect(installArgs(manager({ id: 'npm' }), false)).toEqual(['install'])
    expect(installArgs(manager({ id: 'pnpm' }), true)).toEqual(['install', '--ignore-scripts'])
    expect(installArgs(manager({ id: 'bun' }), true)).toEqual(['install', '--ignore-scripts'])
    expect(
      installArgs(manager({ id: 'yarn', evidence: ['Yarn Classic (yarn.lock uses the v1 format)'] }), true),
    ).toEqual(['install', '--ignore-scripts'])
    expect(installArgs(manager({ id: 'yarn', evidence: ['Yarn Berry (.yarnrc.yml exists)'] }), true)).toEqual([
      'install',
      '--mode=skip-build',
    ])
  })
})

describe('execArgs', () => {
  it('passes RepoLens words through and only plain repository names', () => {
    expect(execArgs(['docker', 'compose', '-f', { arg: 'deploy/compose.yaml' }, 'up'])).toEqual([
      'docker',
      'compose',
      '-f',
      'deploy/compose.yaml',
      'up',
    ])
    for (const unsafe of ['-d', '--rm', 'db;reboot', '$(touch x)', 'a b', 'x\ny', '']) {
      expect(execArgs(['docker', { arg: unsafe }])).toBeNull()
    }
  })
})
