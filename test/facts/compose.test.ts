// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose ${VAR} interpolation is the syntax under test
import { describe, expect, it } from 'vitest'
import {
  composeFileRole,
  composeFiles,
  composeProjectOf,
  envFileReferences,
  findComposeFiles,
} from '../../src/facts/compose.ts'
import { contextFor, makeProject, SECRET_SENTINEL } from '../helpers.ts'

describe('Compose file discovery', () => {
  it('classifies names and groups base and override files into one project', () => {
    expect(composeFileRole('compose.yaml')).toBe('base')
    expect(composeFileRole('docker/docker-compose.override.yml')).toBe('override')
    expect(composeFileRole('compose.prod.yaml')).toBe('variant')
    expect(composeFileRole('my-compose.yml')).toBeNull()
    expect(composeProjectOf('compose.yaml')).toBe(composeProjectOf('docker-compose.override.yml'))
    expect(composeProjectOf('compose.prod.yaml')).not.toBe(composeProjectOf('compose.yaml'))
    expect(composeProjectOf('docker/compose.yaml')).not.toBe(composeProjectOf('compose.yaml'))
  })

  it('skips tests, fixtures, examples, templates and playgrounds, and limits depth', () => {
    expect(
      findComposeFiles([
        'compose.prod.yaml',
        'compose.yaml',
        'deploy/local/docker-compose.yml',
        'deep/er/than/two/compose.yaml',
        'examples/demo/compose.yaml',
        'templates/app/compose.yaml',
        'test/fixtures/app/compose.yaml',
        'playground/compose.yaml',
        'e2e/compose.yaml',
      ]),
    ).toEqual(['compose.yaml', 'compose.prod.yaml', 'deploy/local/docker-compose.yml'])
  })
})

describe('envFileReferences', () => {
  it('resolves entries relative to the Compose file and records whether they are required', () => {
    const doc = {
      services: {
        api: { env_file: '.env' },
        web: { env_file: ['./web.env', { path: 'optional.env', required: false }, { path: 'required.env' }] },
        bad: { env_file: ['${ENV_FILE}', '/etc/app.env', 'C:\\app.env', '~/home.env', 42, null] },
        up: { env_file: '../shared.env' },
        weird: 'not a mapping',
      },
    }
    expect(envFileReferences('deploy/compose.yaml', doc)).toEqual([
      { composeFile: 'deploy/compose.yaml', service: 'api', path: 'deploy/.env', required: true },
      { composeFile: 'deploy/compose.yaml', service: 'web', path: 'deploy/web.env', required: true },
      { composeFile: 'deploy/compose.yaml', service: 'web', path: 'deploy/optional.env', required: false },
      { composeFile: 'deploy/compose.yaml', service: 'web', path: 'deploy/required.env', required: true },
      { composeFile: 'deploy/compose.yaml', service: 'up', path: 'shared.env', required: true },
    ])
    // From the root, "../" leaves the project.
    expect(envFileReferences('compose.yaml', { services: { up: { env_file: '../shared.env' } } })).toEqual([])
    expect(envFileReferences('compose.yaml', 'nope')).toEqual([])
  })
})

describe('composeFiles fact', () => {
  it('parses every project Compose file once and records parse failures as warnings', async () => {
    const ctx = await contextFor(
      await makeProject({
        'compose.yaml': 'services:\n  db:\n    image: postgres:17\n    env_file: [.env.db]\n',
        'docker/compose.yml': `services:\n  app: [\n    ${SECRET_SENTINEL}\n`,
        'examples/demo/compose.yaml': 'services:\n  demo:\n    env_file: demo.env\n',
      }),
    )
    const found = await ctx.use(composeFiles)
    expect(found.files.map((file) => [file.path, file.role, file.doc === null])).toEqual([
      ['compose.yaml', 'base', false],
      ['docker/compose.yml', 'base', true],
    ])
    expect(found.envFiles).toEqual([{ composeFile: 'compose.yaml', service: 'db', path: '.env.db', required: true }])
    expect(ctx.warnings).toEqual([expect.objectContaining({ kind: 'parse', file: 'docker/compose.yml' })])
    expect(JSON.stringify(ctx.warnings)).not.toContain(SECRET_SENTINEL)
    expect(await ctx.use(composeFiles)).toBe(found)
  })
})
