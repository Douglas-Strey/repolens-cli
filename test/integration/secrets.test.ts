/**
 * End-to-end secret handling: every output format, every fixture, plus a
 * project full of realistic credentials built at runtime (never committed).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyFixture, FIXTURES_DIR, gitInit, makeProject, runCli, SECRET_SENTINEL } from '../helpers.ts'

const FORMATS: string[][] = [
  [],
  ['--verbose'],
  ['--json'],
  ['--json', '--verbose'],
  ['--markdown', '--verbose'],
  ['doctor'],
  ['doctor', '--verbose'],
  ['doctor', '--json'],
  ['report', '--verbose'],
  ['agent'],
]

const fixtures = (await fs.readdir(FIXTURES_DIR, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

/** Run every output format (plus `agent init`) and return everything RepoLens printed or wrote. */
async function everyOutput(dir: string): Promise<string[]> {
  const outputs: string[] = []
  for (const argv of FORMATS) {
    const plain = await runCli([...argv, dir])
    outputs.push(plain.stdout, plain.stderr)
  }
  const colored = await runCli(['--verbose', dir], { env: { FORCE_COLOR: '1' } })
  outputs.push(colored.stdout, colored.stderr)

  const agentDir = path.join(dir, '.repolens-test-output')
  const init = await runCli(['agent', 'init', '.', '--output', '.repolens-test-output'], { cwd: dir })
  outputs.push(init.stdout, init.stderr)
  for (const file of await fs.readdir(agentDir)) {
    outputs.push(await fs.readFile(path.join(agentDir, file), 'utf8'))
  }
  await fs.rm(agentDir, { recursive: true, force: true })
  return outputs
}

describe('fixture secrets never reach any output', () => {
  it.each(fixtures)('%s', async (fixture) => {
    const dir = await copyFixture(fixture)
    gitInit(dir)
    const outputs = await everyOutput(dir)
    for (const output of outputs) {
      expect(output).not.toContain(SECRET_SENTINEL)
      // No absolute paths either: the scanned directory is only ever shown by name.
      expect(output).not.toContain(dir)
    }
  })
})

describe('realistic credentials never reach any output', () => {
  // Built at runtime so no credential-shaped string is ever committed.
  const secrets = {
    stripe: `sk_${'live'}_${'4eC39HqLyjWDarjtT1zdp7dc'}`,
    github: `ghp_${'R8x'.repeat(12)}`,
    aws: `AKIA${'IOSFODNN7EXAMPLE'}`,
    npm: `npm_${'a1B2c3D4'.repeat(4)}abcd`,
    dbPassword: 'correct-horse-battery-staple-42',
    composeDefault: 'hunter2-compose-default-pw',
    dockerArg: 'dockerfile-arg-secret-value-77',
    ciInline: 'ci-inline-secret-value-99',
    remoteToken: `ghp_${'Z9q'.repeat(12)}`,
    scriptToken: 'script-inline-token-value-55',
    dependencyToken: `ghp_${'Dep'.repeat(12)}`,
  }

  it('in env files, example files, scripts, dependencies, Compose, Dockerfiles, CI and Git remotes', async () => {
    const dir = await makeProject({
      'package.json': JSON.stringify(
        {
          name: 'leaky',
          private: true,
          packageManager: 'pnpm@10.17.1',
          scripts: {
            dev: 'vite',
            deploy: `API_TOKEN=${secrets.scriptToken} node deploy.js`,
            migrate: `DATABASE_URL=postgres://app:${secrets.dbPassword}@localhost:5432/app prisma migrate deploy`,
            publish: `npm publish --token ${secrets.npm}`,
          },
          dependencies: {
            vite: '^7.1.0',
            'private-lib': `git+https://oauth2:${secrets.dependencyToken}@github.com/acme/private-lib.git`,
          },
        },
        null,
        2,
      ),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      '.env': [
        `STRIPE_SECRET_KEY=${secrets.stripe}`,
        `GITHUB_TOKEN=${secrets.github}`,
        `DATABASE_URL=postgres://app:${secrets.dbPassword}@localhost:5432/app`,
        `AWS_ACCESS_KEY_ID=${secrets.aws}`,
      ].join('\n'),
      '.env.example': [`AWS_ACCESS_KEY_ID=${secrets.aws}`, 'DATABASE_URL=', 'STRIPE_SECRET_KEY='].join('\n'),
      '.npmrc': `//registry.npmjs.org/:_authToken=${secrets.npm}\n`,
      'docker-compose.yml': [
        'services:',
        '  db:',
        '    image: postgres:17',
        '    ports: ["5432:5432"]',
        '    environment:',
        `      POSTGRES_PASSWORD: ${secrets.dbPassword}`,
        `      FALLBACK: \${DB_PASSWORD:-${secrets.composeDefault}}`,
        '  api:',
        '    build: .',
        '    environment:',
        `      - STRIPE_SECRET_KEY=${secrets.stripe}`,
      ].join('\n'),
      Dockerfile: [
        'FROM node:22-alpine',
        `ARG NPM_TOKEN=${secrets.dockerArg}`,
        `ENV SECRET_KEY=${secrets.dockerArg}`,
        'EXPOSE 3000',
      ].join('\n'),
      '.github/workflows/ci.yml': [
        'on: [push]',
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    env:',
        `      DEPLOY_TOKEN: ${secrets.ciInline}`,
        '    steps:',
        `      - run: curl -H "Authorization: Bearer ${secrets.ciInline}" https://deploy.invalid`,
        '      - run: pnpm test',
      ].join('\n'),
      'src/main.ts': [
        'const key = process.env.STRIPE_SECRET_KEY',
        'const token = process.env.GITHUB_TOKEN',
        'export const url = process.env.DATABASE_URL ?? ""',
        'console.log(key, token, import.meta.env.VITE_PUBLIC_THING)',
      ].join('\n'),
    })
    gitInit(dir)
    execFileSync(
      'git',
      ['remote', 'add', 'origin', `https://x-access-token:${secrets.remoteToken}@github.com/acme/leaky.git`],
      { cwd: dir, stdio: 'ignore' },
    )

    const outputs = await everyOutput(dir)
    const everything = outputs.join('\n')
    for (const [name, value] of Object.entries(secrets)) {
      expect(everything, `${name} leaked`).not.toContain(value)
    }
    // The detections themselves still work.
    const json = JSON.parse((await runCli(['--json', dir])).stdout)
    expect(json.environment.variables.map((v: { name: string }) => v.name)).toContain('STRIPE_SECRET_KEY')
    expect(json.git.remotes[0].url).toBe('https://github.com/acme/leaky.git')
    const doctor = JSON.parse((await runCli(['doctor', '--json', dir])).stdout)
    const codes = doctor.diagnostics.map((d: { code: string }) => d.code)
    expect(codes).toContain('ENV_EXAMPLE_REAL_SECRET')
    expect(codes).toContain('TRACKED_ENV_FILE')
  })
})
